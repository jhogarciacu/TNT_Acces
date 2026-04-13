const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

// -----------------------------------------------------
// 1. MQTT Setup (HiveMQ / External Broker)
// -----------------------------------------------------
const mqttClient = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com', {
  username: process.env.MQTT_USERNAME || '',
  password: process.env.MQTT_PASSWORD || '',
  clientId: process.env.MQTT_CLIENT_ID || 'backend_api_' + Math.random().toString(16).substr(2, 8),
});

mqttClient.on('error', (err) => {
  console.error('💥 MQTT Connection Error:', err);
});

mqttClient.on('connect', () => {
  console.log('✅ Connected to MQTT broker');
  mqttClient.subscribe('gimnasio/acceso', (err) => err && console.error('MQTT Subscribe Error:', err));
  mqttClient.subscribe('gimnasio/estado', (err) => err && console.error('MQTT Subscribe Error:', err));
  mqttClient.subscribe('gimnasio/enrolamiento', (err) => err && console.error('MQTT Subscribe Error:', err));
});

// -----------------------------------------------------
// 2. MQTT Event Processing (Access Decision Engine)
// -----------------------------------------------------
mqttClient.on('message', async (topic, message) => {
  try {
    const payload = JSON.parse(message.toString());

    if (topic === 'gimnasio/estado') {
      if (payload.online !== undefined) {
        // HEARTBEAT
        await prisma.dispositivo.upsert({
          where: { id: payload.dispositivo },
          update: { estado: payload.online ? 'online' : 'offline', ultimo_ping: new Date() },
          create: { id: payload.dispositivo, nombre: payload.dispositivo, estado: payload.online ? 'online' : 'offline' }
        });
        console.log(`Device state updated: ${payload.dispositivo} -> ${payload.online}`);
        io.emit('device_status', payload);
      } else if (payload.estado === 'esperando_dedo') {
        // ENROLLMENT PROGRESS: {"estado":"esperando_dedo", "lectura":1, ...}
        io.emit('enroll_progress', payload);
      } else if (payload.cmd_ejecutado === 'abrir') {
        console.log(`Dispositivo ${payload.dispositivo} abrió la puerta`);
      }

    } else if (topic === 'gimnasio/acceso') {
      // INTERCEPT ENROLLMENT RESULTS FROM THIS TOPIC
      if (['enrolado', 'timeout', 'error_coincidencia', 'error_guardado', 'memoria_llena'].includes(payload.resultado)) {
        console.log(`Enrollment result received:`, payload);
        io.emit('enroll_result', {
          resultado: payload.resultado === 'enrolado' ? 'exito' : payload.resultado,
          huella_id: payload.huella_id
        });
        return; // Don't log this as a normal access event
      }

      // NORMAL ACCESS EVENT: { resultado: "permitido"|"denegado", huella_id: 1, confianza: 186, dispositivo: "esp32c6..." }
      let finalResult = 'denegado';
      let member = null;

      if (payload.huella_id !== undefined && payload.huella_id !== null) {
        member = await prisma.miembro.findUnique({ where: { huella_id: payload.huella_id } });

        if (member) {
          const now = new Date();
          const endDate = new Date(member.membership_end_date);
          const gracePeriodEnd = new Date(endDate);
          gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 2); // 2 days grace

          if (now <= endDate) {
            finalResult = 'permitido';
          } else if (now <= gracePeriodEnd) {
            finalResult = 'permitido_gracia';
          } else {
            finalResult = 'denegado_vencido';
          }
        }
      }

      // If vencido or denegado, tell ESP32 NOT to open the relay
      if (finalResult === 'denegado_vencido' || finalResult === 'denegado') {
        // The ESP32 already opened because it found the fingerprint locally.
        // We log it but the access control logic on ESP side should check server response.
        // For now we just log and notify dashboard.
      }


      // Save log to DB
      const dbDevice = await prisma.dispositivo.findUnique({ where: { id: payload.dispositivo } });
      if (!dbDevice) {
        await prisma.dispositivo.create({ data: { id: payload.dispositivo, nombre: payload.dispositivo, estado: 'online' } });
      }

      const log = await prisma.acceso.create({
        data: {
          miembro_id: member?.id || undefined,
          resultado: finalResult,
          confianza: payload.confianza || 0,
          dispositivo_id: payload.dispositivo
        },
        include: { miembro: true }
      });

      // Send via WebSockets to dashboard
      console.log(`Access log created:`, log.miembro?.nombre || 'Unknown', finalResult);
      io.emit('access_event', log);

    } else if (topic === 'gimnasio/enrolamiento') {
      // Falback: Just in case they use the old topic
      console.log(`Enrollment event received on old topic:`, payload);
      io.emit('enroll_result', payload);
    }
  } catch (error) {
    console.error('Error processing MQTT message:', error);
  }
});

