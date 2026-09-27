CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY,
  device_id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  spot TEXT NOT NULL,
  date TEXT NOT NULL,            -- YYYY-MM-DD（日本時間）
  slot TEXT NOT NULL,            -- morning | afternoon | evening
  bearing REAL NOT NULL,         -- 送った当時のポイントの向き
  fc_wave_height REAL NOT NULL,  -- ここから5列は補正前の予報
  fc_wind_dir REAL NOT NULL,
  fc_wind_speed REAL NOT NULL,
  fc_swell_dir REAL NOT NULL,
  fc_swell_period REAL NOT NULL,
  rating INTEGER NOT NULL,       -- 1..5
  wave_band INTEGER NOT NULL,    -- 0..7
  wind_side TEXT NOT NULL,       -- off | side | on
  wind_strength TEXT NOT NULL,   -- calm | light | strong
  photo_key TEXT,
  photo_bytes INTEGER,           -- photo_key の写真の大きさ
  photo_lat REAL,
  photo_lon REAL,
  photo_taken_at TEXT,           -- YYYY-MM-DDTHH:MM（日本時間）
  ip_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,      -- ISO 8601（UTC）
  updated_at TEXT NOT NULL,
  UNIQUE (device_id, spot, date, slot)
);

-- 受け付けた送信（上限の数え方の元）。3日より前の行は送信のたびに消す。
CREATE TABLE IF NOT EXISTS submissions (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,    -- 送信ごとの乱数（同じ batch の次の文がこの行を指すため）
  device_id TEXT NOT NULL,
  ip_hash TEXT NOT NULL,
  day TEXT NOT NULL,             -- YYYY-MM-DD（日本時間）
  at INTEGER NOT NULL,           -- 受け付けた時刻（Unix ミリ秒）
  photo_bytes INTEGER NOT NULL DEFAULT 0,  -- R2 に置いてよいとした写真の大きさ（置かないなら 0）
  photo_skipped TEXT             -- 写真を置かなかった理由（kill_switch / device_bytes / ...）
);
CREATE INDEX IF NOT EXISTS submissions_day ON submissions (day);

-- R2 にいま置いてある写真の合計。scope は 'global' と 'device:<device_id>'。
CREATE TABLE IF NOT EXISTS storage_usage (
  scope TEXT PRIMARY KEY,
  used_bytes INTEGER NOT NULL DEFAULT 0,
  file_count INTEGER NOT NULL DEFAULT 0
);
