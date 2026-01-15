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
    let { range, date } = req.query;
    let where = '';
    let params = [];
    let groupBy = '';
    let selectTime = '';
    let envGroupBy = '';
    let envSelectTime = '';
    // accidentWhereは常に空にする
    let accidentWhere = '';
    if (range && date) {
        if (range === 'day') {
            // 平均なし
            where = 'WHERE DATE(measured_at) = ?';
            params.push(date);
            groupBy = 'c.device_id, c.measured_at';
            selectTime = 'c.measured_at AS measured_at';
            envGroupBy = 'e.device_id, e.measured_at';
            envSelectTime = 'e.measured_at';
            // accidentWhere = 'WHERE DATE(occurred_at) = ?'; // ← 削除
        } else if (range === 'week') {
            // 5分ごと
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at), FLOOR(MINUTE(c.measured_at)/5)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at), FLOOR(MINUTE(e.measured_at)/5)`;
            envSelectTime = `MIN(e.measured_at)`;
            // accidentWhere = 'WHERE YEARWEEK(occurred_at, 1) = YEARWEEK(?, 1)'; // ← 削除
        } else if (range === 'month') {
            // 1時間ごと
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
            // accidentWhere = 'WHERE DATE_FORMAT(occurred_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")'; // ← 削除
        } else if (range === 'all') {
            // 1日ごと
            where = '';
            groupBy = `c.device_id, DATE(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
            // accidentWhere = ''; // ← そのまま
        }
    } else {
        // デフォルト（日ごと、平均なし）
        groupBy = 'c.device_id, c.measured_at';
        selectTime = 'c.measured_at AS measured_at';
        envGroupBy = 'e.device_id, e.measured_at';
        envSelectTime = 'e.measured_at';
        accidentWhere = '';
    }

    // 混雑度
    const congestionSql = `(SELECT d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, ${selectTime}, NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM congestion_logs c
        JOIN devices d ON c.device_id = d.device_id
        ${where}
        GROUP BY ${groupBy}
        ORDER BY measured_at DESC)`;

    // 環境
    const envSql = `(SELECT NULL AS floor_number, e.device_id, NULL AS congestion_level, ${envSelectTime} AS measured_at, AVG(e.pressure) AS pressure, AVG(e.temperature) AS temperature, AVG(e.humidity) AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM environment_logs e
        ${where}
        GROUP BY ${envGroupBy}
        ORDER BY measured_at DESC)`;

    // 事故
    const accidentSql = `(SELECT NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
        FROM accident_logs a
        ${accidentWhere}
        ORDER BY a.occurred_at DESC)`;

    const unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql}`;
    db.query(unionSql, [...params, ...params, ...params], (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ data: results, totalPages: 1 });
    });
});

// 生データ取得API
app.get('/api/rawdata', (req, res) => {
    let { range, date } = req.query;
    let congestionWhere = '';
    let envWhere = '';
    let accidentWhere = '';
    let params = [];
    if (range && date) {
        if (range === 'day') {
            congestionWhere = 'WHERE DATE(measured_at) = ?';
            envWhere = 'WHERE DATE(measured_at) = ?';
            accidentWhere = 'WHERE DATE(occurred_at) = ?';
            params = [date, date, date];
        } else if (range === 'week') {
            congestionWhere = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            envWhere = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            accidentWhere = 'WHERE YEARWEEK(occurred_at, 1) = YEARWEEK(?, 1)';
            params = [date, date, date];
        } else if (range === 'month') {
            congestionWhere = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            envWhere = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            accidentWhere = 'WHERE DATE_FORMAT(occurred_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params = [date, date, date];
        } else if (range === 'all') {
            congestionWhere = '';
            envWhere = '';
            accidentWhere = '';
            params = [];
        }
    }
    // 混雑度
    const congestionSql = `SELECT d.floor_number, c.device_id, c.congestion_level, c.measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM congestion_logs c
        JOIN devices d ON c.device_id = d.device_id
        ${congestionWhere}`;
    // 環境
    const envSql = `SELECT NULL AS floor_number, e.device_id, NULL AS congestion_level, e.measured_at, e.pressure, e.temperature, e.humidity, NULL AS accident_type, NULL AS occurred_at
        FROM environment_logs e
        ${envWhere}`;
    // 事故
    const accidentSql = `SELECT NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
        FROM accident_logs a
        ${accidentWhere}`;
    const unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql} ORDER BY measured_at DESC, occurred_at DESC`;
    db.query(unionSql, params, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ data: results });
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
    mqttClient.subscribe([
        'elevator/congestion',
        'elevator/environment',
        'elevator/accident',
        'elevator/arrival' // 追加: 到着階数トピック
    ]);
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
        else if (topic === 'elevator/arrival') {
            // { device_id, floor_number, arrived_at }
            // arrived_atがなければ現在時刻
            const arrivedAt = data.arrived_at ? new Date(data.arrived_at) : new Date();
            // 必要ならDB保存処理を追加（今回は配信のみ）
            // すべてのサブスクライバーに階数データを配信
            mqttClient.publish(
                'elevator/arrival/broadcast',
                JSON.stringify({
                    device_id: data.device_id,
                    floor_number: data.floor_number,
                    arrived_at: arrivedAt
                })
            );
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
        } else if (topic === 'elevator/arrival') {
            // エレベーター到着階数データを受信
            // { device_id, floor_number, arrived_at }
            db.query(
                'INSERT INTO arrival_logs (device_id, floor_number, arrived_at) VALUES (?, ?, ?)',
                [data.device_id, data.floor_number, data.arrived_at || timestamp],
                (err) => { if (err) console.error('DB insert error (arrival):', err); }
            );
        }
    } catch (e) {
        console.error('MQTT message parse error:', e);
    }
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});