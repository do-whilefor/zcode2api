
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY, v TEXT
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL DEFAULT '',
  family TEXT NOT NULL,                       -- bigmodel | zai
  customer_id TEXT,
  group_id TEXT,
  status TEXT NOT NULL DEFAULT 'unverified',  -- active|needs_relogin|cooldown|web_only|expired|unverified
  enc_tokens TEXT NOT NULL,                   -- JSON { zcode_jwt, web_jwt, business_token, oauth_access, refresh_token }
  device_mid TEXT NOT NULL,
  app_version TEXT NOT NULL,
  card_started_at INTEGER,
  card_expires_at INTEGER,
  web_cookie_expires_at INTEGER,
  business_token_expires_at INTEGER,
  zcode_jwt_last_ok_at INTEGER,
  fail_streak INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER,
  capabilities TEXT NOT NULL DEFAULT '[]',    -- JSON string[] model ids
  last_balance TEXT,                          -- JSON 原始 balance.data
  last_error TEXT,
  proxy_url TEXT,                             -- 按账号出站代理 http(s)://host:port（NULL=跟随全局）
  source TEXT NOT NULL DEFAULT 'local',       -- local|oauth|cookie
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER,
  last_used_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_accounts_group_created ON accounts(group_id,created_at);
CREATE TABLE IF NOT EXISTS quota_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  bucket_id TEXT,
  entitlement_id TEXT,
  meter TEXT,
  total_units INTEGER,
  used_units INTEGER,
  remaining_units INTEGER,
  expires_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_snap_acc_ts ON quota_snapshots(account_id, ts);
CREATE INDEX IF NOT EXISTS idx_snap_ts ON quota_snapshots(ts);
CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  key_id TEXT,
  client_ip TEXT,
  account_id TEXT,
  family TEXT,
  model TEXT,
  reasoning_level TEXT,
  stream INTEGER,
  attempt_count INTEGER DEFAULT 1,
  rotated_accounts TEXT,
  status TEXT NOT NULL,                       -- success|busy|failed|canceled|exhausted
  error_code TEXT,
  error_message TEXT,
  ttft_ms INTEGER,
  total_ms INTEGER,
  tokens_in INTEGER, tokens_out INTEGER, tokens_reasoning INTEGER,
  cache_read INTEGER, cache_write INTEGER,
  prompt_hash TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON usage_log(ts);
CREATE INDEX IF NOT EXISTS idx_usage_key ON usage_log(key_id, ts);
CREATE TABLE IF NOT EXISTS schedule_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  request_id TEXT,
  chain TEXT,          -- JSON [groupId,...]
  candidates TEXT,     -- JSON [{account, skip, picked}]
  policy TEXT,
  picked TEXT
);
CREATE TABLE IF NOT EXISTS claim_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  plan_id TEXT,
  ok INTEGER NOT NULL,
  code TEXT,
  message TEXT,
  user_plan_id TEXT,
  ends_at INTEGER,
  trigger TEXT DEFAULT 'manual'   -- manual|auto
);
CREATE TABLE IF NOT EXISTS keys (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  key_tail TEXT NOT NULL,
  quota_limit INTEGER,             -- 令牌数上限，NULL 不限
  used_units INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  ip_whitelist TEXT NOT NULL DEFAULT '[]',
  model_whitelist TEXT NOT NULL DEFAULT '[]',
  group_order TEXT,                -- JSON 分组链，NULL = 默认链
  sticky_minutes INTEGER NOT NULL DEFAULT 0,
  default_level TEXT,              -- 该密钥的默认思考档位 low|high|max，NULL = 跟随全局
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER
);
CREATE TABLE IF NOT EXISTS groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'primary',
  family_filter TEXT,
  policy TEXT NOT NULL DEFAULT 'balanced',
  urgent_window_min INTEGER NOT NULL DEFAULT 180,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  k TEXT PRIMARY KEY, v TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  actor TEXT, action TEXT, detail TEXT, ip TEXT
);
CREATE TABLE IF NOT EXISTS oauth_flows (
  flow_id TEXT PRIMARY KEY,
  account_rowid TEXT,
  provider TEXT NOT NULL,
  poll_token_enc TEXT NOT NULL,
  authorize_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending|done|failed|expired|cancelled
  error TEXT,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  account_id TEXT,
  updated_at INTEGER,                      -- 最近一次状态变更（watch 端点按此判断「新鲜」）
  noticed_at INTEGER                       -- 控制台确认过结果的时间（NULL=待提醒）
);
