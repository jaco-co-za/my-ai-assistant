import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'node:util';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/email.db';

async function init() {
  await mkdir(dirname(DB_PATH), { recursive: true });
  const db = new sqlite3.Database(DB_PATH);
  const dbExec = promisify(db.exec.bind(db));

  const schema = `
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS system_health (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      status TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      last_uid INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS email_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      folder_id INTEGER NOT NULL,
      server_uid INTEGER NOT NULL,
      message_id TEXT,
      from_raw TEXT,
      to_raw TEXT,
      cc_raw TEXT,
      bcc_raw TEXT,
      subject TEXT,
      received_at DATETIME,
      headers_raw TEXT,
      text_body TEXT,
      is_seen INTEGER NOT NULL DEFAULT 1,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(folder_id, server_uid),
      FOREIGN KEY(folder_id) REFERENCES folders(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS email_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email_id INTEGER NOT NULL,
      part TEXT,
      filename TEXT,
      disposition TEXT,
      content_type TEXT,
      size INTEGER,
      storage_path TEXT,
      FOREIGN KEY(email_id) REFERENCES email_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachment_text_extractions (
      attachment_id INTEGER PRIMARY KEY,
      email_id INTEGER NOT NULL,
      folder_path TEXT,
      filename TEXT,
      content_type TEXT,
      extracted_text TEXT NOT NULL,
      text_length INTEGER NOT NULL DEFAULT 0,
      extractor TEXT NOT NULL DEFAULT 'pdf2json',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(attachment_id) REFERENCES email_attachments(id) ON DELETE CASCADE,
      FOREIGN KEY(email_id) REFERENCES email_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS attachment_llm_cache (
      key TEXT PRIMARY KEY,
      attachment_id INTEGER NOT NULL,
      prompt TEXT NOT NULL,
      response TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(attachment_id) REFERENCES email_attachments(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS llm_followup_state (
      session_key TEXT PRIMARY KEY,
      is_active INTEGER NOT NULL DEFAULT 0,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS llm_followup_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_key TEXT NOT NULL,
      user_prompt TEXT NOT NULL,
      llm_reply TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `;

  await dbExec(schema);
  db.close();
}

init()
  .then(() => {
    // eslint-disable-next-line no-console
    console.log(`[init] SQLite schema ready at ${DB_PATH}`);
  })
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error('Failed to initialize SQLite schema:', err);
    process.exit(1);
  });
