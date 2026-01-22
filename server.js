const express = require('express');
const mqtt = require('mqtt');
const mysql = require('mysql2');
const app = express();
const port = 3000;

// MySQL接続設定
const db = mysql.createConnection({
    host: '10.0.2.5',      // DB_SERVER_PRIVATE_IP
    user: 'node_user',     // YOUR_USER
    password: 'Group-02',  // YOUR_PASSWORD
    database: 'elevator_db'
});

db.connect((err) => {
    if (err) {
        console.error('MySQL接続失敗:', err.message);
    } else {
        console.log('MySQL接続成功');
        // 接続成功したらシミュレーションを開始
        startElevatorSimulation();
    }
});


// ---------------------------------------------------
// API エンドポイント
// ---------------------------------------------------

// 混雑度ログ取得（デバッグ用）
app.get('/api/congestion', (req, res) => {
    db.query('SELECT * FROM congestion_logs ORDER BY measured_at DESC', (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 最新の混雑度（各階のホール最新値）
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

// 最新のエレベーター環境（各デバイス最新値）
app.get('/api/environment/latest', (req, res) => {
    db.query(`SELECT device_id, pressure, temperature, humidity, measured_at FROM environment_logs
        WHERE measured_at = (SELECT MAX(measured_at) FROM environment_logs WHERE device_id = environment_logs.device_id)
        ORDER BY device_id`, (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json(results);
    });
});

// 過去データ（混雑度・環境・事故）の統合取得
app.get('/api/history', (req, res) => {
    let { range, date } = req.query;
    let where = '';
    let params = [];
    let groupBy = '';
    let selectTime = '';
    let envGroupBy = '';
    let envSelectTime = '';
    let accidentWhere = '';

    // フィルタ条件の構築
    if (range && date) {
        if (range === 'day') {
            where = 'WHERE DATE(measured_at) = ?';
            params.push(date);
            groupBy = 'c.device_id, c.measured_at';
            selectTime = 'c.measured_at AS measured_at';
            envGroupBy = 'e.device_id, e.measured_at';
            envSelectTime = 'e.measured_at';
        } else if (range === 'week') {
            where = 'WHERE YEARWEEK(measured_at, 1) = YEARWEEK(?, 1)';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at), FLOOR(MINUTE(c.measured_at)/5)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at), FLOOR(MINUTE(e.measured_at)/5)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else if (range === 'month') {
            where = 'WHERE DATE_FORMAT(measured_at, "%Y-%m") = DATE_FORMAT(?, "%Y-%m")';
            params.push(date);
            groupBy = `c.device_id, DATE(c.measured_at), HOUR(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at), HOUR(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        } else if (range === 'all') {
            where = '';
            groupBy = `c.device_id, DATE(c.measured_at)`;
            selectTime = `MIN(c.measured_at) AS measured_at`;
            envGroupBy = `e.device_id, DATE(e.measured_at)`;
            envSelectTime = `MIN(e.measured_at)`;
        }
    } else {
        // デフォルト設定
        groupBy = 'c.device_id, c.measured_at';
        selectTime = 'c.measured_at AS measured_at';
        envGroupBy = 'e.device_id, e.measured_at';
        envSelectTime = 'e.measured_at';
        accidentWhere = '';
    }

    // UNIONクエリの構築
    const congestionSql = `(SELECT d.floor_number, c.device_id, AVG(c.congestion_level) AS congestion_level, ${selectTime}, NULL AS pressure, NULL AS temperature, NULL AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM congestion_logs c
        JOIN devices d ON c.device_id = d.device_id
        ${where}
        GROUP BY ${groupBy}
        ORDER BY measured_at DESC)`;

    const envSql = `(SELECT NULL AS floor_number, e.device_id, NULL AS congestion_level, ${envSelectTime} AS measured_at, AVG(e.pressure) AS pressure, AVG(e.temperature) AS temperature, AVG(e.humidity) AS humidity, NULL AS accident_type, NULL AS occurred_at
        FROM environment_logs e
        ${where}
        GROUP BY ${envGroupBy}
        ORDER BY measured_at DESC)`;

    const accidentSql = `(SELECT NULL AS floor_number, a.device_id, NULL AS congestion_level, NULL AS measured_at, NULL AS pressure, NULL AS temperature, NULL AS humidity, a.accident_type, a.occurred_at
        FROM accident_logs a
        ${accidentWhere}
        ORDER BY a.occurred_at DESC)`;

    const unionSql = `${congestionSql} UNION ALL ${envSql} UNION ALL ${accidentSql}`;
    
    // パラメータは3つのクエリで同じものを使うため3回繰り返す
    db.query(unionSql, [...params, ...params, ...params], (err, results) => {
        if (err) return res.status(500).send('DB Error');
        res.json({ data: results });
    });
});

// Web画面の静的ファイル配信
app.use(express.static('web'));
app.get('/', (req, res) => {
    res.sendFile(__dirname + '/web/home.html');
});


// ---------------------------------------------------
// MQTT 設定 & メッセージ処理
// ---------------------------------------------------

const mqttClient = mqtt.connect('mqtt://localhost:1883');

mqttClient.on('connect', () => {
    console.log('Connected to Mosquitto');
    mqttClient.subscribe([
        'elevator/congestion',
        'elevator/environment',
        'elevator/accident',
        'elevator/arrival'
    ]);
});

mqttClient.on('message', (topic, message) => {
    // デバッグログ
    console.log(`[DEBUG] Topic: ${topic}, Message: ${message.toString()}`);
    
    try {
        const data = JSON.parse(message.toString());
        // 時刻がなければ現在時刻を使用
        const timestamp = data.measured_at ? new Date(data.measured_at) : new Date();

        if (topic === 'elevator/congestion') {
            db.query(
                'INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES (?, ?, ?)',
                [data.device_id, data.congestion_level, data.measured_at || timestamp],
                (err) => { if (err) console.error('DB Insert Error (congestion):', err); }
            );
        } else if (topic === 'elevator/environment') {
            db.query(
                'INSERT INTO environment_logs (device_id, pressure, temperature, humidity, measured_at) VALUES (?, ?, ?, ?, ?)',
                [data.device_id, data.pressure, data.temperature, data.humidity, data.measured_at || timestamp],
                (err) => { if (err) console.error('DB Insert Error (environment):', err); }
            );
        } else if (topic === 'elevator/accident') {
            db.query(
                'INSERT INTO accident_logs (device_id, accident_type, occurred_at) VALUES (?, ?, ?)',
                [data.device_id, data.accident_type, data.occurred_at || timestamp],
                (err) => { if (err) console.error('DB Insert Error (accident):', err); }
            );
        } else if (topic === 'elevator/arrival') {
            // 到着ログの保存
            db.query(
                'INSERT INTO arrival_logs (device_id, floor_number, arrived_at) VALUES (?, ?, ?)',
                [data.device_id, data.floor_number, data.arrived_at || timestamp],
                (err) => { if (err) console.error('DB Insert Error (arrival):', err); }
            );
            // ※到着データ自体もブロードキャストする場合はここでPublishしても良いですが、
            // 下記のシミュレーションループが定期的に送るため、ここでは保存のみとします。
        }
    } catch (e) {
        console.error('MQTT message parse error:', e);
    }
});


// ---------------------------------------------------
// エレベーター位置情報 シミュレーション (ブロードキャスト版)
// ---------------------------------------------------

let currentFloor = 1;
let direction = 1; // 1: 上昇, -1: 下降
const maxFloor = 3; 

function startElevatorSimulation() {
    console.log("エレベーターシミュレーション開始 (Broadcast Mode)");
    scheduleNextMove();
}

function scheduleNextMove() {
    // 5秒(5000ms) ～ 10秒(10000ms) のランダムな待機時間
    const delay = Math.floor(Math.random() * (10000 - 5000 + 1)) + 5000;

    setTimeout(() => {
        moveElevator();
        scheduleNextMove(); // 再帰呼び出しでループ
    }, delay);
}

function moveElevator() {
    // 1 -> 2 -> 3 -> 2 -> 1 の順で移動
    if (direction === 1) {
        if (currentFloor >= maxFloor) {
            direction = -1;
            currentFloor--;
        } else {
            currentFloor++;
        }
    } else {
        if (currentFloor <= 1) {
            direction = 1;
            currentFloor++;
        } else {
            currentFloor--;
        }
    }

    // ブロードキャスト用トピックへ送信
    // 全てのホール端末はこのトピックをSubscribeしてください
    const topic = 'elevator/broadcast/floor';
    
    const payload = JSON.stringify({
        type: 'floor_update',
        floor: currentFloor,
        timestamp: new Date()
    });

    mqttClient.publish(topic, payload);
    console.log(`[SIMULATION] Broadcasted: Floor ${currentFloor} -> Topic: ${topic}`);
}


// サーバー起動
app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});