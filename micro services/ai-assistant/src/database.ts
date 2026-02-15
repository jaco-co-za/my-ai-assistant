import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { INITIAL_SCHEMA_SQL } from "./dbSchema.js";

let database: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (database) {
    return database;
  }

  const dbPath = process.env.SQLITE_PATH ?? path.resolve("data", "messages.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });

  const instance = new Database(dbPath);
  instance.pragma("journal_mode = WAL");
  instance.exec(INITIAL_SCHEMA_SQL);
  ensureSchemaUpdates(instance);

  database = instance;
  return instance;
}

function ensureSchemaUpdates(db: Database.Database): void {
  try {
    const columns = db.prepare(`PRAGMA table_info(crons);`).all() as Array<{ name: string }>;
    const idColumn = columns.find((column) => column.name === "id");
    const idIsInteger = idColumn ? String((idColumn as unknown as { type?: string }).type || "").toUpperCase().includes("INT") : false;
    if (columns.length > 0 && !idIsInteger) {
      migrateCronsToIntegerIds(db);
      return;
    }
    const hasAction = columns.some((column) => column.name === "action");
    if (!hasAction) {
      db.exec(`ALTER TABLE crons ADD COLUMN action TEXT;`);
    }
    const hasRunAt = columns.some((column) => column.name === "run_at");
    if (!hasRunAt) {
      db.exec(`ALTER TABLE crons ADD COLUMN run_at TEXT;`);
    }
    const hasIsRecurring = columns.some((column) => column.name === "is_recurring");
    if (!hasIsRecurring) {
      db.exec(`ALTER TABLE crons ADD COLUMN is_recurring INTEGER NOT NULL DEFAULT 1;`);
    }
    const hasActive = columns.some((column) => column.name === "active");
    if (!hasActive) {
      db.exec(`ALTER TABLE crons ADD COLUMN active INTEGER NOT NULL DEFAULT 1;`);
    }
    const hasLastRunAt = columns.some((column) => column.name === "last_run_at");
    if (!hasLastRunAt) {
      db.exec(`ALTER TABLE crons ADD COLUMN last_run_at TEXT;`);
    }
    const hasLastResult = columns.some((column) => column.name === "last_result");
    if (!hasLastResult) {
      db.exec(`ALTER TABLE crons ADD COLUMN last_result TEXT;`);
    }
    const hasLastError = columns.some((column) => column.name === "last_error");
    if (!hasLastError) {
      db.exec(`ALTER TABLE crons ADD COLUMN last_error TEXT;`);
    }
    const hasChronicleEventId = columns.some((column) => column.name === "chronicle_event_id");
    if (!hasChronicleEventId) {
      db.exec(`ALTER TABLE crons ADD COLUMN chronicle_event_id TEXT;`);
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] schema update failed: ${msg}`);
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS classification_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, class TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] classification cache init failed: ${msg}`);
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS intent_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, class TEXT NOT NULL, intent TEXT NOT NULL, verb TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] intent cache init failed: ${msg}`);
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS temporary_action_cache (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL, action TEXT NOT NULL, entity TEXT NOT NULL, desired_state TEXT NOT NULL, duration_seconds INTEGER NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] temporary action cache init failed: ${msg}`);
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS pending_confirmations (id TEXT PRIMARY KEY, \"from\" TEXT NOT NULL, action TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')), expires_at TEXT NOT NULL);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_pending_confirmations_from ON pending_confirmations (\"from\");",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] pending confirmations init failed: ${msg}`);
  }

  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT NOT NULL DEFAULT (datetime('now')));",
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    console.warn(`[db] app settings init failed: ${msg}`);
  }

}

function migrateCronsToIntegerIds(db: Database.Database): void {
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS crons_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        old_id TEXT,
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

      INSERT INTO crons_new (
        old_id, inmessage_id, "from", message, cron, run_at, is_recurring, active, timezone, summary, action, chronicle_event_id, last_run_at, last_result, last_error, raw_json, created_at
      )
      SELECT id, inmessage_id, "from", message, cron, run_at, is_recurring, active, timezone, summary, action, chronicle_event_id, last_run_at, last_result, last_error, raw_json, created_at
      FROM crons;

      CREATE TABLE IF NOT EXISTS cron_runs_new (
        id TEXT PRIMARY KEY,
        cron_id INTEGER NOT NULL,
        inmessage_id TEXT,
        status TEXT NOT NULL,
        result TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );

      INSERT INTO cron_runs_new (id, cron_id, inmessage_id, status, result, error, created_at)
      SELECT r.id, c.id, r.inmessage_id, r.status, r.result, r.error, r.created_at
      FROM cron_runs r
      JOIN crons_new c ON c.old_id = r.cron_id;

      DROP TABLE cron_runs;
      DROP TABLE crons;

      ALTER TABLE crons_new RENAME TO crons;
      ALTER TABLE cron_runs_new RENAME TO cron_runs;

      CREATE INDEX IF NOT EXISTS idx_crons_inmessage_id ON crons (inmessage_id);
      CREATE INDEX IF NOT EXISTS idx_cron_runs_cron_id ON cron_runs (cron_id);
    `);
  });

  tx();
}
