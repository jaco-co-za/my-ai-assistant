import express from 'express';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import nodemailer from 'nodemailer';
import { promisify } from 'node:util';
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createEmailSync } from './emailSync.js';
import { ImapFlow } from 'imapflow';
import { chunkUids } from './helpers.js';
import { registerEndpoints } from './endpoints.js';
import { deleteAttachmentObject, getAttachmentStorageMode } from './attachmentStorage.js';

// Load environment variables from .env if present
dotenv.config();

const app = express();
app.use(express.json());

const PORT = Number.parseInt(process.env.PORT || '3222', 10);
const DB_PATH = process.env.DB_PATH || './data/email.db';
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || './attachments';
const EMAIL_IMAP_HOST = process.env.EMAIL_IMAP_HOST;
const EMAIL_IMAP_PORT = Number.parseInt(process.env.EMAIL_IMAP_PORT || '993', 10);
const EMAIL_IMAP_SECURE = String(process.env.EMAIL_IMAP_SECURE || 'true').toLowerCase() === 'true';
const EMAIL_IMAP_USERNAME = process.env.EMAIL_IMAP_USERNAME;
const EMAIL_IMAP_PASSWORD = process.env.EMAIL_IMAP_PASSWORD;
const EMAIL_IMAP_TRASH_MAILBOX = process.env.EMAIL_IMAP_TRASH_MAILBOX;
const EMAIL_IMAP_SENT_MAILBOX = process.env.EMAIL_IMAP_SENT_MAILBOX;
const EMAIL_IMAP_OPERATION_TIMEOUT_MS = Number.parseInt(
  process.env.EMAIL_IMAP_OPERATION_TIMEOUT_MS || '30000',
  10,
);
const EMAIL_SMTP_HOST = process.env.EMAIL_SMTP_HOST;
const EMAIL_SMTP_PORT = Number.parseInt(process.env.EMAIL_SMTP_PORT || '465', 10);
const EMAIL_SMTP_SECURE = String(process.env.EMAIL_SMTP_SECURE || 'true').toLowerCase() === 'true';
const EMAIL_SMTP_USERNAME = process.env.EMAIL_SMTP_USERNAME;
const EMAIL_SMTP_PASSWORD = process.env.EMAIL_SMTP_PASSWORD;
const EMAIL_EMAIL = process.env.EMAIL_EMAIL;
const EMAIL_EMAIL_FROM_NAME = process.env.EMAIL_EMAIL_FROM_NAME;
const EMAIL_SIGNATURE = process.env.EMAIL_SIGNATURE || '';
const DEBUG = String(process.env.DEBUG || 'false').toLowerCase() === 'true';
const SKIP_AUTH = String(process.env.SKIP_AUTH || 'false').toLowerCase() === 'true';
const AUTH_BEARER_TOKEN = process.env.AUTH_BEARER_TOKEN || '';

let db: sqlite3.Database | null = null;
let dbGet: (sql: string, ...params: unknown[]) => Promise<any>;
let dbRun: (sql: string, ...params: unknown[]) => Promise<void>;
let dbAll: (sql: string, ...params: unknown[]) => Promise<any[]>;

let smtpTransporter: nodemailer.Transporter | null = null;

