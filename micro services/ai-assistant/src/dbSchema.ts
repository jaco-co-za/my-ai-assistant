export const INITIAL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS inmessages (
    id TEXT PRIMARY KEY,
    "from" TEXT NOT NULL,
    message TEXT NOT NULL,
    received_at TEXT NOT NULL,
    reply_id TEXT
  );

  CREATE TABLE IF NOT EXISTS outmessages (
    id TEXT PRIMARY KEY,
    inmessage_id TEXT,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS voicenotes (
    id TEXT PRIMARY KEY,
    base64 TEXT NOT NULL,
    metadata TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS crons (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    inmessage_id TEXT,
    "from" TEXT NOT NULL,
    message TEXT NOT NULL,
    cron TEXT NOT NULL,
    run_at TEXT,
    is_recurring INTEGER NOT NULL DEFAULT 1,
    active INTEGER NOT NULL DEFAULT 1,
    timezone TEXT,
    summary TEXT,
    action TEXT,
    chronicle_event_id TEXT,
    last_run_at TEXT,
    last_result TEXT,
    last_error TEXT,
    raw_json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS cron_runs (
    id TEXT PRIMARY KEY,
    cron_id INTEGER NOT NULL,
    inmessage_id TEXT,
    status TEXT NOT NULL,
    result TEXT,
    error TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS classification_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    class TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS intent_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    class TEXT NOT NULL,
    intent TEXT NOT NULL,
    verb TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS temporary_action_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    prompt TEXT NOT NULL,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    desired_state TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS pending_confirmations (
    id TEXT PRIMARY KEY,
    "from" TEXT NOT NULL,
    action TEXT NOT NULL,
    payload TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS followup_sessions (
    session_key TEXT PRIMARY KEY,
    turns_json TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS followup_routes (
    session_key TEXT PRIMARY KEY,
    topic TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_outmessages_inmessage_id ON outmessages (inmessage_id);
  CREATE INDEX IF NOT EXISTS idx_crons_inmessage_id ON crons (inmessage_id);
  CREATE INDEX IF NOT EXISTS idx_cron_runs_cron_id ON cron_runs (cron_id);
  CREATE INDEX IF NOT EXISTS idx_pending_confirmations_from ON pending_confirmations ("from");
`;
