import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import PDFParser from 'pdf2json';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

dotenv.config();

const app = express();
app.use(express.json({ limit: '100mb' }));

const PORT = Number.parseInt(process.env.PORT || '3224', 10);
const SKIP_AUTH = String(process.env.SKIP_AUTH || 'false').toLowerCase() === 'true';
const AUTH_BEARER_TOKEN = process.env.AUTH_BEARER_TOKEN || '';
const DB_PATH = process.env.DB_PATH || './data/files.db';
const FILE_KEY_PREFIX = (process.env.FILE_KEY_PREFIX || 'uploads').replace(/^\/+|\/+$/g, '');
const PDF_DEFAULT_PASSWORD = process.env.PDF_DEFAULT_PASSWORD || '7609085080084';
const ASSISTANT_URL = (process.env.ASSISTANT_URL || '').trim();
const ASSISTANT_AUTH = (process.env.ASSISTANT_AUTH ?? process.env.AUTH ?? '').trim().replace(/^Bearer\s+/i, '');
const ASSISTANT_MODEL = (process.env.ASSISTANT_MODEL || 'qwen2.5:14b').trim();
const ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.ASSISTANT_TIMEOUT_MS || '120000', 10);
const FILE_SUMMARY_TEXT_LIMIT = Number.parseInt(process.env.FILE_SUMMARY_TEXT_LIMIT || '12000', 10);

const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://192.168.55.113:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'aiassist';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'MASEHARRE@123';
const S3_DEFAULT_BUCKET = process.env.S3_DEFAULT_BUCKET || 'files';
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';

const s3 = new S3Client({
  region: S3_REGION,
  endpoint: S3_ENDPOINT,
  forcePathStyle: S3_FORCE_PATH_STYLE,
  credentials: {
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
  },
});

const readyBuckets = new Set<string>();
let db: sqlite3.Database;
let dbGet: (sql: string, ...params: unknown[]) => Promise<any>;
let dbRun: (sql: string, ...params: unknown[]) => Promise<void>;
let dbAll: (sql: string, ...params: unknown[]) => Promise<any[]>;

function authMiddleware(req: Request, res: Response, next: NextFunction) {
  if (SKIP_AUTH) {
    next();
    return;
  }
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  if (!AUTH_BEARER_TOKEN || token !== AUTH_BEARER_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }
  next();
}

