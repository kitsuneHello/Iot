const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const app = express();
const port = 3000;

// MySQL接続設定
const db = mysql.createConnection({
    host: '10.0.2.5',
    user: 'node_user',
    password: 'Group-02',
    database: 'elevator_db'
});

db.connect((err) => {
    if (err) {
        console.error('MySQL接続失敗:', err.message);
    } else {
        console.log('MySQL接続成功');
        startElevatorSimulation();
    }
});

// --- API エンドポイント ---

// 混雑度ログ（デバッグ用）
app.get('/api/congestion', (req, res) => {
    db.query('SELECT * FROM congestion_logs ORDER BY measured_at DESC', (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新の混雑度
app.get('/api/congestion/latest', (req, res) => {
    db.query(`SELECT floor_number, congestion_level, measured_at
        FROM (
          SELECT d.floor_number, c.congestion_level, c.measured_at,
            ROW_NUMBER() OVER (PARTITION BY c.device_id ORDER BY c.measured_at DESC) as rn
          FROM congestion_logs c
          JOIN devices d ON c.device_id = d.device_id
          WHERE d.location_type = 'HALL'
        ) t
        WHERE t.rn = 1 ORDER BY floor_number`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新の環境情報
app.get('/api/environment/latest', (req, res) => {
    db.query(`SELECT device_id, pressure, temperature, humidity, measured_at FROM environment_logs
        WHERE measured_at = (SELECT MAX(measured_at) FROM environment_logs WHERE device_id = environment_logs.device_id)
        ORDER BY device_id`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// ★★★ 履歴取得API（ここを修正） ★★★
app.get('/api/history', (req, res) => {
    let { range, date } = req.query;
    let where = '';
    let accidentWhere = '';
    let params = [];
    let groupBy = '';
    let selectTime = '';
    let envGroupBy = '';
    let envSelectTime = '';

    // フィルタ条件構築
    if (range && date) {
        if (range === 'day') {
            where = 'WHERE DATE(measured_at) = ?';
            accidentWhere = 'WHERE DATE(occurred_at) = ?';
            params.push(date);
            groupBy = 'c.device_id, c.measured_at';
            selectTime = 'c.measured_at AS measured_at';
            envGroupBy = 'e.device_id, e.measured_at';
            envSelectTime = 'e.measured_at';
        } else if (range === 'week') {
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            accidentWhere = 'WHERE YEARWEEK(occurred_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at), FLOOR(MINUTE(c.measured_at)/5)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at), FLOOR(MINUTE(e.measured_at)/5)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else if (range === 'month') {
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            accidentWhere = 'WHERE DATE_FORMAT(occurred_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else if (range === 'all') {
            where = '';
            accidentWhere = '';
            groupBy = `c.device_id, DATE(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        }
    } else {
        groupBy = 'c.device_id, c.measured_at';
        selectTime = 'c.measured_at AS measured_at';
        envGroupBy = 'e.device_id, e.measured_at';
        envSelectTime = 'e.measured_at';
    }

    // ★ SQL修正: 'rec_type' カラムを追加し、フロントエンドで判別可能にする
    
    // 1. 混雑度
    const congestionSql = `(SELECT 
            'CONGESTION' as rec_type,
            d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, ${selectTime}, 
            NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM congestion_logs c
        JOIN devices d ON c.device_id = d.device_id
        ${where}
        GROUP BY ${groupBy})`;

    // 2. 環境
    const envSql = `(SELECT 
            'ENVIRONMENT' as rec_type,
            NULL AS floor_number, e.device_id, NULL AS congestion_level, ${envSelectTime} AS measured_at, 
            AVG(e.pressure) AS pressure, AVG(e.temperature) AS temperature, AVG(e.humidity) AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM environment_logs e
        ${where}
        GROUP BY ${envGroupBy})`;

    // 3. 事故
    const accidentSql = `(SELECT 
            'ACCIDENT' as rec_type,
            NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, 
            NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
        FROM accident_logs a
        ${accidentWhere})`;

    const unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql} ORDER BY measured_at DESC, occurred_at DESC`;
    
    db.query(unionSql, [...params, ...params, ...params], (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ data: results });
    });
});

app.use(express.static('web'));
app.get('/', (req, res) => { res.sendFile(__dirname + '/web/home.html'); });

// --- MQTT ---
const mqttClient = mqtt.connect('mqtt://localhost:1883');
mqttClient.on('connect', () => {
    console.log('Connected to Mosquitto');
    mqttClient.subscribe(['elevator/congestion', 'elevator/environment', 'elevator/accident', 'elevator/arrival']);
});

mqttClient.on('message', (topic, message) => {
    try {
        const data = JSON.parse(message.toString());
        const timestamp = data.measured_at ? new Date(data.measured_at) : new Date();
        if (topic === 'elevator/congestion') {
            db.query('INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES (?, ?, ?)',
                [data.device_id, data.congestion_level, data.measured_at || timestamp], err => { if(err) console.error(err); });
        } else if (topic === 'elevator/environment') {
            db.query('INSERT INTO environment_logs (device_id, pressure, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.pressure, data.temperature, data.humidity, data.measured_at || timestamp], err => { if(err) console.error(err); });
        } else if (topic === 'elevator/accident') {
            db.query('INSERT INTO accident_logs (device_id, accident_type, occurred_at) VALUES (?, ?, ?)',
                [data.device_id, data.accident_type, data.occurred_at || timestamp], err => { if(err) console.error(err); });
        } else if (topic === 'elevator/arrival') {
            db.query('INSERT INTO arrival_logs (device_id, floor_number, arrived_at) VALUES (?, ?, ?)',
                [data.device_id, data.floor_number, data.arrived_at || timestamp], err => { if(err) console.error(err); });
        }
    } catch (e) { console.error(e); }
});

// --- Simulation ---
let currentFloor = 1;
let direction = 1;
const maxFloor = 3;
function startElevatorSimulation() { scheduleNextMove(); }
function scheduleNextMove() {
    const delay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;
    setTimeout(() => { moveElevator(); scheduleNextMove(); }, delay);
}
function moveElevator() {
    if (direction === 1) { currentFloor >= maxFloor ? (direction = -1, currentFloor--) : currentFloor++; }
    else { currentFloor <= 1 ? (direction = 1, currentFloor++) : currentFloor--; }
    mqttClient.publish('elevator/broadcast/floor', JSON.stringify({ type: 'floor_update', floor: currentFloor, timestamp: new Date() }));
    console.log(`[SIM] Floor: ${currentFloor}`);
}

app.listen(port, () => console.log(`Server running on port ${port}`));