// -----------------------------------------------------
// 3. REST API Routes
// -----------------------------------------------------

// Get Dashboard Stats
app.get('/api/stats', async (req, res) => {
  try {
    const todayStart = new Date(new Date().setHours(0,0,0,0));
    const totalAccesses = await prisma.acceso.count({
      where: { timestamp: { gte: todayStart } }
    });
    const failedAccesses = await prisma.acceso.count({
      where: { resultado: { in: ['denegado', 'denegado_vencido'] }, timestamp: { gte: todayStart } }
    });
    
    const allMembers = await prisma.miembro.findMany();
    let active = 0, grace = 0, expired = 0;
    const now = new Date();
    
    allMembers.forEach(m => {
      const ms = new Date(m.membership_end_date);
      const gw = new Date(ms); gw.setDate(gw.getDate() + 2);
      if (now <= ms) active++;
      else if (now <= gw) grace++;
      else expired++;
    });

    // Histogram: accesses grouped by hour today
    const todayAccesses = await prisma.acceso.findMany({
      where: { timestamp: { gte: todayStart } },
      select: { timestamp: true }
    });
    const histogram = Array(24).fill(0);
    todayAccesses.forEach(a => {
      const hour = new Date(a.timestamp).getHours();
      histogram[hour]++;
    });

    // Weekly histogram: last 7 days
    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - 6);
    weekStart.setHours(0,0,0,0);
    const weekAccesses = await prisma.acceso.findMany({
      where: { timestamp: { gte: weekStart } },
      select: { timestamp: true }
    });
    const weekDays = ['Dom','Lun','Mar','Mié','Jue','Vie','Sáb'];
    const weekly = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      d.setHours(0,0,0,0);
      const nextD = new Date(d);
      nextD.setDate(nextD.getDate() + 1);
      const count = weekAccesses.filter(a => {
        const t = new Date(a.timestamp);
        return t >= d && t < nextD;
      }).length;
      weekly.push({
        day: weekDays[d.getDay()],
        date: d.toLocaleDateString('es-CO', { day: 'numeric', month: 'short' }),
        count
      });
    }

    res.json({ totalAccesses, failedAccesses, active, grace, expired, histogram, weekly });
  } catch(error) { res.status(500).json({error: error.message}); }
});

// Send Remote Open Command
app.post('/api/devices/:id/open', (req, res) => {
  const { id } = req.params;
  mqttClient.publish('gimnasio/comando', JSON.stringify({ comando: 'abrir', dispositivo: id }));
  res.json({ success: true, message: 'Open command sent!' });
});

// Members CRUD...
app.get('/api/members', async (req, res) => {
  const members = await prisma.miembro.findMany({ include: { plan: true } });
  res.json(members);
});

// Admin Login
app.post('/api/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await prisma.admin.findUnique({ where: { username } });
  if (!admin || admin.password !== password) {
    if (username === 'centro' && password === '12345678') {
      return res.json({ success: true, token: 'mock-jwt-token-admin' });
    }
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  res.json({ success: true, token: 'mock-jwt-token-admin' });
});

