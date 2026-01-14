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


// API例
app.get('/api/congestion', (req, res) => {
    db.query('SELECT * FROM congestion_logs ORDER BY measured_at DESC', (err, results) => {
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

// 過去データ（混雑度・環境・事故のみ）
app.get('/api/history', (req, res) => {
    let { range, date, page = 1 } = req.query;
    page = parseInt(page) || 1;
    const pageSize = 30;
    let where = '';
    let params = [];
    let interval = 0;
    if (range && date) {
        if (range === 'day') {
            where = 'WHERE DATE(measured_at) = ?';
            params.push(date);
            interval = 0;
        } else if (range === 'week') {
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
            interval = 3600; // 1時間
        } else if (range === 'month') {
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
            interval = 300; // 5分
        } else if (range === 'all') {
            where = '';
            interval = 300; // 5分
        }
    }

    // 時間丸め用SQL
    /*
    日：平均化なし（全データ）
    週：5分ごと
    月：1時間ごと
    全期間：1日ごと
    */
    let timeGroup = 'measured_at';
    let groupBy = '';
    if (interval > 0) {
        timeGroup = `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(measured_at)/${interval})*${interval})`;
        groupBy = `GROUP BY c.device_id, FLOOR(UNIX_TIMESTAMP(measured_at)/${interval})`;
    } else {
        groupBy = 'GROUP BY c.device_id, measured_at';
    }

    const congestionSql = `(SELECT d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, ${interval > 0 ? `DATE_FORMAT(${timeGroup}, '%Y-%m-%d %H:%i:%s')` : 'c.measured_at'} AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at FROM congestion_logs c JOIN devices d ON c.device_id = d.device_id ${where} ${groupBy} ORDER BY measured_at DESC)`;
    const envSql = `(SELECT NULL AS floor_number, e.device_id, NULL AS congestion_level, ${interval > 0 ? `DATE_FORMAT(${timeGroup}, '%Y-%m-%d %H:%i:%s')` : 'e.measured_at'} AS measured_at, AVG(e.pressure) AS pressure, AVG(e.temperature) AS temperature, AVG(e.humidity) AS humidity, NULL AS accident_type, NULL AS occurred_at FROM environment_logs e ${where} ${interval > 0 ? `GROUP BY e.device_id, FLOOR(UNIX_TIMESTAMP(measured_at)/${interval})` : 'GROUP BY e.device_id, measured_at'} ORDER BY measured_at DESC)`;
    const accidentSql = `(SELECT NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at FROM accident_logs a ${where.replace(/measured_at/g, 'occurred_at')} ORDER BY a.occurred_at DESC)`;
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



// MQTT接続
const mqttClient = mqtt.connect('mqtt://localhost:1883');

// MQTT接続成功時の処理
mqttClient.on('connect', () => {
    console.log('Connected to Mosquitto');
    mqttClient.subscribe(['elevator/congestion', 'elevator/environment', 'elevator/accident']);
});

// MQTTメッセージ受信処理
mqttClient.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        // M5Stackから時刻が来なければ現在時刻を使う
        const timestamp = data.measured_at ? new Date(data.measured_at) : new Date();

        if (topic === 'elevator/congestion') {
            db.query('INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES (?, ?, ?)',
                [data.device_id, data.congestion_level, timestamp]);
        } 
        else if (topic === 'elevator/environment') {
            db.query('INSERT INTO environment_logs (device_id, pressure, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.pressure, data.temperature, data.humidity, timestamp]);
        } 
        else if (topic === 'elevator/accident') {
            db.query('INSERT INTO accident_logs (device_id, accident_type, occurred_at) VALUES (?, ?, ?)',
                [data.device_id, data.accident_type, timestamp]);
        }
    } catch (e) {
        console.error('MQTT Parse Error:', e);
    }
});


// MQTTメッセージ受信
mqttClient.on('message', (topic, message) => {
    console.log(`[DEBUG] Topic: ${topic}, Message: ${message.toString()}`);
    try {
        const data = JSON.parse(message.toString());
        const timestamp = data.measured_at ? new Date(data.measured_at) : new Date();
        if (topic === 'elevator/congestion') {
            //混雑度を受信
            // { device_id, congestion_level, measured_at }
            db.query(
                'INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES (?, ?, ?)',
                [data.device_id, data.congestion_level, data.measured_at || timestamp],
                (err) => { if (err) console.error('DB insert error (congestion):', err); }
            );
        } else if (topic === 'elevator/environment') {
            //環境データを受信
            // { device_id, pressure, temperature, humidity, measured_at }
            db.query(
                'INSERT INTO environment_logs (device_id, pressure, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.pressure, data.temperature, data.humidity, data.measured_at || timestamp],
                (err) => { if (err) console.error('DB insert error (environment):', err); }
            );
        } else if (topic === 'elevator/accident') {
            //事故データを受信
            // { device_id, accident_type, occurred_at }
            db.query(
                'INSERT INTO accident_logs (device_id, accident_type, occurred_at) VALUES (?, ?, ?)',
                [data.device_id, data.accident_type, data.occurred_at || timestamp],
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