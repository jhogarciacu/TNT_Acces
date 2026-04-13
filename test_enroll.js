const mqtt = require('mqtt');

const client = mqtt.connect('mqtt://broker.hivemq.com');

client.on('connect', () => {
    console.log("Connected to HiveMQ");
    const payload = JSON.stringify({
        resultado: "exito",
        huella_id: 88,
        dispositivo: "esp32c6_torniquete"
    });
    client.publish('gimnasio/enrolamiento', payload, () => {
        console.log("Mock enrollment event published:", payload);
        client.end();
    });
});
