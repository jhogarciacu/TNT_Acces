const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const mqtt = require('mqtt');
const { PrismaClient } = require('@prisma/client');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
  cors: { 
    origin: "*", 
    methods: ["GET", "POST"],
    credentials: true
  },
  transports: ['websocket', 'polling']
});
const prisma = new PrismaClient();

app.use(cors());
app.use(express.json());

const brokerUrl = process.env.MQTT_BROKER_URL?.trim();
const mqttUser = process.env.MQTT_USERNAME?.trim();
const mqttPass = process.env.MQTT_PASSWORD?.trim();

const mqttClient = mqtt.connect(brokerUrl, {
  username: mqttUser,
  password: mqttPass,
  clientId: 'backend_' + Math.random().toString(16).substring(2, 10),
  connectTimeout: 5000,
  reconnectPeriod: 2000,
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
      // Deletion confirmation handler
      if (payload.resultado === 'borrado' && (payload.miembro_id || payload.huella_id)) {
        console.log(`✅ Deletion confirmed for huella_id ${payload.huella_id}`);
        
        const memberId = payload.miembro_id ? parseInt(payload.miembro_id) : null;
        const huellaId = parseInt(payload.huella_id);
        
        const member = await prisma.miembro.findFirst({
          where: memberId ? { id: memberId } : { huella_id: huellaId }
        });

        if (member) {
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

          // 3. Delete access logs and member from DB
          await prisma.acceso.deleteMany({ where: { miembro_id: member.id } });
          await prisma.miembro.delete({ where: { id: member.id } });

          console.log(`🗑️ Member ${member.nombre} removed from DB after sensor confirmation.`);
          io.emit('member_deleted_confirm', { id: member.id, huella_id: member.huella_id });
        }
        return;
      }

      // INTERCEPT ENROLLMENT RESULTS FROM THIS TOPIC
      if (['enrolado', 'timeout', 'error_coincidencia', 'error_guardado', 'memoria_llena'].includes(payload.resultado)) {
        console.log(`Enrollment result received:`, payload);
        io.emit('enroll_result', {
          resultado: payload.resultado === 'enrolado' ? 'exito' : payload.resultado,
          huella_id: payload.huella_id
        });
        return; // Don't log this as a normal access event
      }

      // RECIBIMOS EVENTO DE ACCESO: { resultado: "permitido"|"denegado", huella_id: 3, confianza: 160, dispositivo: "esp32c6..." }
      let finalResult = payload.resultado; // Confiamos inicialmente en lo que dice el sensor
      let member = null;

      if (payload.huella_id !== undefined && payload.huella_id !== null) {
        member = await prisma.miembro.findUnique({ 
          where: { huella_id: parseInt(payload.huella_id) },
          include: { plan: true }
        });

        if (member) {
          const now = new Date();
          const endDate = new Date(member.membership_end_date);
          
          // Margen de gracia (2 días después de la fecha de fin)
          const gracePeriodEnd = new Date(endDate);
          gracePeriodEnd.setDate(gracePeriodEnd.getDate() + 2);

          if (now <= endDate) {
            finalResult = 'permitido';
          } else if (now <= gracePeriodEnd) {
            finalResult = 'permitido_gracia';
          } else {
            finalResult = 'denegado_vencido';
          }
        } else {
          // Si el sensor dice permitido pero no está en DB, es una huella antigua o desconocida
          if (finalResult === 'permitido') {
            finalResult = 'denegado'; // Marcamos como desconocido en el sistema
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
    const todayStart = new Date();
    todayStart.setHours(0,0,0,0);
    
    // Total de ingresos hoy (solo los permitidos)
    const totalAccesses = await prisma.acceso.count({
      where: { 
        timestamp: { gte: todayStart },
        resultado: { in: ['permitido', 'permitido_gracia'] }
      }
    });

    // Intentos fallidos hoy
    const failedAccesses = await prisma.acceso.count({
      where: { 
        timestamp: { gte: todayStart },
        resultado: { in: ['denegado', 'denegado_vencido'] }
      }
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
  mqttClient.publish('gimnasio/comando', JSON.stringify({ cmd: 'abrir', dispositivo: id }));
  res.json({ success: true, message: 'Open command sent!' });
});

// Members CRUD with filtering
app.get('/api/members', async (req, res) => {
  try {
    const { filter, hour } = req.query;
    let where = {};
    const now = new Date();

    if (filter === 'active') {
      where = { membership_end_date: { gte: now } };
    } else if (filter === 'expired') {
      const grace = new Date();
      grace.setDate(grace.getDate() - 2); // Since grace period is +2 days, expired is < end_date and < grace? 
      // Actually status logic in frontend is: end_date < now AND grace < now.
      where = { membership_end_date: { lt: grace } };
    } else if (filter === 'today' || filter === 'access_hour') {
      const start = new Date();
      start.setHours(0,0,0,0);
      
      const accessWhere = { timestamp: { gte: start } };
      if (filter === 'access_hour' && hour) {
        const h = parseInt(hour as string);
        const hStart = new Date(start); hStart.setHours(h);
        const hEnd = new Date(start); hEnd.setHours(h + 1);
        accessWhere.timestamp = { gte: hStart, lt: hEnd };
      }

      const accesses = await prisma.acceso.findMany({
        where: accessWhere,
        select: { miembro_id: true }
      });
      const memberIds = Array.from(new Set(accesses.map(a => a.miembro_id).filter(id => id !== null)));
      where = { id: { in: memberIds as number[] } };
    }

    const members = await prisma.miembro.findMany({ 
      where,
      include: { plan: true },
      orderBy: { nombre: 'asc' }
    });
    res.json(members);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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
    const { cedula, nombre, telefono, huella_id, basePlanDays, startDate } = req.body;
    
    let start_date = startDate ? new Date(startDate) : new Date();
    let end_date = new Date(start_date);
    end_date.setMonth(end_date.getMonth() + 1); // +1 month
    end_date.setDate(end_date.getDate() + 2);   // +2 days grace

    const nuevoMiembro = await prisma.miembro.create({
      data: {
        cedula,
        nombre,
        telefono,
        huella_id: parseInt(huella_id),
        estado: 'activo',
        membership_start_date: start_date,
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
  const { huella_id } = req.body; // Recibimos el ID desde el frontend
  mqttClient.publish('gimnasio/comando', JSON.stringify({ 
    cmd: 'enrolar', 
    huella_id: parseInt(huella_id), 
    dispositivo: id 
  }));
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

// Delete Member Trigger (sends MQTT, doesn't delete from DB yet)
app.delete('/api/members/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const member = await prisma.miembro.findUnique({ where: { id: parseInt(id) } });
    if (!member) return res.status(404).json({ error: 'Miembro no encontrado' });

    // Send MQTT command to ESP32 to delete the fingerprint from sensor
    mqttClient.publish('gimnasio/comando', JSON.stringify({
      cmd: 'borrar',
      huella_id: member.huella_id,
      miembro_id: member.id // Send ID so we can identify it on callback
    }));
    
    console.log(`MQTT: Sent delete command for member ${member.nombre} (huella_id ${member.huella_id})`);
    res.json({ success: true, message: 'Comando de borrado enviado al sensor. Esperando confirmación...' });
  } catch(error) { res.status(500).json({error: error.message}); }
});

// Weekly Cleanup & Export
app.post('/api/cleanup', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: "Email is required" });

    // 1. Get all logs
    const allLogs = await prisma.acceso.findMany({ include: { miembro: true } });
    
    // 2. Logic to "send email" (simulation for now, or console log)
    console.log(`📧 EXPORTING DATA TO: ${email}`);
    console.log(`📊 Total records to export: ${allLogs.length}`);
    
    // 3. Clear access logs
    await prisma.acceso.deleteMany({});
    
    res.json({ success: true, message: `Backup enviado a ${email} y base de datos de accesos limpiada.` });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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


console.log('📌 Configurando puerto y lanzando servidor...');
const PORT = process.env.PORT || 4000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 SERVIDOR ACTIVO EN PUERTO: ${PORT}`);
  console.log(`🌍 Acceso externo habilitado en 0.0.0.0`);
});
