const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const path = require('path');
const app = express();
const port = 3000;

// --- MySQL接続設定 ---
const db = mysql.createConnection({
    host: '10.0.2.5',       // 環境に合わせて変更
    user: 'node_user',      // 環境に合わせて変更
    password: 'Group-02',   // 環境に合わせて変更
    database: 'elevator_db'
});

db.connect((err) => {
    if (err) console.error('MySQL接続失敗:', err.message);
    else console.log('MySQL接続成功');
});

// --- MQTT接続設定 ---
// Node.jsは同じサーバー上のMosquittoを見るため localhost でOK
const mqttClient = mqtt.connect('mqtt://localhost:1883');

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

// --- API実装 ---

app.use(express.static('web')); // webフォルダを公開

// 最新の混雑度
app.get('/api/congestion/latest', (req, res) => {
    const sql = `
        SELECT d.floor_number, c.congestion_level, c.measured_at
        FROM (
            SELECT device_id, congestion_level, measured_at,
            ROW_NUMBER() OVER (PARTITION BY device_id ORDER BY measured_at DESC) as rn
            FROM congestion_logs
        ) c
        JOIN devices d ON c.device_id = d.device_id
        WHERE c.rn = 1 AND d.location_type = 'HALL'
        ORDER BY d.device_id`; // floor_numberがない場合device_idで代替
    
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(results);
    });
});

// 最新の環境データ
app.get('/api/environment/latest', (req, res) => {
    const sql = `
        SELECT device_id, pressure, temperature, humidity, measured_at 
        FROM environment_logs
        WHERE (device_id, measured_at) IN (
            SELECT device_id, MAX(measured_at) FROM environment_logs GROUP BY device_id
        )`;
    
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({error: err.message});
        res.json(results);
    });
});

// 履歴データ（期間に応じて自動で間引き・平均化を行う）
app.get('/api/history', (req, res) => {
    const { range, date } = req.query;
    let whereClause = '';
    let params = [];
    
    // 期間に応じたSQLのWHERE句作成
    if (range === 'day' && date) {
        whereClause = 'WHERE DATE(measured_at) = ?';
        params = [date, date, date];
    } else if (range === 'week' && date) {
        whereClause = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
        params = [date, date, date];
    } else if (range === 'month' && date) {
        whereClause = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
        params = [date, date, date];
    }

    // ★重要: 表示範囲が広い場合はデータを「5分平均」等にして軽量化する
    let intervalSeconds = 0; // 0なら間引きなし
    if (range === 'week') intervalSeconds = 3600; // 1時間ごと
    if (range === 'month') intervalSeconds = 300; // 5分ごと

    // グループ化用SQLパーツ
    let timeGroup = "measured_at";
    let groupBy = ""; 
    
    if (intervalSeconds > 0) {
        // FROM_UNIXTIMEで時間を丸める
        timeGroup = `FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(measured_at)/${intervalSeconds})*${intervalSeconds})`;
        groupBy = `GROUP BY device_id, FLOOR(UNIX_TIMESTAMP(measured_at)/${intervalSeconds})`;
    }

    // 混雑度SQL (平均をとる)
    const congestionSql = `(SELECT 
        d.device_id, 
        AVG(c.congestion_level) as congestion_level, 
        DATE_FORMAT(${timeGroup}, '%Y-%m-%d %H:%i:%s') as measured_at,
        NULL as pressure, NULL as temperature, NULL as humidity, NULL as accident_type
        FROM congestion_logs c 
        JOIN devices d ON c.device_id = d.device_id 
        ${whereClause} 
        ${groupBy}
    )`;

    // 環境SQL (平均をとる)
    const envSql = `(SELECT 
        e.device_id, 
        NULL as congestion_level, 
        DATE_FORMAT(${timeGroup}, '%Y-%m-%d %H:%i:%s') as measured_at,
        AVG(e.pressure) as pressure, AVG(e.temperature) as temperature, AVG(e.humidity) as humidity, NULL as accident_type
        FROM environment_logs e 
        ${whereClause} 
        ${groupBy}
    )`;

    // 事故SQL (間引きしない。事故は重大なので全て出す)
    const accidentSql = `(SELECT 
        a.device_id, NULL as congestion_level, 
        DATE_FORMAT(a.occurred_at, '%Y-%m-%d %H:%i:%s') as measured_at,
        NULL as pressure, NULL as temperature, NULL as humidity, a.accident_type
        FROM accident_logs a 
        ${whereClause.replace(/measured_at/g, 'occurred_at')}
    )`;

    const finalSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql} ORDER BY measured_at ASC`;

    db.query(finalSql, params, (err, results) => {
        if (err) return res.status(500).json({error: err.message});
        res.json({ data: results });
    });
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});