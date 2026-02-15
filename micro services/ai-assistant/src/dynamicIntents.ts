import path from "node:path";
import Database from "better-sqlite3";

export type DynamicIntentInput = {
  class: string;
  intent: string;
  verb?: string;
  description?: string;
  examples?: string[];
};

type DynamicIntentRow = {
  id: number;
  class: string;
  intent: string;
  verb: string | null;
  description: string | null;
  examples: string | null;
  created_at: string;
};

const INTENTS_DB_PATH = path.resolve("data", "intents.db");

function getDb(): Database.Database {
  const db = new Database(INTENTS_DB_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS dynamic_intents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      class TEXT NOT NULL,
      intent TEXT NOT NULL,
      verb TEXT,
      description TEXT,
      examples TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_dynamic_intents_class ON dynamic_intents (class);
  `);
  return db;
}

export function addDynamicIntent(input: DynamicIntentInput): { ok: boolean; id?: number; error?: string } {
  const classLabel = (input.class || "").trim().toLowerCase();
  const intent = (input.intent || "").trim();
  if (!classLabel || !intent) {
    return { ok: false, error: "class and intent are required" };
  }
  const verb = (input.verb || "").trim();
  const description = (input.description || "").trim();
  const examples = Array.isArray(input.examples)
    ? input.examples.map((value) => String(value).trim()).filter((value) => value.length > 0)
    : [];
  const examplesJson = examples.length > 0 ? JSON.stringify(examples) : null;

  const db = getDb();
  try {
    const result = db
      .prepare(
        `INSERT INTO dynamic_intents (class, intent, verb, description, examples)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(classLabel, intent, verb || null, description || null, examplesJson);
    return { ok: true, id: Number(result.lastInsertRowid) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { ok: false, error: msg };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function listDynamicIntents(messageClass?: string): DynamicIntentRow[] {
  const classLabel = (messageClass || "").trim().toLowerCase();
  const db = getDb();
  try {
    if (classLabel) {
      return db
        .prepare(
          `SELECT id, class, intent, verb, description, examples, created_at
           FROM dynamic_intents
           WHERE class = ?
           ORDER BY created_at DESC`,
        )
        .all(classLabel) as DynamicIntentRow[];
    }
    return db
      .prepare(
        `SELECT id, class, intent, verb, description, examples, created_at
         FROM dynamic_intents
         ORDER BY created_at DESC`,
      )
      .all() as DynamicIntentRow[];
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function clearDynamicIntents(messageClass?: string): { ok: boolean; count: number; error?: string } {
  const classLabel = (messageClass || "").trim().toLowerCase();
  const db = getDb();
  try {
    const result = classLabel
      ? db.prepare("DELETE FROM dynamic_intents WHERE class = ?").run(classLabel)
      : db.prepare("DELETE FROM dynamic_intents").run();
    return { ok: true, count: Number(result.changes) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { ok: false, count: 0, error: msg };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function removeDynamicIntentById(id: number): { ok: boolean; count: number; error?: string } {
  if (!Number.isFinite(id) || id <= 0) {
    return { ok: false, count: 0, error: "Invalid id" };
  }
  const db = getDb();
  try {
    const result = db.prepare("DELETE FROM dynamic_intents WHERE id = ?").run(id);
    return { ok: true, count: Number(result.changes) };
  } catch (error) {
    const msg = error instanceof Error ? error.message : "unknown error";
    return { ok: false, count: 0, error: msg };
  } finally {
    try {
      db.close();
    } catch {
      // ignore
    }
  }
}

export function buildDynamicIntentInstructions(messageClass: string): string[] {
  const rows = listDynamicIntents(messageClass);
  if (rows.length === 0) {
    return [];
  }
  return rows.map((row) => {
    const verb = row.verb ? ` with verb "${row.verb}"` : "";
    const description = row.description ? ` when ${row.description}` : "";
    let examples = "";
    if (row.examples) {
      try {
        const parsed = JSON.parse(row.examples) as string[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          examples = ` Examples: ${parsed.join(" | ")}.`;
        }
      } catch {
        // ignore
      }
    }
    return `For class=${row.class}, use intent "${row.intent}"${verb}${description}.${examples}`;
  });
}
