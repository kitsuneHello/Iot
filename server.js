const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const app = express();
const port = 3000;

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

// 最新の混雑度（各階）
app.get('/api/congestion/latest', (req, res) => {
    db.query(`SELECT floor_number, congestion_level, measured_at
        FROM (
          SELECT
            d.floor_number,
            c.congestion_level,
            c.measured_at,
            ROW_NUMBER() OVER (PARTITION BY c.device_id ORDER BY c.measured_at DESC) as rn
          FROM congestion_logs c
          JOIN devices d ON c.device_id = d.device_id
          WHERE d.location_type = 'HALL'
        ) t
        WHERE t.rn = 1
        ORDER BY floor_number`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新のエレベーター環境
app.get('/api/environment/latest', (req, res) => {
    db.query(`SELECT device_id, pressure, temperature, humidity, measured_at FROM environment_logs
        WHERE measured_at = (SELECT MAX(measured_at) FROM environment_logs WHERE device_id = environment_logs.device_id)
        ORDER BY device_id`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新の混雑RTT指標（削除: elevator_tripsテーブルがないため）
// app.get('/api/rtt/latest', ... ) を削除
app.get('/api/rtt/latest', (req, res) => {
    res.json({ value: null });
});

// 過去データ（混雑度・環境・事故のみ）
app.get('/api/history', (req, res) => {
    let { range, date, page = 1 } = req.query;
    page = parseInt(page) || 1;
    const pageSize = 30;
    let where = '';
    let params = [];
    if (range && date) {
        if (range === 'day') {
            where = 'WHERE DATE(measured_at) = ?';
            params.push(date);
        } else if (range === 'week') {
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
        } else if (range === 'month') {
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
        }
    }
    // 各テーブルごとにLIMITをかけてUNION ALL（サブクエリ化）
    const congestionSql = `(SELECT d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, DATE_FORMAT(c.measured_at, '%Y-%m-%d %H:00:00') AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at, NULL AS is_resolved FROM congestion_logs c JOIN devices d ON c.device_id = d.device_id ${where} GROUP BY c.device_id, measured_at ORDER BY measured_at DESC LIMIT ${pageSize})`;
    const envSql = `(SELECT NULL AS floor_number, e.device_id, NULL AS congestion_level, e.measured_at, e.pressure, e.temperature, e.humidity, NULL AS accident_type, NULL AS occurred_at, NULL AS is_resolved FROM environment_logs e ${where} ORDER BY e.measured_at DESC LIMIT ${pageSize})`;
    // RTT部分を削除
    // const rttSql = ...;
    const accidentSql = `(SELECT NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at, a.is_resolved FROM accident_logs a ${where.replace(/measured_at/g, 'occurred_at')} ORDER BY a.occurred_at DESC LIMIT ${pageSize})`;
    // 合成
    const unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql}`;
    db.query(unionSql, [...params, ...params, ...params], (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ data: results, totalPages: 1 });
    });
});

// Web画面
app.use(express.static('web'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/web/home.html');
});


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
            // { device_id, pressure, temperature, humidity, measured_at }
            db.query(
                'INSERT INTO environment_logs (device_id, pressure, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.pressure, data.temperature, data.humidity, data.measured_at || new Date()],
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
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});