function resolveBucket(value?: unknown): string {
  const bucket = typeof value === 'string' ? value.trim() : '';
  return bucket || S3_DEFAULT_BUCKET;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function sanitizeFilename(value?: string | null): string {
  if (!value || value.trim().length === 0) {
    return 'file.bin';
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function sanitizePathSegment(value?: string | null): string {
  const normalized = String(value || '').trim().toLowerCase().replace(/[^a-z0-9._-]/g, '-');
  return normalized || 'unknown';
}

function safeSummarySnippet(value: string, maxLength: number = 512): string {
  const normalized = String(value || '').replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalized) {
    return '';
  }
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3))}...`;
}

function metadataValue(value: unknown, maxLength: number): string | undefined {
  const raw = String(value ?? '').trim();
  if (!raw) {
    return undefined;
  }
  return safeSummarySnippet(raw, maxLength);
}

function isPdfAttachment(contentType: string, filename: string): boolean {
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  return type.includes('pdf') || name.endsWith('.pdf');
}

function isPdfPasswordError(err: unknown): boolean {
  const message = String((err as { message?: unknown })?.message || '').toLowerCase();
  return message.includes('password') || message.includes('encrypted');
}

function trimForSummary(value: string, maxChars: number): string {
  if (!value) {
    return '';
  }
  if (!Number.isFinite(maxChars) || maxChars <= 0) {
    return value;
  }
  if (value.length <= maxChars) {
    return value;
  }
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}

function parseAssistantSummary(raw: string): string | null {
  try {
    const outer = JSON.parse(raw) as any;
    let content = '';
    if (typeof outer?.msg === 'string') {
      const msgBody = JSON.parse(outer.msg);
      if (typeof msgBody?.message?.content === 'string') {
        content = msgBody.message.content;
      }
    } else if (typeof outer?.message?.content === 'string') {
      content = outer.message.content;
    } else if (typeof outer?.content === 'string') {
      content = outer.content;
    }
    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as { ai_summary?: unknown; summary?: unknown };
    const summary = String(parsed?.ai_summary ?? parsed?.summary ?? '')
      .replace(/^ai\s*summary\s*:\s*/i, '')
      .replace(/\s+/g, ' ')
      .trim();
    return summary || null;
  } catch {
    return null;
  }
}

async function extractPdfTextWithPassword(pdfBuffer: Buffer, password?: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const parser = new PDFParser(undefined, true, password || undefined);
    parser.on('pdfParser_dataError', (errData: any) => {
      const reason =
        errData?.parserError?.message ||
        errData?.parserError ||
        errData?.message ||
        'PDF parse failed';
      reject(new Error(String(reason)));
    });
    parser.on('pdfParser_dataReady', () => {
      try {
        const content = parser.getRawTextContent();
        resolve(normalizeWhitespace(content || ''));
      } catch (error: any) {
        reject(new Error(error?.message || 'Failed to read extracted PDF text'));
      }
    });
    try {
      parser.parseBuffer(pdfBuffer, 0);
    } catch (error: any) {
      reject(new Error(error?.message || 'Unable to parse PDF buffer'));
    }
  });
}

async function extractPdfTextFromBuffer(pdfBuffer: Buffer): Promise<string> {
  try {
    return await extractPdfTextWithPassword(pdfBuffer);
  } catch (firstError: unknown) {
    if (!isPdfPasswordError(firstError) || !PDF_DEFAULT_PASSWORD) {
      throw firstError;
    }
    return await extractPdfTextWithPassword(pdfBuffer, PDF_DEFAULT_PASSWORD);
  }
}

async function sendSummaryRequestToAssistant(payload: Record<string, unknown>): Promise<string | null> {
  if (!ASSISTANT_URL) {
    return null;
  }
  const authorizationHeader = ASSISTANT_AUTH ? `Bearer ${ASSISTANT_AUTH}` : '';
  const url = ASSISTANT_URL.match(/^https?:\/\//i) ? ASSISTANT_URL : `http://${ASSISTANT_URL}`;
  const controller = new AbortController();
  const timeoutMs =
    Number.isFinite(ASSISTANT_TIMEOUT_MS) && ASSISTANT_TIMEOUT_MS > 0 ? ASSISTANT_TIMEOUT_MS : 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const messagePayload = {
      Authorization: ASSISTANT_AUTH,
      authorization: ASSISTANT_AUTH,
      model: ASSISTANT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You summarize files. Return ONLY valid JSON: {"ai_summary":"..."}',
        },
        {
          role: 'user',
          content: [
            'Create a concise summary for the uploaded file.',
            'Use extracted text when available, else use filename/content type/caption.',
            'Do not include labels and return summary text only.',
            `Payload: ${JSON.stringify(payload)}`,
          ].join('\n'),
        },
      ],
      temperature: 0.2,
      stream: false,
      format: 'json',
    };
    const requestBody = {
      from: 'custom-prompt',
      message: JSON.stringify(messagePayload),
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(authorizationHeader ? { Authorization: authorizationHeader } : {}),
      },
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      return null;
    }
    return raw;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBucketExists(bucket: string): Promise<void> {
  if (readyBuckets.has(bucket)) {
    return;
  }
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
  }
  readyBuckets.add(bucket);
}

