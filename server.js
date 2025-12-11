const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const app = express();
const port = 80;

// MySQL接続
const db = mysql.createConnection({
    host: '10.0.2.5',//DB_SERVER_PRIVATE_IP
    user: 'node_user',//YOUR_USER
    password: 'Group-02',//YOUR_PASSWORD
    database: 'elevator_db'
});
db.connect((err) => {
    if (err) {
        console.error('MySQL接続失敗:', err.message);
    } else {
        console.log('MySQL接続成功');
    }
});

// MQTT接続
const mqttClient = mqtt.connect('mqtt://127.0.0.1:1883');

// API例
app.get('/api/congestion', (req, res) => {
    db.query('SELECT * FROM congestion_logs ORDER BY measured_at DESC LIMIT 10', (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// Web画面
app.use(express.static('web'));


// MQTTサブスクライブ
mqttClient.on('connect', () => {
    console.log('Connected to MQTT broker');
    mqttClient.subscribe(['elevator/congestion', 'elevator/environment', 'elevator/accident'], (err) => {
        if (err) {
            console.error('MQTT subscribe error:', err);
        } else {
            console.log('Subscribed to elevator topics');
        }
    });
});

// MQTTメッセージ受信
mqttClient.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        if (topic === 'elevator/congestion') {
            //混雑度を受信
            // { device_id, congestion_level, measured_at }
            db.query(
                'INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES (?, ?, ?)',
                [data.device_id, data.congestion_level, data.measured_at || new Date()],
                (err) => { if (err) console.error('DB insert error (congestion):', err); }
            );
        } else if (topic === 'elevator/environment') {
            //環境データを受信
            // { device_id, co2_ppm, temperature, humidity, measured_at }
            db.query(
                'INSERT INTO environment_logs (device_id, co2_ppm, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.co2_ppm, data.temperature, data.humidity, data.measured_at || new Date()],
                (err) => { if (err) console.error('DB insert error (environment):', err); }
            );
        } else if (topic === 'elevator/accident') {
            //事故データを受信
            // { device_id, accident_type, occurred_at }
            db.query(
                'INSERT INTO accident_logs (device_id, accident_type, occurred_at) VALUES (?, ?, ?)',
                [data.device_id, data.accident_type, data.occurred_at || new Date()],
                (err) => { if (err) console.error('DB insert error (accident):', err); }
            );
        }
    } catch (e) {
        console.error('MQTT message parse error:', e);
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