// Create Member
app.post('/api/members', async (req, res) => {
  try {
    const { cedula, nombre, telefono, huella_id, basePlanDays } = req.body;
    let end_date = new Date();
    end_date.setDate(end_date.getDate() + (parseInt(basePlanDays) || 30));

    const nuevoMiembro = await prisma.miembro.create({
      data: {
        cedula,
        nombre,
        telefono,
        huella_id: parseInt(huella_id),
        estado: 'activo',
        membership_end_date: end_date
      }
    });
    res.json({ success: true, member: nuevoMiembro });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Send Remote Enroll Command
app.post('/api/devices/:id/enroll', (req, res) => {
  const { id } = req.params;
  mqttClient.publish('gimnasio/comando', JSON.stringify({ cmd: 'enrolar', dispositivo: id }));
  res.json({ success: true, message: 'Comando enrolar enviado!' });
});

// Renew Membership (1 month + 2 days grace)
app.post('/api/members/:id/renew', async (req, res) => {
  try {
    const { id } = req.params;
    const member = await prisma.miembro.findUnique({ where: { id: parseInt(id) } });
    if(!member) return res.status(404).json({error: "Miembro no encontrado"});
    
    // Start from today always when renewing
    let newEnd = new Date();
    newEnd.setMonth(newEnd.getMonth() + 1); // +1 month
    newEnd.setDate(newEnd.getDate() + 2);   // +2 days grace

    const updated = await prisma.miembro.update({
      where: { id: parseInt(id) },
      data: { 
        membership_end_date: newEnd, 
        membership_start_date: new Date(),
        estado: 'activo' 
      }
    });
    res.json(updated);
  } catch(error) { res.status(500).json({error: error.message}); }
});

// Delete Member (archive + notify ESP32 + recycle ID)
app.delete('/api/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const member = await prisma.miembro.findUnique({ where: { id: parseInt(id) } });
    if (!member) return res.status(404).json({ error: 'Miembro no encontrado' });

    // 1. Archive deleted member
    await prisma.miembroEliminado.create({
      data: {
        cedula: member.cedula,
        nombre: member.nombre,
        huella_id: member.huella_id,
        telefono: member.telefono,
        fecha_registro: member.membership_start_date,
      }
    });

    // 2. Free the huella_id for reuse
    await prisma.huellaDisponible.create({
      data: { huella_id: member.huella_id }
    });

    // 3. Send MQTT command to ESP32 to delete the fingerprint from sensor
    mqttClient.publish('gimnasio/comando', JSON.stringify({
      cmd: 'borrar',
      huella_id: member.huella_id
    }));
    console.log(`MQTT: Sent delete command for huella_id ${member.huella_id}`);

    // 4. Delete access logs and member from DB
    await prisma.acceso.deleteMany({ where: { miembro_id: parseInt(id) } });
    await prisma.miembro.delete({ where: { id: parseInt(id) } });

    res.json({ success: true, message: 'Miembro eliminado', huella_id: member.huella_id });
  } catch(error) { res.status(500).json({error: error.message}); }
});

// Get next available huella_id (recycled first, then new)
app.get('/api/next-huella-id', async (req, res) => {
  try {
    // Check if there are recycled IDs available
    const recycled = await prisma.huellaDisponible.findFirst({ orderBy: { huella_id: 'asc' } });
    if (recycled) {
      res.json({ huella_id: recycled.huella_id, recycled: true });
    } else {
      // Get max huella_id currently in use
      const maxMember = await prisma.miembro.findFirst({ orderBy: { huella_id: 'desc' } });
      const nextId = (maxMember?.huella_id || 0) + 1;
      res.json({ huella_id: nextId, recycled: false });
    }
  } catch(error) { res.status(500).json({error: error.message}); }
});

// Consume a recycled huella_id after successful enrollment
app.delete('/api/free-huella/:huellaId', async (req, res) => {
  try {
    const huellaId = parseInt(req.params.huellaId);
    await prisma.huellaDisponible.deleteMany({ where: { huella_id: huellaId } });
    res.json({ success: true });
  } catch(error) { res.status(500).json({error: error.message}); }
});


const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Backend running on http://localhost:${PORT}`);
});