function toUploadKey(args: { source?: string; filename?: string; providedKey?: string }): string {
  if (args.providedKey && args.providedKey.trim().length > 0) {
    return args.providedKey.trim().replace(/^\/+/, '');
  }
  const source = sanitizePathSegment(args.source || 'unknown');
  const safeName = sanitizeFilename(args.filename || null);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const random = crypto.randomBytes(4).toString('hex');
  return `${FILE_KEY_PREFIX}/${source}/${stamp}_${random}_${safeName}`;
}

async function initDb(): Promise<void> {
  await mkdir(path.dirname(path.resolve(DB_PATH)), { recursive: true });
  db = new sqlite3.Database(DB_PATH);
  dbGet = promisify(db.get.bind(db));
  dbRun = promisify(db.run.bind(db)) as unknown as (sql: string, ...params: unknown[]) => Promise<void>;
  dbAll = promisify(db.all.bind(db));
  await dbRun(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      source_message_id TEXT,
      source_sender TEXT,
      bucket TEXT NOT NULL,
      s3_key TEXT NOT NULL UNIQUE,
      filename TEXT,
      content_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      caption TEXT,
      metadata_json TEXT,
      pdf_text TEXT,
      pdf_text_length INTEGER NOT NULL DEFAULT 0,
      pdf_extractor TEXT,
      summary TEXT,
      summary_model TEXT,
      summary_raw_response TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_source_sender ON files(source_sender);');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_source_message ON files(source_message_id);');
}

async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (!body) {
    return Buffer.alloc(0);
  }
  if (Buffer.isBuffer(body)) {
    return body;
  }
  if (typeof body === 'string') {
    return Buffer.from(body);
  }
  if (body instanceof Uint8Array) {
    return Buffer.from(body);
  }
  if (body && typeof body === 'object' && 'transformToByteArray' in body) {
    const bytes = await (body as any).transformToByteArray();
    return Buffer.from(bytes);
  }
  if (body && typeof body === 'object' && Symbol.asyncIterator in (body as any)) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  return Buffer.alloc(0);
}

app.get('/health', authMiddleware, async (_req, res) => {
  try {
    const bucket = resolveBucket(undefined);
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    const row = await dbGet('SELECT COUNT(*) AS count FROM files;');
    const filesCount = Number(row?.count || 0);
    res.json({ status: 'ok', bucket, endpoint: S3_ENDPOINT, db_path: DB_PATH, files_count: filesCount });
  } catch (err: any) {
    res.status(503).json({ status: 'error', message: err?.message || 'S3 unavailable' });
  }
});

app.post('/bucket/create', authMiddleware, async (req, res) => {
  try {
    const bucket = resolveBucket(req.body?.bucket);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    res.status(201).json({ success: true, bucket });
  } catch (err: any) {
    const message = String(err?.message || 'create bucket failed');
    if (message.toLowerCase().includes('already owned') || message.toLowerCase().includes('already exists')) {
      res.status(200).json({ success: true, bucket: resolveBucket(req.body?.bucket), exists: true });
      return;
    }
    res.status(500).json({ success: false, message });
  }
});