async function withTimeout<T>(label: string, operation: Promise<T>, timeoutMs: number): Promise<T> {
  const duration = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${duration}ms`));
    }, duration);
    operation
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

function normalizeSignature(value: string) {
  return value.replace(/\\n/g, '\n').trim();
}

function escapeHeaderValue(value: string) {
  return value.replace(/\r/g, '').replace(/\n/g, ' ').trim();
}

function toSentMailboxCandidates() {
  const configured = (EMAIL_IMAP_SENT_MAILBOX || '').trim();
  const candidates = [configured, 'INBOX.Sent', 'Sent']
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return Array.from(new Set(candidates));
}

function buildRawSentMessage(payload: {
  from: string;
  to: string;
  subject: string;
  text: string;
  messageId?: string;
}) {
  const dateHeader = new Date().toUTCString();
  const messageId =
    payload.messageId && payload.messageId.trim().length > 0
      ? payload.messageId.trim()
      : `<${Date.now()}.${Math.random().toString(16).slice(2)}@local>`;
  const headers = [
    `From: ${escapeHeaderValue(payload.from)}`,
    `To: ${escapeHeaderValue(payload.to)}`,
    `Subject: ${escapeHeaderValue(payload.subject)}`,
    `Date: ${dateHeader}`,
    `Message-ID: ${escapeHeaderValue(messageId)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  const body = payload.text.replace(/\r?\n/g, '\r\n');
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n`;
}

async function appendSentCopy(rawMessage: string): Promise<{ mailbox: string | null; warning?: string }> {
  if (!EMAIL_IMAP_HOST || !EMAIL_IMAP_USERNAME || !EMAIL_IMAP_PASSWORD) {
    return { mailbox: null, warning: 'IMAP settings are missing; sent copy was not appended.' };
  }
  const client = new ImapFlow({
    host: EMAIL_IMAP_HOST,
    port: EMAIL_IMAP_PORT,
    secure: EMAIL_IMAP_SECURE,
    logger: DEBUG ? undefined : false,
    auth: {
      user: EMAIL_IMAP_USERNAME,
      pass: EMAIL_IMAP_PASSWORD,
    },
  });

  const candidates = toSentMailboxCandidates();
  const errors: string[] = [];
  try {
    await client.connect();
    for (const mailbox of candidates) {
      try {
        await client.append(mailbox, rawMessage, ['\\Seen'], new Date());
        return { mailbox };
      } catch (err: any) {
        errors.push(`${mailbox}: ${err?.message || 'append failed'}`);
      }
    }
    return {
      mailbox: null,
      warning:
        errors.length > 0
          ? `Sent copy append failed (${errors.join('; ')})`
          : 'Sent copy append failed.',
    };
  } finally {
    await client.logout().catch(() => {});
  }
}

function getSmtpTransporter() {
  if (smtpTransporter) {
    return smtpTransporter;
  }
  if (!EMAIL_SMTP_HOST || !EMAIL_SMTP_USERNAME || !EMAIL_SMTP_PASSWORD) {
    throw new Error('SMTP settings are missing.');
  }
  smtpTransporter = nodemailer.createTransport({
    host: EMAIL_SMTP_HOST,
    port: EMAIL_SMTP_PORT,
    secure: EMAIL_SMTP_SECURE,
    auth: {
      user: EMAIL_SMTP_USERNAME,
      pass: EMAIL_SMTP_PASSWORD,
    },
  });
  return smtpTransporter;
}

async function sendMail(payload: { to: string; subject: string; body: string }) {
  const transporter = getSmtpTransporter();
  const fromEmail = EMAIL_EMAIL || EMAIL_SMTP_USERNAME || '';
  if (!fromEmail) {
    throw new Error('Sender email is missing.');
  }
  const fromName = EMAIL_EMAIL_FROM_NAME?.trim() || '';
  const from = fromName ? `${fromName} <${fromEmail}>` : fromEmail;
  const signature = normalizeSignature(EMAIL_SIGNATURE);
  const text = signature ? `${payload.body}\n\n${signature}` : payload.body;
  const sentInfo = await transporter.sendMail({
    from,
    to: payload.to,
    subject: payload.subject,
    text,
  });
  const rawMessage = buildRawSentMessage({
    from,
    to: payload.to,
    subject: payload.subject,
    text,
    messageId: typeof sentInfo?.messageId === 'string' ? sentInfo.messageId : undefined,
  });
  const appendResult = await appendSentCopy(rawMessage);
  if (appendResult.warning) {
    // eslint-disable-next-line no-console
    console.warn(`[send-mail] ${appendResult.warning}`);
  } else if (appendResult.mailbox) {
    // eslint-disable-next-line no-console
    console.log(`[send-mail] appended sent copy to "${appendResult.mailbox}"`);
  }
  return {
    ...sentInfo,
    response: appendResult.warning
      ? `${sentInfo.response || ''}${sentInfo.response ? ' | ' : ''}${appendResult.warning}`
      : sentInfo.response,
  };
}

async function deleteAttachmentFiles(emailIds: number[]) {
  if (emailIds.length === 0) {
    return;
  }
  const placeholders = emailIds.map(() => '?').join(', ');
  const rows = await dbAll(
    `SELECT storage_path FROM email_attachments WHERE email_id IN (${placeholders});`,
    ...emailIds,
  );
  for (const row of rows) {
    if (row?.storage_path) {
      await deleteAttachmentObject(String(row.storage_path), ATTACHMENTS_DIR).catch(() => {});
    }
  }
}

async function deleteMail(payload: { ids: number[] }) {
  const ids = Array.from(new Set(payload.ids)).filter((id) => Number.isFinite(id) && id > 0);
  if (ids.length === 0) {
    return { requested: 0, found: 0, deleted: 0, skipped: 0 };
  }
  if (!EMAIL_IMAP_HOST || !EMAIL_IMAP_USERNAME || !EMAIL_IMAP_PASSWORD) {
    throw new Error('IMAP settings are missing.');
  }

  const placeholders = ids.map(() => '?').join(', ');
  const rows = await dbAll(
    `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
     FROM email_messages
     INNER JOIN folders ON email_messages.folder_id = folders.id
     WHERE email_messages.id IN (${placeholders});`,
    ...ids,
  );
  const foundIds = new Set<number>();
  const folderMap = new Map<string, Array<{ id: number; uid: number }>>();
  for (const row of rows) {
    const id = Number(row?.id);
    const uid = Number(row?.server_uid);
    const folderPath = row?.folder_path ? String(row.folder_path) : '';
    if (!Number.isFinite(id) || !Number.isFinite(uid) || uid <= 0 || !folderPath) {
      continue;
    }
    foundIds.add(id);
    if (!folderMap.has(folderPath)) {
      folderMap.set(folderPath, []);
    }
    folderMap.get(folderPath)?.push({ id, uid });
  }

  const missing = ids.filter((id) => !foundIds.has(id));
  const client = new ImapFlow({
    host: EMAIL_IMAP_HOST,
    port: EMAIL_IMAP_PORT,
    secure: EMAIL_IMAP_SECURE,
    logger: DEBUG ? undefined : false,
    auth: {
      user: EMAIL_IMAP_USERNAME,
      pass: EMAIL_IMAP_PASSWORD,
    },
  });

  const trashPath = (EMAIL_IMAP_TRASH_MAILBOX || 'Trash').trim() || 'Trash';
  let trashFolder = await dbGet('SELECT id, path FROM folders WHERE path = ? LIMIT 1;', trashPath);
  if (!trashFolder?.id) {
    await dbRun('INSERT INTO folders (name, path) VALUES (?, ?);', trashPath, trashPath);
    trashFolder = await dbGet('SELECT id, path FROM folders WHERE path = ? LIMIT 1;', trashPath);
  }
  const trashFolderId = Number(trashFolder?.id || 0);

  const movedIds = new Set<number>();
  const movedUidById = new Map<number, number>();
  const errors: string[] = [];
  try {
    await withTimeout('IMAP connect', client.connect(), EMAIL_IMAP_OPERATION_TIMEOUT_MS);
    for (const [folderPath, entries] of folderMap.entries()) {
      if (!entries.length) continue;
      const uids = entries.map((entry) => entry.uid);
      try {
        await withTimeout(
          `IMAP mailboxOpen(${folderPath})`,
          client.mailboxOpen(folderPath, { readOnly: false }),
          EMAIL_IMAP_OPERATION_TIMEOUT_MS,
        );
        const moveResult: any = await withTimeout(
          `IMAP messageMove(${folderPath})`,
          client.messageMove(uids, trashPath, { uid: true }),
          EMAIL_IMAP_OPERATION_TIMEOUT_MS,
        );
        const uidMap =
          moveResult && moveResult.uidMap && typeof moveResult.uidMap.get === 'function'
            ? moveResult.uidMap
            : null;
        for (const entry of entries) {
          if (uidMap) {
            const mapped = Number(uidMap.get(entry.uid));
            if (Number.isFinite(mapped) && mapped > 0) {
              movedIds.add(entry.id);
              movedUidById.set(entry.id, mapped);
            } else {
              errors.push(`${folderPath}: UID ${entry.uid} was not moved`);
            }
            continue;
          }
          movedIds.add(entry.id);
          movedUidById.set(entry.id, entry.uid);
        }
      } catch (err: any) {
        errors.push(`${folderPath}: ${err?.message || 'move failed'}`);
      }
    }
  } finally {
    await withTimeout('IMAP logout', client.logout(), EMAIL_IMAP_OPERATION_TIMEOUT_MS).catch(() => {});
  }

  if (trashFolderId > 0 && movedIds.size > 0) {
    for (const id of movedIds) {
      const movedUid = movedUidById.get(id);
      if (movedUid && Number.isFinite(movedUid) && movedUid > 0) {
        await dbRun(
          'UPDATE email_messages SET folder_id = ?, server_uid = ? WHERE id = ?;',
          trashFolderId,
          movedUid,
          id,
        );
      } else {
        await dbRun(
          'UPDATE email_messages SET folder_id = ? WHERE id = ?;',
          trashFolderId,
          id,
        );
      }
    }
  }

  const skipped = missing.length + (foundIds.size - movedIds.size);
  return {
    requested: ids.length,
    found: foundIds.size,
    deleted: movedIds.size,
    skipped: skipped,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function deleteTrash() {
  if (!EMAIL_IMAP_HOST || !EMAIL_IMAP_USERNAME || !EMAIL_IMAP_PASSWORD) {
    throw new Error('IMAP settings are missing.');
  }

  const trashFolders = await dbAll(
    `SELECT id, name, path FROM folders
     WHERE LOWER(name) = 'trash'
        OR LOWER(path) = 'trash'
        OR LOWER(name) LIKE '%trash%'
        OR LOWER(path) LIKE '%trash%';`,
  );

  if (!trashFolders.length) {
    return { deleted: 0, skipped: 0, found: 0 };
  }

  const folderIds = trashFolders.map((row) => row.id);
  const placeholders = folderIds.map(() => '?').join(', ');
  const rows = await dbAll(
    `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
     FROM email_messages
     INNER JOIN folders ON email_messages.folder_id = folders.id
     WHERE email_messages.folder_id IN (${placeholders});`,
    ...folderIds,
  );

  if (!rows.length) {
    return { deleted: 0, skipped: 0, found: 0 };
  }

  const folderMap = new Map<string, number[]>();
  for (const row of rows) {
    const uid = Number(row?.server_uid);
    const folderPath = row?.folder_path ? String(row.folder_path) : '';
    if (!Number.isFinite(uid) || uid <= 0 || !folderPath) {
      continue;
    }
    if (!folderMap.has(folderPath)) {
      folderMap.set(folderPath, []);
    }
    folderMap.get(folderPath)?.push(uid);
  }

  const client = new ImapFlow({
    host: EMAIL_IMAP_HOST,
    port: EMAIL_IMAP_PORT,
    secure: EMAIL_IMAP_SECURE,
    logger: DEBUG ? undefined : false,
    auth: {
      user: EMAIL_IMAP_USERNAME,
      pass: EMAIL_IMAP_PASSWORD,
    },
  });

  const deletedIds = new Set<number>();
  const errors: string[] = [];
  try {
    await client.connect();
    for (const [folderPath, uids] of folderMap.entries()) {
      if (!uids.length) continue;
      try {
        await client.mailboxOpen(folderPath, { readOnly: false });
        for (const chunk of chunkUids(uids, 200)) {
          await client.messageDelete(chunk, { uid: true });
        }
        for (const row of rows) {
          if (row?.folder_path === folderPath) {
            const id = Number(row?.id);
            if (Number.isFinite(id) && id > 0) {
              deletedIds.add(id);
            }
          }
        }
      } catch (err: any) {
        errors.push(`${folderPath}: ${err?.message || 'delete failed'}`);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const deleted = Array.from(deletedIds);
  if (deleted.length > 0) {
    const deletedPlaceholders = deleted.map(() => '?').join(', ');
    await deleteAttachmentFiles(deleted);
    await dbRun(
      `DELETE FROM email_attachments WHERE email_id IN (${deletedPlaceholders});`,
      ...deleted,
    );
    await dbRun(
      `DELETE FROM email_messages WHERE id IN (${deletedPlaceholders});`,
      ...deleted,
    );
  }

  const skipped = rows.length - deletedIds.size;
  return {
    deleted: deletedIds.size,
    skipped,
    found: rows.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function deleteFolder(payload: { name: string }) {
  if (!EMAIL_IMAP_HOST || !EMAIL_IMAP_USERNAME || !EMAIL_IMAP_PASSWORD) {
    throw new Error('IMAP settings are missing.');
  }
  const folderName = payload.name.trim();
  if (!folderName) {
    return { deleted: 0, skipped: 0, found: 0 };
  }
  const loweredName = folderName.toLowerCase();
  if (loweredName === 'inbox' || loweredName === 'sent') {
    throw new Error(`${loweredName === 'sent' ? 'Sent folder' : 'Inbox'} cannot be emptied.`);
  }

  const exactMatches = await dbAll(
    `SELECT id, name, path FROM folders
     WHERE LOWER(name) = ? OR LOWER(path) = ?;`,
    folderName.toLowerCase(),
    folderName.toLowerCase(),
  );

  const filteredExact = exactMatches.filter(
    (row) =>
      String(row?.name || '').toLowerCase() !== 'inbox' &&
      String(row?.path || '').toLowerCase() !== 'inbox' &&
      String(row?.name || '').toLowerCase() !== 'sent' &&
      String(row?.path || '').toLowerCase() !== 'sent',
  );

  const folders =
    filteredExact.length > 0
      ? filteredExact
      : await dbAll(
          `SELECT id, name, path FROM folders
           WHERE LOWER(name) LIKE ? OR LOWER(path) LIKE ?;`,
          `%${folderName.toLowerCase()}%`,
          `%${folderName.toLowerCase()}%`,
        );

  const filteredFolders = folders.filter(
    (row: any) =>
      String(row?.name || '').toLowerCase() !== 'inbox' &&
      String(row?.path || '').toLowerCase() !== 'inbox' &&
      String(row?.name || '').toLowerCase() !== 'sent' &&
      String(row?.path || '').toLowerCase() !== 'sent',
  );

  if (!filteredFolders.length) {
    return { deleted: 0, skipped: 0, found: 0 };
  }

  const folderIds = filteredFolders.map((row) => row.id);
  const placeholders = folderIds.map(() => '?').join(', ');
  const rows = await dbAll(
    `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
     FROM email_messages
     INNER JOIN folders ON email_messages.folder_id = folders.id
     WHERE email_messages.folder_id IN (${placeholders});`,
    ...folderIds,
  );

  if (!rows.length) {
    return { deleted: 0, skipped: 0, found: 0 };
  }

  const folderMap = new Map<string, number[]>();
  for (const row of rows) {
    const uid = Number(row?.server_uid);
    const folderPath = row?.folder_path ? String(row.folder_path) : '';
    if (!Number.isFinite(uid) || uid <= 0 || !folderPath) {
      continue;
    }
    if (!folderMap.has(folderPath)) {
      folderMap.set(folderPath, []);
    }
    folderMap.get(folderPath)?.push(uid);
  }

  const client = new ImapFlow({
    host: EMAIL_IMAP_HOST,
    port: EMAIL_IMAP_PORT,
    secure: EMAIL_IMAP_SECURE,
    logger: DEBUG ? undefined : false,
    auth: {
      user: EMAIL_IMAP_USERNAME,
      pass: EMAIL_IMAP_PASSWORD,
    },
  });

  const deletedIds = new Set<number>();
  const errors: string[] = [];
  try {
    await client.connect();
    for (const [folderPath, uids] of folderMap.entries()) {
      if (!uids.length) continue;
      try {
        await client.mailboxOpen(folderPath, { readOnly: false });
        for (const chunk of chunkUids(uids, 200)) {
          await client.messageDelete(chunk, { uid: true });
        }
        for (const row of rows) {
          if (row?.folder_path === folderPath) {
            const id = Number(row?.id);
            if (Number.isFinite(id) && id > 0) {
              deletedIds.add(id);
            }
          }
        }
      } catch (err: any) {
        errors.push(`${folderPath}: ${err?.message || 'delete failed'}`);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const deleted = Array.from(deletedIds);
  if (deleted.length > 0) {
    const deletedPlaceholders = deleted.map(() => '?').join(', ');
    await deleteAttachmentFiles(deleted);
    await dbRun(
      `DELETE FROM email_attachments WHERE email_id IN (${deletedPlaceholders});`,
      ...deleted,
    );
    await dbRun(
      `DELETE FROM email_messages WHERE id IN (${deletedPlaceholders});`,
      ...deleted,
    );
  }

  const skipped = rows.length - deletedIds.size;
  return {
    deleted: deletedIds.size,
    skipped,
    found: rows.length,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function markMailRead(payload: { all?: boolean; ids?: number[]; folder?: string; limit?: number }) {
  if (!EMAIL_IMAP_HOST || !EMAIL_IMAP_USERNAME || !EMAIL_IMAP_PASSWORD) {
    throw new Error('IMAP settings are missing.');
  }

  const ids = Array.from(new Set(payload.ids || []))
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0);
  const folderRaw = String(payload.folder || '').trim();
  const folder = folderRaw.toLowerCase();
  const limit = Number.isFinite(Number(payload.limit)) ? Math.floor(Number(payload.limit)) : 0;

  let rows: any[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    rows = await dbAll(
      `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
       FROM email_messages
       INNER JOIN folders ON email_messages.folder_id = folders.id
       WHERE email_messages.id IN (${placeholders})
         AND COALESCE(email_messages.is_seen, 0) = 0;`,
      ...ids,
    );
  } else if (folder) {
    rows = await dbAll(
      `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
       FROM email_messages
       INNER JOIN folders ON email_messages.folder_id = folders.id
       WHERE (LOWER(folders.name) = ? OR LOWER(folders.path) = ?)
         AND COALESCE(email_messages.is_seen, 0) = 0;`,
      folder,
      folder,
    );
  } else if (limit > 0) {
    rows = await dbAll(
      `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
       FROM email_messages
       INNER JOIN folders ON email_messages.folder_id = folders.id
       WHERE email_messages.received_at IS NOT NULL
         AND COALESCE(email_messages.is_seen, 0) = 0
       ORDER BY email_messages.received_at DESC
       LIMIT ?;`,
      limit,
    );
  } else {
    rows = await dbAll(
      `SELECT email_messages.id as id, email_messages.server_uid as server_uid, folders.path as folder_path
       FROM email_messages
       INNER JOIN folders ON email_messages.folder_id = folders.id
       WHERE COALESCE(email_messages.is_seen, 0) = 0;`,
    );
  }

  const validRows = rows.filter((row) => {
    const id = Number(row?.id);
    const uid = Number(row?.server_uid);
    const folderPath = row?.folder_path ? String(row.folder_path) : '';
    return Number.isFinite(id) && id > 0 && Number.isFinite(uid) && uid > 0 && folderPath.length > 0;
  });
  if (validRows.length === 0) {
    return { requested: ids.length || rows.length, found: 0, marked: 0, skipped: 0 };
  }

  const folderMap = new Map<string, Array<{ id: number; uid: number }>>();
  for (const row of validRows) {
    const folderPath = String(row.folder_path);
    const id = Number(row.id);
    const uid = Number(row.server_uid);
    if (!folderMap.has(folderPath)) {
      folderMap.set(folderPath, []);
    }
    folderMap.get(folderPath)?.push({ id, uid });
  }

  const client = new ImapFlow({
    host: EMAIL_IMAP_HOST,
    port: EMAIL_IMAP_PORT,
    secure: EMAIL_IMAP_SECURE,
    logger: DEBUG ? undefined : false,
    auth: {
      user: EMAIL_IMAP_USERNAME,
      pass: EMAIL_IMAP_PASSWORD,
    },
  });

  const markedIds = new Set<number>();
  const errors: string[] = [];
  try {
    await client.connect();
    for (const [folderPath, entries] of folderMap.entries()) {
      if (!entries.length) continue;
      const uids = entries.map((entry) => entry.uid);
      const idsByUid = new Map<number, number[]>();
      for (const entry of entries) {
        if (!idsByUid.has(entry.uid)) {
          idsByUid.set(entry.uid, []);
        }
        idsByUid.get(entry.uid)?.push(entry.id);
      }
      try {
        await client.mailboxOpen(folderPath, { readOnly: false });
        for (const chunk of chunkUids(uids, 200)) {
          await client.messageFlagsAdd(chunk, ['\\Seen'], { uid: true });
          for (const uid of chunk) {
            const idsForUid = idsByUid.get(uid) || [];
            for (const id of idsForUid) {
              markedIds.add(id);
            }
          }
        }
      } catch (err: any) {
        errors.push(`${folderPath}: ${err?.message || 'mark read failed'}`);
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const marked = Array.from(markedIds);
  if (marked.length > 0) {
    const placeholders = marked.map(() => '?').join(', ');
    await dbRun(
      `UPDATE email_messages SET is_seen = 1 WHERE id IN (${placeholders});`,
      ...marked,
    );
  }

  const found = validRows.length;
  const skipped = found - marked.length;
  return {
    requested: ids.length > 0 ? ids.length : found,
    found,
    marked: marked.length,
    skipped,
    errors: errors.length > 0 ? errors : undefined,
  };
}

async function initDb() {
  await mkdir(dirname(DB_PATH), { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  dbGet = promisify(db.get.bind(db));
  dbRun = promisify(db.run.bind(db));
  dbAll = promisify(db.all.bind(db));
  const dbExec = promisify(db.exec.bind(db));

  await dbExec('PRAGMA foreign_keys = ON;');
  await dbExec(`
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
      html_body TEXT,
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

    CREATE TABLE IF NOT EXISTS llm_sql_cache (
      key TEXT PRIMARY KEY,
      sql TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

    CREATE TABLE IF NOT EXISTS email_llm_summaries (
      email_id INTEGER PRIMARY KEY,
      summary TEXT NOT NULL,
      model TEXT,
      raw_response TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(email_id) REFERENCES email_messages(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS blocked_senders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      pattern TEXT NOT NULL UNIQUE,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
  `);

  const columns = await dbAll("PRAGMA table_info('email_messages');");
  const hasToRaw = columns.some((col) => col?.name === 'to_raw');
  if (!hasToRaw) {
    await dbExec('ALTER TABLE email_messages ADD COLUMN to_raw TEXT;');
  }
  const hasIsSeen = columns.some((col) => col?.name === 'is_seen');
  if (!hasIsSeen) {
    await dbExec('ALTER TABLE email_messages ADD COLUMN is_seen INTEGER NOT NULL DEFAULT 1;');
    await dbExec('UPDATE email_messages SET is_seen = 1;');
  }
  const hasHtmlBody = columns.some((col) => col?.name === 'html_body');
  if (!hasHtmlBody) {
    await dbExec('ALTER TABLE email_messages ADD COLUMN html_body TEXT;');
  }
}

async function start() {
  // eslint-disable-next-line no-console
  console.log('[email-micro-service] starting...');
  await initDb();
  // eslint-disable-next-line no-console
  console.log('[email-micro-service] sqlite ready');
  // eslint-disable-next-line no-console
  console.log(`[email-micro-service] attachment storage mode ${getAttachmentStorageMode()}`);

  const emailSync = createEmailSync({
    dbGet,
    dbRun,
    dbAll,
    debug: DEBUG,
    attachmentsDir: ATTACHMENTS_DIR,
    trashMailboxPath: EMAIL_IMAP_TRASH_MAILBOX,
    onMailChange: (payload) => broadcastEvent(payload),
    imapConfig: {
      host: EMAIL_IMAP_HOST,
      port: EMAIL_IMAP_PORT,
      secure: EMAIL_IMAP_SECURE,
      auth: {
        user: EMAIL_IMAP_USERNAME,
        pass: EMAIL_IMAP_PASSWORD,
      },
    },
  });

  const { broadcastEvent } = registerEndpoints({
    app,
    dbGet,
    dbRun,
    dbAll,
    syncMail: async () => {
      await emailSync.syncIfNeeded();
    },
    sendMail: async (payload) => sendMail(payload),
    deleteMail: async (payload) => deleteMail(payload),
    markAsRead: async (payload) => markMailRead(payload),
    deleteTrash: async () => deleteTrash(),
    deleteFolder: async (payload) => deleteFolder(payload),
    skipAuth: SKIP_AUTH,
    authToken: AUTH_BEARER_TOKEN,
  });

  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[email-micro-service] listening on port ${PORT}`);
  });

  const runStartupSync = async () => {
    // eslint-disable-next-line no-console
    console.log('[email-micro-service] initial sync starting');
    const resyncFlagPath = './data/.resync_done';
    let hasResynced = false;
    try {
      await access(resyncFlagPath);
      hasResynced = true;
    } catch {
      hasResynced = false;
    }
    if (!hasResynced) {
      await emailSync.forceResyncAll();
      await writeFile(resyncFlagPath, 'ok');
    } else {
      await emailSync.syncIfNeeded();
    }
    // eslint-disable-next-line no-console
    console.log('[email-micro-service] initial sync complete');
  };

  runStartupSync()
    .catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[email-micro-service] initial sync failed:', err);
    })
    .finally(() => {
      emailSync.startWatcher();
    });
}

start().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start service:', err);
  process.exit(1);
});
