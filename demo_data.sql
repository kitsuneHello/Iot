DELETE FROM congestion_logs;
DELETE FROM environment_logs;
DELETE FROM accident_logs;
DELETE FROM elevator_trips;
DELETE FROM devices;

-- デバイス登録
INSERT INTO devices (device_id, location_type, floor_number, description) VALUES
('hall_1F', 'HALL', 1, '1階エレベーターホール'),
('hall_2F', 'HALL', 2, '2階エレベーターホール'),
('elevator_1', 'ELEVATOR', NULL, 'エレベーター1号機');

-- 混雑度ログ（1時間ごと、2フロア×3件）
INSERT INTO congestion_logs (device_id, congestion_level, measured_at) VALUES
('hall_1F', 0.20, '2025-12-11 09:00:00'),
('hall_1F', 0.25, '2025-12-11 10:00:00'),
('hall_1F', 0.22, '2025-12-11 11:00:00'),
('hall_2F', 0.35, '2025-12-11 09:00:00'),
('hall_2F', 0.38, '2025-12-11 10:00:00'),
('hall_2F', 0.36, '2025-12-11 11:00:00');

-- 環境データログ（1時間ごと、3件）
INSERT INTO environment_logs (device_id, co2_ppm, temperature, humidity, measured_at) VALUES
('elevator_1', 800, 24.5, 40.2, '2025-12-11 09:00:00'),
('elevator_1', 810, 24.7, 40.5, '2025-12-11 10:00:00'),
('elevator_1', 820, 24.8, 41.0, '2025-12-11 11:00:00');

-- 事故検知ログ（1件）
INSERT INTO accident_logs (device_id, accident_type, occurred_at, is_resolved) VALUES
('elevator_1', 'fall', '2025-12-11 10:30:00', FALSE);

-- RTT（1件）
INSERT INTO elevator_trips (start_time, end_time, trip_label) VALUES
('2025-12-11 09:00:00', '2025-12-11 11:00:00', '午前のラウンド');
