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

// ★★★ 履歴取得API（平均化 or 生データ） ★★★
app.get('/api/history', (req, res) => {
    let { range, date, raw } = req.query; // rawパラメータを追加
    let where = '';
    let accidentWhere = '';
    let params = [];
    
    // --- 共通: 期間フィルタの作成 ---
    // 生データでも平均データでも「いつのデータか」という条件は同じなので共通化
    if (range && date) {
        if (range === 'day') {
            where = 'WHERE DATE(measured_at) = ?';
            accidentWhere = 'WHERE DATE(occurred_at) = ?';
            params.push(date);
        } else if (range === 'week') {
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            accidentWhere = 'WHERE YEARWEEK(occurred_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
        } else if (range === 'month') {
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            accidentWhere = 'WHERE DATE_FORMAT(occurred_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
        }
    }

    let unionSql = '';

    if (raw === 'true') {
        // ★ 生データ取得モード (GROUP BY なし, AVG なし)
        // 1. 混雑度 (Raw)
        const congestionSql = `(SELECT 
                'CONGESTION' as rec_type,
                d.floor_number, c.device_id, c.congestion_level, c.measured_at, 
                NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
            FROM congestion_logs c
            JOIN devices d ON c.device_id = d.device_id
            ${where})`;

        // 2. 環境 (Raw)
        const envSql = `(SELECT 
                'ENVIRONMENT' as rec_type,
                NULL AS floor_number, e.device_id, NULL AS congestion_level, e.measured_at, 
                e.pressure, e.temperature, e.humidity, NULL AS accident_type, NULL AS occurred_at
            FROM environment_logs e
            ${where})`;
        
        // 3. 事故 (Raw) ※事故は元々平均化しないので同じだが整合性のため含める
        const accidentSql = `(SELECT 
                'ACCIDENT' as rec_type,
                NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, 
                NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
            FROM accident_logs a
            ${accidentWhere})`;

        unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql} ORDER BY measured_at DESC, occurred_at DESC`;

    } else {
        // ★ グラフ用・平均データ取得モード (GROUP BY あり, AVG あり)
        let groupBy = '', selectTime = '', envGroupBy = '', envSelectTime = '';

        if (range === 'day') {
            groupBy = 'c.device_id, c.measured_at';
            selectTime = 'c.measured_at AS measured_at';
            envGroupBy = 'e.device_id, e.measured_at';
            envSelectTime = 'e.measured_at';
        } else if (range === 'week') {
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at), FLOOR(MINUTE(c.measured_at)/5)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at), FLOOR(MINUTE(e.measured_at)/5)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else if (range === 'month') {
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else {
            // all or default
            groupBy = `c.device_id, DATE(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        }

        const congestionSql = `(SELECT 
                'CONGESTION' as rec_type,
                d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, ${selectTime}, 
                NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
            FROM congestion_logs c
            JOIN devices d ON c.device_id = d.device_id
            ${where}
            GROUP BY ${groupBy})`;

        const envSql = `(SELECT 
                'ENVIRONMENT' as rec_type,
                NULL AS floor_number, e.device_id, NULL AS congestion_level, ${envSelectTime} AS measured_at, 
                AVG(e.pressure) AS pressure, AVG(e.temperature) AS temperature, AVG(e.humidity) AS humidity, NULL AS accident_type, NULL AS occurred_at
            FROM environment_logs e
            ${where}
            GROUP BY ${envGroupBy})`;

        const accidentSql = `(SELECT 
                'ACCIDENT' as rec_type,
                NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, 
                NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
            FROM accident_logs a
            ${accidentWhere})`;

        unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql} ORDER BY measured_at DESC, occurred_at DESC`;
    }

    // パラメータは3つのクエリで同じものを使うため3回繰り返す
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
}

// --- 混雑状況ブロードキャスト機能 ---

// 混雑度(数値)をステータス(文字列)に変換する関数
function getCongestionStatus(level) {
    if (level < 30) return '空き';   // 0〜29
    if (level < 70) return '普通';   // 30〜69
    return '混雑';                   // 70〜100
}

// 全階層の最新混雑状況を取得してMQTT送信する関数
function broadcastCongestion() {
    // APIで使用しているのと同じ「各デバイスの最新データ」を取得するSQL
    const sql = `
        SELECT floor_number, congestion_level, measured_at
        FROM (
          SELECT d.floor_number, c.congestion_level, c.measured_at,
            ROW_NUMBER() OVER (PARTITION BY c.device_id ORDER BY c.measured_at DESC) as rn
          FROM congestion_logs c
          JOIN devices d ON c.device_id = d.device_id
          WHERE d.location_type = 'HALL'
        ) t
        WHERE t.rn = 1 ORDER BY floor_number ASC
    `;

    db.query(sql, (err, results) => {
        if (err) {
            console.error('Broadcast DB Error:', err.message);
            return;
        }

        // データを整形（ステータス付与）
        const broadcastData = results.map(row => ({
            floor: row.floor_number,
            level: row.congestion_level,
            status: getCongestionStatus(row.congestion_level), // ここで「空き・普通・混雑」を入れる
            timestamp: row.measured_at
        }));

        // MQTTへ送信
        const payload = JSON.stringify({
            type: 'congestion_all',
            data: broadcastData
        });

        // トピック名: elevator/broadcast/congestion_all
        mqttClient.publish('elevator/broadcast/congestion_all', payload);
    });
}

// 5秒ごとに混雑状況をブロードキャスト（間隔は好みで調整）
setInterval(broadcastCongestion, 5000);

app.listen(port, () => console.log(`Server running on port ${port}`));