app.post('/file/upload', authMiddleware, async (req, res) => {
  try {
    const bucket = resolveBucket(req.body?.bucket);
    const providedKey = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const dataBase64Raw = typeof req.body?.data_base64 === 'string' ? req.body.data_base64.trim() : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type.trim() : 'application/octet-stream';
    const filename = sanitizeFilename(typeof req.body?.filename === 'string' ? req.body.filename.trim() : '');
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const sourceSender = typeof req.body?.source_sender === 'string' ? req.body.source_sender.trim() : '';
    const sourceMessageId =
      typeof req.body?.source_message_id === 'string' ? req.body.source_message_id.trim() : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const key = toUploadKey({ source, filename, providedKey });
    const dataBase64 = dataBase64Raw.startsWith('data:') && dataBase64Raw.includes(',')
      ? dataBase64Raw.split(',').pop() || ''
      : dataBase64Raw;

    if (!dataBase64) {
      res.status(400).json({ success: false, message: 'data_base64 is required' });
      return;
    }

    const bytes = Buffer.from(dataBase64, 'base64');
    await ensureBucketExists(bucket);
    const baseMetadata: Record<string, string> = {
      ...(metadataValue(source, 64) ? { source: metadataValue(source, 64)! } : {}),
      ...(metadataValue(sourceSender, 128) ? { source_sender: metadataValue(sourceSender, 128)! } : {}),
      ...(metadataValue(sourceMessageId, 128) ? { source_message_id: metadataValue(sourceMessageId, 128)! } : {}),
      ...(metadataValue(caption, 256) ? { caption: metadataValue(caption, 256)! } : {}),
    };
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        Metadata: baseMetadata,
      }),
    );

    let extractedPdfText = '';
    if (isPdfAttachment(contentType, filename)) {
      try {
        extractedPdfText = normalizeWhitespace(await extractPdfTextFromBuffer(bytes));
      } catch {
        extractedPdfText = '';
      }
    }

    let summary: string | null = null;
    let summaryRawResponse = '';
    if (ASSISTANT_URL) {
      const summaryPayload = {
        source: source || null,
        source_sender: sourceSender || null,
        source_message_id: sourceMessageId || null,
        filename,
        content_type: contentType,
        size_bytes: bytes.length,
        caption: caption || '',
        extracted_text: trimForSummary(extractedPdfText, FILE_SUMMARY_TEXT_LIMIT),
      };
      const raw = await sendSummaryRequestToAssistant(summaryPayload);
      if (raw) {
        summaryRawResponse = raw;
        summary = parseAssistantSummary(raw);
      }
    }

    if (summary) {
      const metadataWithSummary: Record<string, string> = {
        ...baseMetadata,
        ...(metadataValue(summary, 512) ? { summary: metadataValue(summary, 512)! } : {}),
      };
      await s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: bytes,
          ContentType: contentType,
          Metadata: metadataWithSummary,
        }),
      );
    }

    await dbRun(
      `INSERT INTO files (
        source,
        source_message_id,
        source_sender,
        bucket,
        s3_key,
        filename,
        content_type,
        size_bytes,
        caption,
        metadata_json,
        pdf_text,
        pdf_text_length,
        pdf_extractor,
        summary,
        summary_model,
        summary_raw_response,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(s3_key) DO UPDATE SET
        source = excluded.source,
        source_message_id = excluded.source_message_id,
        source_sender = excluded.source_sender,
        bucket = excluded.bucket,
        filename = excluded.filename,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        caption = excluded.caption,
        metadata_json = excluded.metadata_json,
        pdf_text = excluded.pdf_text,
        pdf_text_length = excluded.pdf_text_length,
        pdf_extractor = excluded.pdf_extractor,
        summary = excluded.summary,
        summary_model = excluded.summary_model,
        summary_raw_response = excluded.summary_raw_response,
        updated_at = CURRENT_TIMESTAMP;`,
      source || null,
      sourceMessageId || null,
      sourceSender || null,
      bucket,
      key,
      filename || null,
      contentType,
      bytes.length,
      caption || null,
      JSON.stringify(summary ? { ...baseMetadata, summary: safeSummarySnippet(summary, 512) } : baseMetadata),
      extractedPdfText || null,
      extractedPdfText.length,
      extractedPdfText ? 'pdf2json' : null,
      summary,
      summary ? ASSISTANT_MODEL : null,
      summaryRawResponse || null,
    );

    const record = await dbGet('SELECT * FROM files WHERE s3_key = ? LIMIT 1;', key);
    res.status(201).json({
      success: true,
      bucket,
      key,
      bytes: bytes.length,
      content_type: contentType,
      file_id: Number(record?.id || 0) || null,
      caption: caption || null,
      summary,
      pdf_text_length: extractedPdfText.length,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'upload failed' });
  }
});

