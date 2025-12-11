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
    db.query(`SELECT device_id, co2_ppm, temperature, humidity, measured_at FROM environment_logs
        WHERE measured_at = (SELECT MAX(measured_at) FROM environment_logs WHERE device_id = environment_logs.device_id)
        ORDER BY device_id`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新の混雑RTT指標（例: 直近1タームの総和）
app.get('/api/rtt/latest', (req, res) => {
    db.query(`SELECT SUM(congestion_level) AS value FROM congestion_logs
        WHERE measured_at >= (SELECT MAX(start_time) FROM elevator_trips)
        AND measured_at <= (SELECT MAX(end_time) FROM elevator_trips)`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ value: results[0]?.value || 0 });
    });
});

// 過去データ（混雑度・環境・RTT・事故）
app.get('/api/history', (req, res) => {
    let { range, date, type = 'congestion', page = 1 } = req.query;
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
    let sql = '';
    if (type === 'congestion') {
        sql = `SELECT d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, DATE_FORMAT(c.measured_at, '%Y-%m-%d %H:00:00') AS measured_at
FROM congestion_logs c
JOIN devices d ON c.device_id = d.device_id
GROUP BY c.device_id, measured_at
ORDER BY measured_at DESC
LIMIT ? OFFSET ?`;
    } else if (type === 'environment') {
        sql = `SELECT e.device_id, e.co2_ppm, e.temperature, e.humidity, e.measured_at FROM environment_logs e ${where} ORDER BY e.measured_at DESC LIMIT ? OFFSET ?`;
    } else if (type === 'accident') {
        sql = `SELECT a.device_id, a.accident_type, a.occurred_at, a.is_resolved FROM accident_logs a ${where.replace(/measured_at/g, 'occurred_at')} ORDER BY a.occurred_at DESC LIMIT ? OFFSET ?`;
    }
    // 件数取得
    let countSql = '';
    if (type === 'congestion') {
        countSql = `SELECT COUNT(*) AS cnt FROM (SELECT 1 FROM congestion_logs c JOIN devices d ON c.device_id = d.device_id ${where} GROUP BY d.floor_number, c.device_id, DATE_FORMAT(c.measured_at, '%Y-%m-%d %H:00:00')) t`;
    } else if (type === 'environment') {
        countSql = `SELECT COUNT(*) AS cnt FROM environment_logs e ${where}`;
    } else if (type === 'accident') {
        countSql = `SELECT COUNT(*) AS cnt FROM accident_logs a ${where.replace(/measured_at/g, 'occurred_at')}`;
    }
    db.query(countSql, params, (err, countRes) => {
        if (err) return res.status(500).send('DB Error');
        const total = countRes[0].cnt;
        const totalPages = Math.ceil(total / pageSize);
        db.query(sql, [...params, pageSize, (page - 1) * pageSize], (err, results) => {
            if (err) return res.status(500).send('DB Error');
            res.json({ data: results, totalPages });
        });
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
