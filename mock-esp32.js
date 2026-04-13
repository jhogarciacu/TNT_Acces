const mqtt = require('mqtt');
require('dotenv').config();

const client = mqtt.connect(process.env.MQTT_BROKER_URL || 'mqtt://broker.hivemq.com', {
  username: process.env.MQTT_USERNAME || '',
  password: process.env.MQTT_PASSWORD || ''
});

client.on('connect', () => {
  console.log('🔗 Connected to MQTT as Mock ESP32');
  
  // 1. Send Heartbeat
  setInterval(() => {
    const payload = JSON.stringify({ online: true, dispositivo: 'esp32c6_gimnasio_01' });
    client.publish('gimnasio/estado', payload);
    console.log('💓 Heartbeat sent');
  }, 10000);

  // 2. Listen for Remote Commands
  client.subscribe('gimnasio/comando');
  
  // 3. Send a Mock Fingerprint Event every 15 seconds
  setInterval(() => {
    // Randomize member ID between 1 and 3
    const userId = Math.floor(Math.random() * 3) + 1;
    const payload = JSON.stringify({
      resultado: 'escaneado', // The backend will process this to "permitido" or "denegado"
      huella_id: userId,
      confianza: Math.floor(Math.random() * 50) + 150,
      dispositivo: 'esp32c6_gimnasio_01'
    });
    client.publish('gimnasio/acceso', payload);
    console.log('👆 Fingerprint access simulated for ID:', userId);
  }, 15000);
});

client.on('message', (topic, message) => {
  if (topic === 'gimnasio/comando') {
    const data = JSON.parse(message.toString());
    if (data.comando === 'abrir' && data.dispositivo === 'esp32c6_gimnasio_01') {
      console.log('🚪 OPEN DOOR COMMAND RECEIVED! Triggering Relay...');
    }
  }
});