app.get('/file/download', authMiddleware, async (req, res) => {
  try {
    let bucket = resolveBucket(req.query.bucket);
    let key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    const id = Number(req.query.id);
    if ((!key || !bucket) && Number.isFinite(id) && id > 0) {
      const row = await dbGet('SELECT bucket, s3_key FROM files WHERE id = ? LIMIT 1;', id);
      bucket = row?.bucket ? String(row.bucket) : bucket;
      key = row?.s3_key ? String(row.s3_key) : key;
    }
    if (!key) {
      res.status(400).json({ success: false, message: 'key or id is required' });
      return;
    }

    const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    const payload = await bodyToBuffer(result.Body);
    const contentType = result.ContentType || 'application/octet-stream';
    const filename = key.split('/').pop() || 'file.bin';

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    res.status(200).send(payload);
  } catch (err: any) {
    res.status(404).json({ success: false, message: err?.message || 'not found' });
  }
});

app.get('/file/list', authMiddleware, async (req, res) => {
  try {
    const bucket = resolveBucket(req.query.bucket);
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const rows = (out.Contents || []).map((item) => ({
      key: item.Key || '',
      size: Number(item.Size || 0),
      last_modified: item.LastModified ? item.LastModified.toISOString() : null,
      etag: item.ETag || null,
    }));
    res.json({ success: true, bucket, count: rows.length, files: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'list failed' });
  }
});

app.get('/file/records', authMiddleware, async (req, res) => {
  try {
    const limitRaw = Number(req.query.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.floor(limitRaw), 500) : 100;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const sourceSender = typeof req.query.source_sender === 'string' ? req.query.source_sender.trim() : '';
    const sourceMessageId =
      typeof req.query.source_message_id === 'string' ? req.query.source_message_id.trim() : '';
    const where: string[] = [];
    const params: unknown[] = [];
    if (source) {
      where.push('source = ?');
      params.push(source);
    }
    if (sourceSender) {
      where.push('source_sender = ?');
      params.push(sourceSender);
    }
    if (sourceMessageId) {
      where.push('source_message_id = ?');
      params.push(sourceMessageId);
    }
    const sql =
      `SELECT id, source, source_message_id, source_sender, bucket, s3_key, filename, content_type, size_bytes, caption, ` +
      `pdf_text_length, summary, created_at, updated_at FROM files ` +
      `${where.length > 0 ? `WHERE ${where.join(' AND ')} ` : ''}` +
      `ORDER BY id DESC LIMIT ?;`;
    const rows = await dbAll(sql, ...params, limit);
    res.json({ success: true, count: rows.length, files: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'records query failed' });
  }
});

app.delete('/file/delete', authMiddleware, async (req, res) => {
  try {
    let bucket = resolveBucket(req.query.bucket ?? req.body?.bucket);
    const keyCandidate = req.query.key ?? req.body?.key;
    let key = typeof keyCandidate === 'string' ? keyCandidate.trim() : '';
    const idCandidate = req.query.id ?? req.body?.id;
    const id = Number(idCandidate);
    if ((!key || !bucket) && Number.isFinite(id) && id > 0) {
      const row = await dbGet('SELECT bucket, s3_key FROM files WHERE id = ? LIMIT 1;', id);
      bucket = row?.bucket ? String(row.bucket) : bucket;
      key = row?.s3_key ? String(row.s3_key) : key;
    }
    if (!key) {
      res.status(400).json({ success: false, message: 'key or id is required' });
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await dbRun('DELETE FROM files WHERE bucket = ? AND s3_key = ?;', bucket, key);
    res.json({ success: true, bucket, key });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'delete failed' });
  }
});

async function start(): Promise<void> {
  await initDb();
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] listening on port ${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] s3 endpoint ${S3_ENDPOINT} bucket ${S3_DEFAULT_BUCKET}`);
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] sqlite ${DB_PATH}`);
  });
}

start().catch((err: any) => {
  // eslint-disable-next-line no-console
  console.error('[mservice-file] failed to start', err?.message || err);
  process.exit(1);
});
