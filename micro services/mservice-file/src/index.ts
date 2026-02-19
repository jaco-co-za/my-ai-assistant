import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import PDFParser from 'pdf2json';
import mammoth from 'mammoth';
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
app.use((req, res, next) => {
  const startedAt = Date.now();
  // eslint-disable-next-line no-console
  console.log(`[mservice-file][req] ${req.method} ${req.originalUrl} ip=${req.ip}`);
  res.on('finish', () => {
    // eslint-disable-next-line no-console
    console.log(`[mservice-file][res] ${req.method} ${req.originalUrl} ${res.statusCode} ${Date.now() - startedAt}ms`);
  });
  next();
});

const PORT = Number.parseInt(process.env.PORT || '3224', 10);
const SKIP_AUTH = String(process.env.SKIP_AUTH || 'false').toLowerCase() === 'true';
const AUTH_BEARER_TOKEN = process.env.AUTH_BEARER_TOKEN || '';
const DB_PATH = process.env.DB_PATH || './data/files.db';
const DEFAULT_OWNER = 'me';
const SONJA_OWNER = 'sonja';
const DB_PATH_ME = process.env.DB_PATH_ME || DB_PATH;
const DB_PATH_SONJA = process.env.DB_PATH_SONJA || DB_PATH.replace(/\.db$/i, '.sonja.db');
const FILE_KEY_PREFIX = (process.env.FILE_KEY_PREFIX || 'uploads').replace(/^\/+|\/+$/g, '');
const PDF_DEFAULT_PASSWORD = process.env.PDF_DEFAULT_PASSWORD || '7609085080084';
const PDF_KNOWN_PASSWORDS_ENV = (process.env.PDF_KNOWN_PASSWORDS || '').trim();
const ASSISTANT_URL = (process.env.ASSISTANT_URL || '').trim();
const ASSISTANT_AUTH = (process.env.ASSISTANT_AUTH ?? process.env.AUTH ?? '').trim().replace(/^Bearer\s+/i, '');
const ASSISTANT_MODEL = (process.env.ASSISTANT_MODEL || 'qwen2.5:14b').trim();
const IMAGE_SUMMARY_MODEL = (process.env.IMAGE_SUMMARY_MODEL || 'qwen2.5vl:3b').trim();
const IMAGE_SUMMARY_FALLBACK_MODEL = (process.env.IMAGE_SUMMARY_FALLBACK_MODEL || 'qwen2.5vl:7b').trim();
const FILE_SQL_MODEL = (process.env.FILE_SQL_MODEL || 'qwen2.5-coder:14b').trim();
const FILE_SQL_MAX_ROWS = Number.parseInt(process.env.FILE_SQL_MAX_ROWS || '50', 10);
const ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.ASSISTANT_TIMEOUT_MS || '120000', 10);
const FILE_EXTRACTION_TIMEOUT_MS = Number.parseInt(process.env.FILE_EXTRACTION_TIMEOUT_MS || '120000', 10);
const S3_OPERATION_TIMEOUT_MS = Number.parseInt(process.env.S3_OPERATION_TIMEOUT_MS || '60000', 10);
const FILE_SUMMARY_TEXT_LIMIT = Number.parseInt(process.env.FILE_SUMMARY_TEXT_LIMIT || '12000', 10);
const WHATSAPP_MESSAGE_URL = (process.env.WHATSAPP_MESSAGE_URL || '').trim();
const WHATSAPP_MESSAGE_AUTH = (process.env.WHATSAPP_MESSAGE_AUTH || '').trim();

const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://192.168.55.113:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'aiassist';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'MASEHARRE@123';
const S3_DEFAULT_BUCKET = process.env.S3_DEFAULT_BUCKET || 'files';
const S3_DEFAULT_BUCKET_SONJA = process.env.S3_DEFAULT_BUCKET_SONJA || `${S3_DEFAULT_BUCKET}-sonja`;
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';
const S3_BROWSER_BASE_URL = (process.env.S3_BROWSER_BASE_URL || 'http://192.168.55.113:9001').trim();
const FILE_DEDUP_ENABLED = String(process.env.FILE_DEDUP_ENABLED || 'true').toLowerCase() !== 'false';

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
type DbContext = {
  owner: string;
  path: string;
  db: sqlite3.Database;
  dbGet: (sql: string, ...params: unknown[]) => Promise<any>;
  dbRun: (sql: string, ...params: unknown[]) => Promise<void>;
  dbAll: (sql: string, ...params: unknown[]) => Promise<any[]>;
};
const dbContexts = new Map<string, DbContext>();

type SummaryStatus = 'pending' | 'completed' | 'failed' | 'skipped';
type ContentScope = 'business' | 'personal';

type FileSqlPlan = {
  delivery: 'attach' | 'none';
  sql: string;
};

type DateConstraint = {
  clause: string;
  params: string[];
};

const BUSINESS_KEYWORDS = [
  'invoice',
  'receipt',
  'quote',
  'quotation',
  'statement',
  'bank',
  'contract',
  'agreement',
  'proposal',
  'purchase order',
  'order',
  'shipping',
  'delivery note',
  'tax',
  'vat',
  'company',
  'client',
  'customer',
  'project',
  'meeting',
  'report',
  'timesheet',
  'payslip',
  'cv',
  'resume',
];

const PERSONAL_KEYWORDS = [
  'selfie',
  'family',
  'holiday',
  'vacation',
  'birthday',
  'wedding',
  'baby',
  'kids',
  'husband',
  'wife',
  'friend',
  'pet',
  'dog',
  'cat',
  'beach',
  'party',
  'picnic',
  'anniversary',
  'portrait',
  'instagram',
];

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

function normalizeOwner(value: unknown): string {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) {
    return DEFAULT_OWNER;
  }
  return raw.includes(SONJA_OWNER) ? SONJA_OWNER : DEFAULT_OWNER;
}

function resolveDbPath(owner: string): string {
  return normalizeOwner(owner) === SONJA_OWNER ? DB_PATH_SONJA : DB_PATH_ME;
}

function resolveDefaultBucketForOwner(owner: string): string {
  return normalizeOwner(owner) === SONJA_OWNER ? S3_DEFAULT_BUCKET_SONJA : S3_DEFAULT_BUCKET;
}

function resolveBucket(value?: unknown, owner: string = DEFAULT_OWNER): string {
  const bucket = typeof value === 'string' ? value.trim() : '';
  return bucket || resolveDefaultBucketForOwner(owner);
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

function isWordAttachment(contentType: string, filename: string): boolean {
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  return (
    type.includes('application/msword') ||
    type.includes('application/vnd.openxmlformats-officedocument.wordprocessingml.document') ||
    name.endsWith('.docx') ||
    name.endsWith('.doc')
  );
}

function isImageAttachment(contentType: string, filename: string): boolean {
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  return (
    type.startsWith('image/') ||
    name.endsWith('.png') ||
    name.endsWith('.jpg') ||
    name.endsWith('.jpeg') ||
    name.endsWith('.gif') ||
    name.endsWith('.webp') ||
    name.endsWith('.bmp')
  );
}

function normalizeContentScope(value: unknown): ContentScope {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'personal' ? 'personal' : 'business';
}

function keywordScore(text: string, keywords: string[]): number {
  const normalized = String(text || '').toLowerCase();
  if (!normalized) {
    return 0;
  }
  let score = 0;
  for (const keyword of keywords) {
    if (normalized.includes(keyword)) {
      score += 1;
    }
  }
  return score;
}

function inferContentScope(args: {
  contentType?: string;
  filename?: string;
  caption?: string;
  summary?: string | null;
  extractedText?: string;
  requestedScope?: unknown;
}): ContentScope {
  const requested = String(args.requestedScope ?? '').trim().toLowerCase();
  if (requested === 'business' || requested === 'personal') {
    return requested as ContentScope;
  }

  const contentType = String(args.contentType || '');
  const filename = String(args.filename || '');
  const combinedText = [
    filename,
    args.caption || '',
    args.summary || '',
    args.extractedText || '',
  ]
    .join(' ')
    .toLowerCase();

  const businessScore = keywordScore(combinedText, BUSINESS_KEYWORDS);
  const personalScore = keywordScore(combinedText, PERSONAL_KEYWORDS);
  const isImage = isImageAttachment(contentType, filename);

  if (businessScore > personalScore) {
    return 'business';
  }
  if (personalScore > businessScore) {
    return 'personal';
  }

  // Default image uploads to personal unless business intent is explicit.
  if (isImage) {
    return businessScore > 0 ? 'business' : 'personal';
  }
  return 'business';
}

function isWhatsappChatId(value: string): boolean {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return normalized.includes('@lid') || normalized.endsWith('@c.us') || normalized.endsWith('@g.us');
}

function isPdfPasswordError(err: unknown): boolean {
  const message = String((err as { message?: unknown })?.message || '').toLowerCase();
  return message.includes('password') || message.includes('encrypted');
}

function getKnownPdfPasswords(): string[] {
  const builtIn = ['7609085080084', '7509280043087'];
  const fromEnv = PDF_KNOWN_PASSWORDS_ENV
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  const merged = [
    PDF_DEFAULT_PASSWORD.trim(),
    ...fromEnv,
    ...builtIn,
  ].filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of merged) {
    if (!seen.has(value)) {
      seen.add(value);
      out.push(value);
    }
  }
  return out;
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

function summaryIndicatesNoReadableText(summary: string): boolean {
  const text = String(summary || '').toLowerCase();
  if (!text) {
    return false;
  }
  return (
    text.includes('no text content extracted') ||
    text.includes('no readable text extracted') ||
    text.includes('no text extracted') ||
    text.includes('without any textual content extracted') ||
    text.includes('without textual content extracted') ||
    text.includes('without any text extracted') ||
    text.includes('without text extracted') ||
    (text.includes('no text') && text.includes('extracted')) ||
    text.includes('without text content') ||
    (text.includes('without') && text.includes('textual content') && text.includes('extracted'))
  );
}

function hasMeaningfulPdfText(text: string): boolean {
  const normalized = String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!normalized) {
    return false;
  }
  const cleaned = normalized
    .replace(/-+\s*page\s*\(\s*\d+\s*\)\s*break\s*-+/gi, '')
    .replace(/-+/g, '')
    .trim();
  return cleaned.length >= 20;
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
    if (!isPdfPasswordError(firstError)) {
      throw firstError;
    }
    const knownPasswords = getKnownPdfPasswords();
    let lastPasswordError: unknown = firstError;
    for (const password of knownPasswords) {
      try {
        return await extractPdfTextWithPassword(pdfBuffer, password);
      } catch (passwordError: unknown) {
        lastPasswordError = passwordError;
      }
    }
    throw lastPasswordError;
  }
}

async function extractWordTextFromBuffer(buffer: Buffer): Promise<string> {
  const result = await mammoth.extractRawText({ buffer });
  return normalizeWhitespace(result.value || '');
}

async function sendSummaryRequestToAssistant(
  payload: Record<string, unknown>,
  options?: { model?: string; imageBase64?: string },
): Promise<string | null> {
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
    const userLines = [
      'Create a concise summary for the uploaded file.',
      'Use extracted text when available, else use filename/content type/caption.',
      'For images, infer key visible details directly from the image.',
      'Do not include labels and return summary text only.',
      `Payload: ${JSON.stringify(payload)}`,
    ];
    const userMessage: Record<string, unknown> = {
      role: 'user',
      content: userLines.join('\n'),
    };
    if (options?.imageBase64) {
      userMessage.images = [options.imageBase64];
    }
    const messagePayload = {
      Authorization: ASSISTANT_AUTH,
      authorization: ASSISTANT_AUTH,
      model: options?.model || ASSISTANT_MODEL,
      messages: [
        {
          role: 'system',
          content: 'You summarize files. Return ONLY valid JSON: {"ai_summary":"..."}',
        },
        userMessage,
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

async function sendSqlPlanRequestToAssistant(payload: Record<string, unknown>): Promise<string | null> {
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
    const schema = [
      'SQLite table: files(',
      'id INTEGER PRIMARY KEY,',
      'source TEXT, source_message_id TEXT, source_sender TEXT,',
      'bucket TEXT, s3_key TEXT, filename TEXT, content_type TEXT, size_bytes INTEGER, caption TEXT,',
      'summary TEXT, content_scope TEXT, summary_status TEXT, summary_error TEXT, created_at TEXT, updated_at TEXT',
      ')',
    ].join(' ');
    const messagePayload = {
      Authorization: ASSISTANT_AUTH,
      authorization: ASSISTANT_AUTH,
      model: FILE_SQL_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You generate SQLite SELECT for file queries. Return ONLY JSON: {"delivery":"attach|none","sql":"SELECT ..."}',
        },
        {
          role: 'user',
          content: [
            schema,
            'Rules:',
            '- SQL must be a single SELECT from files table only.',
            '- Never use INSERT/UPDATE/DELETE/PRAGMA/ATTACH.',
            '- Include ORDER BY id DESC by default.',
            '- content_scope values: business | personal.',
            '- Do not assume source/source_sender constraints unless user explicitly asks for source, sender, or channel filtering.',
            '- Prefer summary matches first when user asks about file content/topic.',
            '- Honor date constraints from the prompt (for example: today, yesterday, last 7 days, on YYYY-MM-DD, from YYYY-MM-DD to YYYY-MM-DD).',
            '- If user asks download/send/open/show file bytes, set delivery="attach"; otherwise "none".',
            `- Maximum rows returned per query is ${FILE_SQL_MAX_ROWS}.`,
            `Payload: ${JSON.stringify(payload)}`,
          ].join('\n'),
        },
      ],
      temperature: 0.1,
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

function parseFileSqlPlan(raw: string): FileSqlPlan | null {
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
    } else if (typeof outer?.sql === 'string') {
      content = JSON.stringify(outer);
    }
    if (!content) {
      return null;
    }
    const parsed = JSON.parse(content) as { delivery?: unknown; sql?: unknown };
    const delivery = String(parsed.delivery || '').trim().toLowerCase() === 'attach' ? 'attach' : 'none';
    const sql = typeof parsed.sql === 'string' ? parsed.sql.trim() : '';
    if (!sql) {
      return null;
    }
    return { delivery, sql };
  } catch {
    return null;
  }
}

function enforceSafeFileSql(sql: string): string {
  const normalized = String(sql || '').trim().replace(/;+\s*$/, '');
  const lowered = normalized.toLowerCase();
  const maxRows = Number.isFinite(FILE_SQL_MAX_ROWS) && FILE_SQL_MAX_ROWS > 0 ? FILE_SQL_MAX_ROWS : 50;
  if (!lowered.startsWith('select ')) {
    throw new Error('Only SELECT queries are allowed');
  }
  if (!/\bfrom\s+files\b/i.test(normalized)) {
    throw new Error('Query must select from files table');
  }
  if (/(;|--|\b(insert|update|delete|drop|alter|create|attach|pragma|vacuum|replace|truncate)\b)/i.test(normalized)) {
    throw new Error('Unsafe SQL rejected');
  }
  if (!/\blimit\s+\d+\b/i.test(normalized)) {
    return `${normalized} LIMIT ${maxRows}`;
  }
  const limitMatch = normalized.match(/\blimit\s+(\d+)\b/i);
  const requested = Number(limitMatch?.[1] || 0);
  const capped = Number.isFinite(requested) && requested > 0 ? Math.min(requested, maxRows) : maxRows;
  return normalized.replace(/\blimit\s+\d+(?:\s*,\s*\d+)?(?:\s+offset\s+\d+)?\b/i, `LIMIT ${capped}`);
}

function promptMentionsSourceConstraint(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /\b(source|source_sender|sender|channel)\b/.test(text) ||
    /\b(queue-ui|whatsapp)\b/.test(text) ||
    /@\s*(lid|c\.us|g\.us)\b/.test(text)
  );
}

function sqlHasSourceConstraint(sql: string): boolean {
  const normalized = String(sql || '').toLowerCase();
  return /\bsource\s*=/.test(normalized) || /\bsource_sender\s*(=|like)\s*/.test(normalized);
}

function extractPromptSearchTokens(prompt: string): string[] {
  const stopwords = new Set([
    'a', 'an', 'and', 'any', 'about', 'for', 'from', 'find', 'get', 'give', 'show', 'list', 'search', 'look',
    'looking', 'me', 'my', 'the', 'to', 'with', 'files', 'file', 'documents', 'document', 'please', 'latest',
    'last', 'recent', 'upload', 'uploads',
  ]);
  const tokens = String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
  return Array.from(new Set(tokens)).slice(0, 5);
}

function normalizeDateLiteral(value: string): string | null {
  const raw = String(value || '').trim().replace(/\//g, '-');
  const match = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) {
    return null;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) {
    return null;
  }
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return null;
  }
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function extractDateConstraintFromPrompt(prompt: string): DateConstraint | null {
  const text = String(prompt || '').toLowerCase();
  if (!text) {
    return null;
  }
  const rangeMatch = text.match(/\b(?:from|between)\s+(\d{4}[/-]\d{1,2}[/-]\d{1,2})\s+(?:to|and)\s+(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/);
  if (rangeMatch) {
    const left = normalizeDateLiteral(rangeMatch[1]);
    const right = normalizeDateLiteral(rangeMatch[2]);
    if (left && right) {
      const [start, end] = left <= right ? [left, right] : [right, left];
      return { clause: `date(created_at) BETWEEN date(?) AND date(?)`, params: [start, end] };
    }
  }
  const onDateMatch = text.match(/\b(?:on|for)\s+(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/) || text.match(/\b(\d{4}[/-]\d{1,2}[/-]\d{1,2})\b/);
  if (onDateMatch) {
    const date = normalizeDateLiteral(onDateMatch[1]);
    if (date) {
      return { clause: `date(created_at) = date(?)`, params: [date] };
    }
  }
  const lastDaysMatch = text.match(/\blast\s+(\d{1,3})\s+days?\b/);
  if (lastDaysMatch) {
    const days = Math.max(1, Math.min(365, Number(lastDaysMatch[1] || 0)));
    return { clause: `datetime(created_at) >= datetime('now','localtime', ?)`, params: [`-${days} days`] };
  }
  if (/\byesterday\b/.test(text)) {
    return { clause: `date(created_at) = date('now','localtime','-1 day')`, params: [] };
  }
  if (/\btoday\b/.test(text)) {
    return { clause: `date(created_at) = date('now','localtime')`, params: [] };
  }
  if (/\blast\s+week\b/.test(text)) {
    return {
      clause:
        `date(created_at) >= date('now','localtime','weekday 1','-14 days') AND ` +
        `date(created_at) < date('now','localtime','weekday 1','-7 days')`,
      params: [],
    };
  }
  if (/\bthis\s+week\b/.test(text)) {
    return {
      clause:
        `date(created_at) >= date('now','localtime','weekday 1','-7 days') AND ` +
        `date(created_at) <= date('now','localtime')`,
      params: [],
    };
  }
  if (/\blast\s+month\b/.test(text)) {
    return { clause: `strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now','localtime','-1 month')`, params: [] };
  }
  if (/\bthis\s+month\b/.test(text)) {
    return { clause: `strftime('%Y-%m', created_at) = strftime('%Y-%m', 'now','localtime')`, params: [] };
  }
  return null;
}

function sqlHasDateConstraint(sql: string): boolean {
  const normalized = String(sql || '').toLowerCase();
  return /\bcreated_at\b/.test(normalized) || /\bdate\s*\(/.test(normalized) || /\bstrftime\s*\(/.test(normalized);
}

function buildContentFallbackQuery(prompt: string, dateConstraint: DateConstraint | null): { sql: string; params: string[] } | null {
  const tokens = extractPromptSearchTokens(prompt);
  if (tokens.length === 0) {
    return null;
  }
  const clauses: string[] = [];
  const params: string[] = [];
  for (const token of tokens) {
    const like = `%${token}%`;
    clauses.push(
      '(' +
        `lower(coalesce(filename,'')) LIKE ? OR ` +
        `lower(coalesce(caption,'')) LIKE ? OR ` +
        `lower(coalesce(summary,'')) LIKE ? OR ` +
        `lower(coalesce(pdf_text,'')) LIKE ? OR ` +
        `lower(coalesce(source_sender,'')) LIKE ?` +
      ')',
    );
    params.push(like, like, like, like, like);
  }
  return {
    sql:
      'SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, summary_status, created_at ' +
      `FROM files WHERE (${clauses.join(' OR ')})` +
      (dateConstraint ? ` AND (${dateConstraint.clause})` : '') +
      ` ORDER BY id DESC LIMIT ${FILE_SQL_MAX_ROWS}`,
    params: [...params, ...(dateConstraint ? dateConstraint.params : [])],
  };
}

function buildSummaryFallbackQuery(prompt: string, dateConstraint: DateConstraint | null): { sql: string; params: string[] } | null {
  const tokens = extractPromptSearchTokens(prompt);
  if (tokens.length === 0) {
    return null;
  }
  const clauses: string[] = [];
  const params: string[] = [];
  for (const token of tokens) {
    clauses.push(`lower(coalesce(summary,'')) LIKE ?`);
    params.push(`%${token}%`);
  }
  return {
    sql:
      'SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, summary_status, created_at ' +
      `FROM files WHERE (${clauses.join(' OR ')})` +
      (dateConstraint ? ` AND (${dateConstraint.clause})` : '') +
      ` ORDER BY id DESC LIMIT ${FILE_SQL_MAX_ROWS}`,
    params: [...params, ...(dateConstraint ? dateConstraint.params : [])],
  };
}

async function filterRowsForOwnerSearch(args: {
  owner: string;
  rows: any[];
  dbCtx: DbContext;
}): Promise<any[]> {
  const normalizedOwner = normalizeOwner(args.owner);
  if (normalizedOwner !== SONJA_OWNER || !Array.isArray(args.rows) || args.rows.length === 0) {
    return Array.isArray(args.rows) ? args.rows : [];
  }
  const ids = args.rows
    .map((row) => Number(row?.id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .map((id) => Math.floor(id));
  if (ids.length === 0) {
    return [];
  }
  const placeholders = ids.map(() => '?').join(',');
  const scopeRows = await args.dbCtx.dbAll(
    `SELECT id, content_scope FROM files WHERE id IN (${placeholders});`,
    ...ids,
  );
  const scopeById = new Map<number, ContentScope>();
  for (const row of scopeRows || []) {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      continue;
    }
    scopeById.set(Math.floor(id), normalizeContentScope(row?.content_scope));
  }
  return args.rows.filter((row) => {
    const id = Number(row?.id);
    if (!Number.isFinite(id) || id <= 0) {
      return false;
    }
    const scope = scopeById.get(Math.floor(id)) || 'business';
    return scope !== 'personal';
  });
}

function wantsFileDelivery(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  return /\b(download|send|open|display|show)\b/.test(text) && /\b(file|pdf|document)\b/.test(text);
}

function buildFileDownloadLink(req: Request, bucket: string, key: string): string {
  if (S3_BROWSER_BASE_URL) {
    const base = S3_BROWSER_BASE_URL.replace(/\/+$/, '');
    return `${base}/browser/${encodeURIComponent(bucket)}/${encodeURIComponent(key)}`;
  }
  const host = req.get('host') || `localhost:${PORT}`;
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'http';
  return `${proto}://${host}/file/download?bucket=${encodeURIComponent(bucket)}&key=${encodeURIComponent(key)}`;
}

async function sendWhatsappStatusMessage(chatId: string, text: string): Promise<void> {
  const target = String(chatId || '').trim();
  const message = String(text || '').trim();
  if (!target || !message || !isWhatsappChatId(target) || !WHATSAPP_MESSAGE_URL) {
    return;
  }
  const url = WHATSAPP_MESSAGE_URL.match(/^https?:\/\//i)
    ? WHATSAPP_MESSAGE_URL
    : `http://${WHATSAPP_MESSAGE_URL}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (WHATSAPP_MESSAGE_AUTH) {
    headers.Authorization = WHATSAPP_MESSAGE_AUTH;
  }
  await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      chatId: target,
      text: message,
      message,
    }),
  });
}

async function sendStatusCallback(args: {
  callbackUrl: string;
  callbackAuthorization: string;
  payload: Record<string, unknown>;
}): Promise<void> {
  const url = String(args.callbackUrl || '').trim();
  if (!url) {
    return;
  }
  const normalized = url.match(/^https?:\/\//i) ? url : `http://${url}`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = String(args.callbackAuthorization || '').trim();
  if (auth) {
    headers.Authorization = auth;
  }
  const response = await fetch(normalized, {
    method: 'POST',
    headers,
    body: JSON.stringify(args.payload),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`status callback failed (${response.status}): ${body.slice(0, 240)}`);
  }
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  const safeTimeout = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 60000;
  return await new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${safeTimeout}ms`));
    }, safeTimeout);
    promise
      .then((value) => {
        clearTimeout(timer);
        resolve(value);
      })
      .catch((error) => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

async function s3SendWithTimeout<T>(command: unknown, label: string): Promise<T> {
  const timeoutMs = Number.isFinite(S3_OPERATION_TIMEOUT_MS) && S3_OPERATION_TIMEOUT_MS > 0
    ? S3_OPERATION_TIMEOUT_MS
    : 60000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await s3.send(command as any, { abortSignal: controller.signal } as any) as T;
  } catch (error: any) {
    if (error?.name === 'AbortError') {
      throw new Error(`${label} timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ensureBucketExists(bucket: string): Promise<void> {
  if (readyBuckets.has(bucket)) {
    return;
  }
  try {
    await s3SendWithTimeout(new HeadBucketCommand({ Bucket: bucket }), 's3 head bucket');
  } catch {
    await s3SendWithTimeout(new CreateBucketCommand({ Bucket: bucket }), 's3 create bucket');
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

async function initDbForOwner(owner: string): Promise<DbContext> {
  const normalizedOwner = normalizeOwner(owner);
  const dbPath = resolveDbPath(normalizedOwner);
  await mkdir(path.dirname(path.resolve(dbPath)), { recursive: true });
  const db = new sqlite3.Database(dbPath);
  const dbGet = promisify(db.get.bind(db));
  const dbRun = promisify(db.run.bind(db)) as unknown as (sql: string, ...params: unknown[]) => Promise<void>;
  const dbAll = promisify(db.all.bind(db)) as unknown as (sql: string, ...params: unknown[]) => Promise<any[]>;
  await dbRun(`
    CREATE TABLE IF NOT EXISTS files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      source_message_id TEXT,
      source_sender TEXT,
      bucket TEXT NOT NULL,
      s3_key TEXT NOT NULL UNIQUE,
      content_hash TEXT,
      filename TEXT,
      content_type TEXT,
      size_bytes INTEGER NOT NULL DEFAULT 0,
      caption TEXT,
      metadata_json TEXT,
      pdf_text TEXT,
      pdf_text_length INTEGER NOT NULL DEFAULT 0,
      pdf_extractor TEXT,
      summary TEXT,
      content_scope TEXT NOT NULL DEFAULT 'business',
      summary_status TEXT NOT NULL DEFAULT 'pending',
      summary_error TEXT,
      summary_model TEXT,
      summary_raw_response TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
  `);
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_source_sender ON files(source_sender);');
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_source_message ON files(source_message_id);');
  await dbRun("ALTER TABLE files ADD COLUMN summary_status TEXT NOT NULL DEFAULT 'pending';").catch(() => {});
  await dbRun('ALTER TABLE files ADD COLUMN summary_error TEXT;').catch(() => {});
  await dbRun('ALTER TABLE files ADD COLUMN content_hash TEXT;').catch(() => {});
  await dbRun("ALTER TABLE files ADD COLUMN content_scope TEXT NOT NULL DEFAULT 'business';").catch(() => {});
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_content_hash ON files(content_hash);').catch(() => {});
  await dbRun('CREATE INDEX IF NOT EXISTS idx_files_content_scope ON files(content_scope);').catch(() => {});
  return {
    owner: normalizedOwner,
    path: dbPath,
    db,
    dbGet,
    dbRun,
    dbAll,
  };
}

async function getDbContext(owner: string): Promise<DbContext> {
  const normalizedOwner = normalizeOwner(owner);
  const existing = dbContexts.get(normalizedOwner);
  if (existing) {
    return existing;
  }
  const created = await initDbForOwner(normalizedOwner);
  dbContexts.set(normalizedOwner, created);
  return created;
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

function logSummaryOutcome(args: {
  outcome: 'completed' | 'deleted' | 'failed';
  fileId: number;
  filename: string;
  model?: string | null;
  extractor?: string | null;
  summary?: string | null;
  error?: string | null;
}): void {
  const stars = '***************';
  const summarySnippet = args.summary ? safeSummarySnippet(args.summary, 220) : '';
  const errorSnippet = args.error ? safeSummarySnippet(args.error, 220) : '';
  // eslint-disable-next-line no-console
  console.log(stars);
  // eslint-disable-next-line no-console
  console.log(
    `[mservice-file][summary] outcome=${args.outcome} fileId=${args.fileId} filename=${args.filename} model=${args.model || 'unknown'} extractor=${args.extractor || 'unknown'}`,
  );
  if (summarySnippet) {
    // eslint-disable-next-line no-console
    console.log(`[mservice-file][summary] text=${summarySnippet}`);
  }
  if (errorSnippet) {
    // eslint-disable-next-line no-console
    console.log(`[mservice-file][summary] error=${errorSnippet}`);
  }
  // eslint-disable-next-line no-console
  console.log(stars);
}

async function runPdfSummaryPipeline(args: {
  dbRun: (sql: string, ...params: unknown[]) => Promise<void>;
  fileId: number;
  bucket: string;
  key: string;
  filename: string;
  contentType: string;
  source: string;
  sourceSender: string;
  sourceMessageId: string;
  caption: string;
  callbackUrl: string;
  callbackAuthorization: string;
  baseMetadata: Record<string, string>;
  content: Buffer;
}): Promise<void> {
  let extractedPdfText = '';
  let summary: string | null = null;
  let summaryRawResponse = '';
  let summaryError = '';
  let summaryModel = ASSISTANT_MODEL;
  let extractor: string | null = null;
  let usedPdfImageFallback = false;
  try {
    const isPdf = isPdfAttachment(args.contentType, args.filename);
    const isWord = isWordAttachment(args.contentType, args.filename);
    const isImage = isImageAttachment(args.contentType, args.filename);
    if (!isPdf && !isWord && !isImage) {
      throw new Error('Unsupported extractable file type');
    }
    if (isPdf) {
      extractedPdfText = normalizeWhitespace(
        await withTimeout(extractPdfTextFromBuffer(args.content), FILE_EXTRACTION_TIMEOUT_MS, 'pdf extraction'),
      );
      if (hasMeaningfulPdfText(extractedPdfText)) {
        extractor = 'pdf2json';
      } else {
        // Scanned/image-style PDFs: retry summary path with image model.
        extractedPdfText = '';
        summaryModel = IMAGE_SUMMARY_MODEL;
        extractor = 'pdf2json-image-fallback';
        usedPdfImageFallback = true;
      }
    } else {
      if (isWord) {
        extractedPdfText = normalizeWhitespace(
          await withTimeout(extractWordTextFromBuffer(args.content), FILE_EXTRACTION_TIMEOUT_MS, 'word extraction'),
        );
        extractor = 'mammoth';
      } else {
        summaryModel = IMAGE_SUMMARY_MODEL;
        extractor = 'vision';
      }
    }
    if (isWord && !extractedPdfText) {
      throw new Error('No readable text extracted from Word document');
    }
    if (!ASSISTANT_URL) {
      throw new Error('Summary assistant is not configured');
    }
    const buildSummaryPayload = (useImageInput: boolean, imageFallbackFlag: boolean) => ({
      source: args.source || null,
      source_sender: args.sourceSender || null,
      source_message_id: args.sourceMessageId || null,
      filename: args.filename || '',
      content_type: args.contentType || '',
      size_bytes: args.content.length,
      caption: args.caption || '',
      extracted_text: useImageInput ? '' : trimForSummary(extractedPdfText, FILE_SUMMARY_TEXT_LIMIT),
      pdf_image_fallback: imageFallbackFlag || undefined,
    });

    const requestSummary = async (useImageInput: boolean): Promise<{ raw: string; parsedSummary: string }> => {
      const canAttachImagePayload =
        useImageInput &&
        (args.contentType || '').toLowerCase().startsWith('image/');
      const payload = buildSummaryPayload(useImageInput, usedPdfImageFallback);
      const raw = await sendSummaryRequestToAssistant(payload, {
        model: summaryModel,
        imageBase64: canAttachImagePayload ? args.content.toString('base64') : undefined,
      });
      if (!raw) {
        throw new Error('Summary service returned an empty response');
      }
      const parsedSummary = parseAssistantSummary(raw);
      if (!parsedSummary) {
        throw new Error('Summary service response could not be parsed');
      }
      return { raw, parsedSummary };
    };

    const useImageSummaryInput = isImage || usedPdfImageFallback;
    try {
      const firstAttempt = await requestSummary(useImageSummaryInput);
      summaryRawResponse = firstAttempt.raw;
      summary = firstAttempt.parsedSummary;
      const shouldRetryPdfFromSemanticNoText =
        isPdf &&
        !useImageSummaryInput &&
        summaryIndicatesNoReadableText(summary || '');
      if (shouldRetryPdfFromSemanticNoText) {
        usedPdfImageFallback = true;
        summaryModel = IMAGE_SUMMARY_MODEL;
        extractor = 'pdf2json-semantic-image-retry';
        const semanticRetry = await requestSummary(true);
        summaryRawResponse = semanticRetry.raw;
        summary = semanticRetry.parsedSummary;
      }
    } catch (firstSummaryError: any) {
      const shouldRetryPdfAsImage = isPdf && !usedPdfImageFallback && !isImage;
      const firstErrorMessage = String(firstSummaryError?.message || '');
      const firstImageContractFailure =
        useImageSummaryInput &&
        (firstErrorMessage.includes('Summary service response could not be parsed') ||
          firstErrorMessage.includes('Summary service returned an empty response'));
      const canTryVisionFallbackModel =
        firstImageContractFailure &&
        IMAGE_SUMMARY_FALLBACK_MODEL.length > 0 &&
        IMAGE_SUMMARY_FALLBACK_MODEL !== summaryModel;

      if (!shouldRetryPdfAsImage) {
        if (!canTryVisionFallbackModel) {
          throw firstSummaryError;
        }
        summaryModel = IMAGE_SUMMARY_FALLBACK_MODEL;
        extractor = isImage ? 'vision-fallback' : `${extractor || 'vision'}-fallback`;
        const fallbackAttempt = await requestSummary(true);
        summaryRawResponse = fallbackAttempt.raw;
        summary = fallbackAttempt.parsedSummary;
      } else {
        usedPdfImageFallback = true;
        summaryModel = IMAGE_SUMMARY_MODEL;
        extractor = 'pdf2json-image-retry';
        try {
          const retryAttempt = await requestSummary(true);
          summaryRawResponse = retryAttempt.raw;
          summary = retryAttempt.parsedSummary;
        } catch (pdfImageRetryError: any) {
          const retryMessage = String(pdfImageRetryError?.message || '');
          const retryImageContractFailure =
            retryMessage.includes('Summary service response could not be parsed') ||
            retryMessage.includes('Summary service returned an empty response');
          const canFallbackAfterPdfRetry =
            retryImageContractFailure &&
            IMAGE_SUMMARY_FALLBACK_MODEL.length > 0 &&
            IMAGE_SUMMARY_FALLBACK_MODEL !== summaryModel;
          if (!canFallbackAfterPdfRetry) {
            throw pdfImageRetryError;
          }
          summaryModel = IMAGE_SUMMARY_FALLBACK_MODEL;
          extractor = 'pdf2json-image-retry-fallback';
          const fallbackAttempt = await requestSummary(true);
          summaryRawResponse = fallbackAttempt.raw;
          summary = fallbackAttempt.parsedSummary;
        }
      }
    }

    const metadataWithSummary: Record<string, string> = {
      ...args.baseMetadata,
      ...(metadataValue(summary, 512) ? { summary: metadataValue(summary, 512)! } : {}),
    };
    await s3SendWithTimeout(
      new PutObjectCommand({
        Bucket: args.bucket,
        Key: args.key,
        Body: args.content,
        ContentType: args.contentType || 'application/octet-stream',
        Metadata: metadataWithSummary,
      }),
      's3 metadata update',
    );
    await args.dbRun(
      `UPDATE files
       SET pdf_text = ?,
           pdf_text_length = ?,
           pdf_extractor = ?,
           summary = ?,
           summary_status = 'completed',
           summary_error = NULL,
           summary_model = ?,
           summary_raw_response = ?,
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?;`,
      extractedPdfText,
      extractedPdfText.length,
      extractor,
      summary,
      summaryModel,
      summaryRawResponse || null,
      JSON.stringify({ ...args.baseMetadata, summary: safeSummarySnippet(summary, 512) }),
      args.fileId,
    );
    logSummaryOutcome({
      outcome: 'completed',
      fileId: args.fileId,
      filename: args.filename,
      model: summaryModel,
      extractor,
      summary,
    });
  } catch (err: any) {
    summaryError = String(err?.message || 'summary pipeline failed');
    const isPdf = isPdfAttachment(args.contentType, args.filename);
    const isImage = isImageAttachment(args.contentType, args.filename);
    const passwordLockedPdf = isPdf && isPdfPasswordError(err);
    const imageFallbackPdf = isPdf && usedPdfImageFallback;
    const imageParseOrEmptyFailure =
      isImage &&
      (summaryError.includes('Summary service response could not be parsed') ||
        summaryError.includes('Summary service returned an empty response'));
    if (passwordLockedPdf) {
      await s3SendWithTimeout(new DeleteObjectCommand({ Bucket: args.bucket, Key: args.key }), 's3 delete skipped file').catch(() => {});
      await args.dbRun(`DELETE FROM files WHERE id = ?;`, args.fileId);
      logSummaryOutcome({
        outcome: 'deleted',
        fileId: args.fileId,
        filename: args.filename,
        model: summaryModel,
        extractor,
        error: summaryError,
      });
      return;
    }
    if (imageParseOrEmptyFailure) {
      await s3SendWithTimeout(new DeleteObjectCommand({ Bucket: args.bucket, Key: args.key }), 's3 delete skipped file').catch(() => {});
      await args.dbRun(`DELETE FROM files WHERE id = ?;`, args.fileId);
      logSummaryOutcome({
        outcome: 'deleted',
        fileId: args.fileId,
        filename: args.filename,
        model: summaryModel,
        extractor,
        error: summaryError,
      });
      return;
    }
    if (imageFallbackPdf) {
      await s3SendWithTimeout(new DeleteObjectCommand({ Bucket: args.bucket, Key: args.key }), 's3 delete skipped file').catch(() => {});
      await args.dbRun(`DELETE FROM files WHERE id = ?;`, args.fileId);
      logSummaryOutcome({
        outcome: 'deleted',
        fileId: args.fileId,
        filename: args.filename,
        model: summaryModel,
        extractor,
        error: summaryError,
      });
      return;
    }
    await args.dbRun(
      `UPDATE files
       SET pdf_text = ?,
           pdf_text_length = ?,
           pdf_extractor = ?,
           summary = NULL,
           summary_status = 'failed',
           summary_error = ?,
           summary_model = ?,
           summary_raw_response = ?,
           metadata_json = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?;`,
      extractedPdfText || null,
      extractedPdfText.length,
      extractedPdfText ? extractor : null,
      summaryError,
      summaryModel,
      summaryRawResponse || null,
      JSON.stringify(args.baseMetadata),
      args.fileId,
    );
    logSummaryOutcome({
      outcome: 'failed',
      fileId: args.fileId,
      filename: args.filename,
      model: summaryModel,
      extractor,
      error: summaryError,
    });
    if (isWhatsappChatId(args.sourceSender)) {
      const statusMessage =
        `Upload status: stored (File ID ${args.fileId}). ` +
        `Summary status: failed (${summaryError}).`;
      await sendWhatsappStatusMessage(args.sourceSender, statusMessage).catch(() => {});
    }
    if (args.callbackUrl) {
      await sendStatusCallback({
        callbackUrl: args.callbackUrl,
        callbackAuthorization: args.callbackAuthorization,
        payload: {
          success: false,
          file_id: args.fileId,
          filename: args.filename,
          source: args.source || null,
          source_sender: args.sourceSender || null,
          source_message_id: args.sourceMessageId || null,
          summary_status: 'failed',
          error: summaryError,
        },
      }).catch(() => {});
    }
  }
}

app.get('/health', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.query.owner);
    const dbCtx = await getDbContext(owner);
    const bucket = resolveBucket(undefined, owner);
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    const row = await dbCtx.dbGet('SELECT COUNT(*) AS count FROM files;');
    const filesCount = Number(row?.count || 0);
    res.json({ status: 'ok', owner, bucket, endpoint: S3_ENDPOINT, db_path: dbCtx.path, files_count: filesCount });
  } catch (err: any) {
    res.status(503).json({ status: 'error', message: err?.message || 'S3 unavailable' });
  }
});

app.post('/bucket/create', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.body?.owner);
    const bucket = resolveBucket(req.body?.bucket, owner);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    res.status(201).json({ success: true, owner, bucket });
  } catch (err: any) {
    const message = String(err?.message || 'create bucket failed');
    if (message.toLowerCase().includes('already owned') || message.toLowerCase().includes('already exists')) {
      const owner = normalizeOwner(req.body?.owner);
      res.status(200).json({ success: true, owner, bucket: resolveBucket(req.body?.bucket, owner), exists: true });
      return;
    }
    res.status(500).json({ success: false, message });
  }
});

app.post('/file/upload', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.body?.owner ?? req.body?.source_owner);
    const dbCtx = await getDbContext(owner);
    const bucket = resolveBucket(req.body?.bucket, owner);
    const providedKey = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const dataBase64Raw = typeof req.body?.data_base64 === 'string' ? req.body.data_base64.trim() : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type.trim() : 'application/octet-stream';
    const filename = sanitizeFilename(typeof req.body?.filename === 'string' ? req.body.filename.trim() : '');
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const sourceSender = typeof req.body?.source_sender === 'string' ? req.body.source_sender.trim() : '';
    const sourceMessageId =
      typeof req.body?.source_message_id === 'string' ? req.body.source_message_id.trim() : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const callbackUrl = typeof req.body?.callback_url === 'string' ? req.body.callback_url.trim() : '';
    const callbackAuthorization =
      typeof req.body?.callback_authorization === 'string' ? req.body.callback_authorization.trim() : '';
    const key = toUploadKey({ source: `${owner}/${source || 'ui'}`, filename, providedKey });
    const dataBase64 = dataBase64Raw.startsWith('data:') && dataBase64Raw.includes(',')
      ? dataBase64Raw.split(',').pop() || ''
      : dataBase64Raw;
    // eslint-disable-next-line no-console
    console.log(
      `[mservice-file][upload] start owner=${owner} source=${source || 'unknown'} sender=${sourceSender || 'unknown'} filename=${filename || 'file.bin'} mime=${contentType || 'application/octet-stream'} bytes(base64)=${dataBase64.length}`,
    );

    if (!dataBase64) {
      res.status(400).json({ success: false, message: 'data_base64 is required' });
      return;
    }

    const bytes = Buffer.from(dataBase64, 'base64');
    const contentHash = crypto.createHash('sha256').update(bytes).digest('hex');
    await ensureBucketExists(bucket);
    if (FILE_DEDUP_ENABLED) {
      const existing = await dbCtx.dbGet(
        `SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, summary_status, pdf_text_length
         FROM files
         WHERE bucket = ? AND content_hash = ?
         ORDER BY id DESC
         LIMIT 1;`,
        bucket,
        contentHash,
      );
      if (existing?.id) {
        res.status(200).json({
          success: true,
          duplicate: true,
          deduped: true,
          file_id: Number(existing.id) || null,
          bucket: String(existing.bucket || bucket),
          key: String(existing.s3_key || ''),
          filename: String(existing.filename || filename || ''),
          content_type: String(existing.content_type || contentType),
          bytes: Number(existing.size_bytes || bytes.length),
          caption: existing.caption ?? null,
          summary: typeof existing.summary === 'string' ? existing.summary : null,
          summary_status: typeof existing.summary_status === 'string' ? existing.summary_status : 'unknown',
          pdf_text_length: Number(existing.pdf_text_length || 0),
          summary_async: false,
        });
        return;
      }
    }
    const baseMetadata: Record<string, string> = {
      ...(metadataValue(source, 64) ? { source: metadataValue(source, 64)! } : {}),
      ...(metadataValue(sourceSender, 128) ? { source_sender: metadataValue(sourceSender, 128)! } : {}),
      ...(metadataValue(sourceMessageId, 128) ? { source_message_id: metadataValue(sourceMessageId, 128)! } : {}),
      ...(metadataValue(caption, 256) ? { caption: metadataValue(caption, 256)! } : {}),
    };
    await s3SendWithTimeout(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
        Metadata: baseMetadata,
      }),
      's3 upload',
    );

    const shouldProcessPdfSummary =
      isPdfAttachment(contentType, filename) || isWordAttachment(contentType, filename) || isImageAttachment(contentType, filename);
    const initialSummaryStatus: SummaryStatus =
      shouldProcessPdfSummary && ASSISTANT_URL ? 'pending' : 'skipped';

    await dbCtx.dbRun(
      `INSERT INTO files (
        source,
        source_message_id,
        source_sender,
        bucket,
        s3_key,
        content_hash,
        filename,
        content_type,
        size_bytes,
        caption,
        metadata_json,
        pdf_text,
        pdf_text_length,
        pdf_extractor,
        summary,
        summary_status,
        summary_error,
        summary_model,
        summary_raw_response,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(s3_key) DO UPDATE SET
        source = excluded.source,
        source_message_id = excluded.source_message_id,
        source_sender = excluded.source_sender,
        bucket = excluded.bucket,
        content_hash = excluded.content_hash,
        filename = excluded.filename,
        content_type = excluded.content_type,
        size_bytes = excluded.size_bytes,
        caption = excluded.caption,
        metadata_json = excluded.metadata_json,
        pdf_text = excluded.pdf_text,
        pdf_text_length = excluded.pdf_text_length,
        pdf_extractor = excluded.pdf_extractor,
        summary = excluded.summary,
        summary_status = excluded.summary_status,
        summary_error = excluded.summary_error,
        summary_model = excluded.summary_model,
        summary_raw_response = excluded.summary_raw_response,
        updated_at = CURRENT_TIMESTAMP;`,
      source || null,
      sourceMessageId || null,
      sourceSender || null,
      bucket,
      key,
      contentHash,
      filename || null,
      contentType,
      bytes.length,
      caption || null,
      JSON.stringify(baseMetadata),
      null,
      0,
      null,
      null,
      initialSummaryStatus,
      null,
      null,
      null,
    );

    const record = await dbCtx.dbGet('SELECT * FROM files WHERE s3_key = ? LIMIT 1;', key);
    const fileId = Number(record?.id || 0) || null;
    // eslint-disable-next-line no-console
    console.log(
      `[mservice-file][upload] stored owner=${owner} fileId=${fileId ?? 'unknown'} key=${key} summary_status=${initialSummaryStatus}`,
    );
    res.status(201).json({
      success: true,
      owner,
      bucket,
      key,
      bytes: bytes.length,
      content_type: contentType,
      file_id: fileId,
      caption: caption || null,
      summary: null,
      summary_status: initialSummaryStatus,
      pdf_text_length: 0,
      summary_async: shouldProcessPdfSummary && ASSISTANT_URL.length > 0,
    });

    if (fileId && shouldProcessPdfSummary && ASSISTANT_URL) {
      void runPdfSummaryPipeline({
        dbRun: dbCtx.dbRun,
        fileId,
        bucket,
        key,
        filename,
        contentType,
        source,
        sourceSender,
        sourceMessageId,
        caption,
        callbackUrl,
        callbackAuthorization,
        baseMetadata,
        content: bytes,
      });
    }
  } catch (err: any) {
    // eslint-disable-next-line no-console
    console.error(`[mservice-file][upload] failed ${String(err?.message || 'upload failed')}`);
    res.status(500).json({ success: false, message: err?.message || 'upload failed' });
  }
});

app.post('/llm-query', authMiddleware, async (req, res) => {
  try {
    const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const owner = normalizeOwner(req.body?.owner ?? req.body?.query_owner ?? req.body?.source_owner);
    const dbCtx = await getDbContext(owner);
    const sourceChannel = typeof req.body?.source_channel === 'string' ? req.body.source_channel.trim() : '';
    const sourceFrom = typeof req.body?.source_from === 'string' ? req.body.source_from.trim() : '';
    if (!prompt) {
      res.status(400).json({ success: false, message: 'prompt is required' });
      return;
    }

    const planPayload = {
      prompt,
      source_channel: sourceChannel || null,
      source_from: sourceFrom || null,
    };
    const rawPlan = await sendSqlPlanRequestToAssistant(planPayload);
    const parsedPlan = rawPlan ? parseFileSqlPlan(rawPlan) : null;
    const fallbackSql =
      `SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, summary_status, created_at FROM files ORDER BY id DESC LIMIT ${FILE_SQL_MAX_ROWS}`;
    const dateConstraint = extractDateConstraintFromPrompt(prompt);
    const summaryFirstQuery = buildSummaryFallbackQuery(prompt, dateConstraint);
    let rows = summaryFirstQuery ? await dbCtx.dbAll(summaryFirstQuery.sql, ...summaryFirstQuery.params) : [];
    let effectiveSql = summaryFirstQuery?.sql || '';
    let sql = enforceSafeFileSql(parsedPlan?.sql || fallbackSql);
    if (sqlHasSourceConstraint(sql) && !promptMentionsSourceConstraint(prompt)) {
      sql = fallbackSql;
    }
    if (rows.length === 0) {
      if (dateConstraint && !sqlHasDateConstraint(sql)) {
        sql = fallbackSql;
      }
      rows = await dbCtx.dbAll(sql);
      effectiveSql = sql;
    }
    if ((!rows || rows.length === 0) && prompt) {
      const fallbackQuery = buildContentFallbackQuery(prompt, dateConstraint);
      if (fallbackQuery) {
        const fallbackRows = await dbCtx.dbAll(fallbackQuery.sql, ...fallbackQuery.params);
        if (fallbackRows.length > 0) {
          rows = fallbackRows;
          effectiveSql = fallbackQuery.sql;
        }
      }
    }
    const isWhatsapp = String(sourceChannel || '').toLowerCase() === 'whatsapp' || isWhatsappChatId(sourceFrom);
    const delivery = parsedPlan?.delivery === 'attach' || wantsFileDelivery(prompt) ? 'attach' : 'none';

    if (isWhatsapp && delivery === 'attach') {
      const selected = (rows || [])
        .filter((row) => row?.bucket && row?.s3_key)
        .slice(0, 3);
      const attachments: Array<{
        attachment_id: number;
        filename: string;
        content_type: string;
        data_base64: string;
      }> = [];
      for (const row of selected) {
        const bucket = String(row.bucket);
        const key = String(row.s3_key);
        const filename = row?.filename ? String(row.filename) : key.split('/').pop() || 'file.bin';
        const contentType = row?.content_type ? String(row.content_type) : 'application/octet-stream';
        const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        const buffer = await bodyToBuffer(out.Body);
        attachments.push({
          attachment_id: Number(row?.id || 0),
          filename,
          content_type: contentType,
          data_base64: buffer.toString('base64'),
        });
      }
      const lines = selected.map((row: any) => {
        const id = Number(row?.id || 0);
        const filename = row?.filename ? String(row.filename) : '(unnamed)';
        const summary = row?.summary ? String(row.summary) : '';
        return summary ? `- ${id}: ${filename} | Summary: ${summary}` : `- ${id}: ${filename}`;
      });
      res.json({
        success: true,
        owner,
        type: 'attachment',
        message: lines.length > 0 ? `Sending ${lines.length} file(s):\n${lines.join('\n')}` : 'No matching files found.',
        rows,
        attachments,
      });
      return;
    }

      const lines = (rows || []).map((row: any) => {
        const id = Number(row?.id || 0);
        const filename = row?.filename ? String(row.filename) : '(unnamed)';
        const bucket = row?.bucket ? String(row.bucket) : resolveDefaultBucketForOwner(owner);
        const key = row?.s3_key ? String(row.s3_key) : '';
        const link = key ? buildFileDownloadLink(req, bucket, key) : '#';
        return `- ${id}: ${filename} | Download Link: ${link}`;
      });
    const summaryLines = (rows || [])
      .map((row: any) => {
        const id = Number(row?.id || 0);
        const summary = row?.summary ? String(row.summary).trim() : '';
        const summaryStatus = row?.summary_status ? String(row.summary_status).trim() : '';
        if (!summary && !summaryStatus) {
          return '';
        }
        return summary
          ? `Summary ${id}: ${summary}`
          : `Summary ${id}: (${summaryStatus || 'unavailable'})`;
      })
      .filter((line: string) => line.length > 0);
    const message = lines.length > 0
      ? [
          `Files (${lines.length}):`,
          ...lines,
          ...(summaryLines.length > 0 ? ['', ...summaryLines] : []),
        ].join('\n')
      : 'No matching files found.';
    res.json({
      success: true,
      owner,
      type: 'message',
      message,
      rows,
      sql: effectiveSql,
      delivery,
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'llm-query failed' });
  }
});

app.get('/file/download', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.query.owner);
    const dbCtx = await getDbContext(owner);
    let bucket = resolveBucket(req.query.bucket, owner);
    let key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    const id = Number(req.query.id);
    if ((!key || !bucket) && Number.isFinite(id) && id > 0) {
      const row = await dbCtx.dbGet('SELECT bucket, s3_key FROM files WHERE id = ? LIMIT 1;', id);
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
    const owner = normalizeOwner(req.query.owner);
    const bucket = resolveBucket(req.query.bucket, owner);
    const prefix = typeof req.query.prefix === 'string' ? req.query.prefix : undefined;
    const out = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
    const rows = (out.Contents || []).map((item) => ({
      key: item.Key || '',
      size: Number(item.Size || 0),
      last_modified: item.LastModified ? item.LastModified.toISOString() : null,
      etag: item.ETag || null,
    }));
    res.json({ success: true, owner, bucket, count: rows.length, files: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'list failed' });
  }
});

app.get('/file/records', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.query.owner);
    const dbCtx = await getDbContext(owner);
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
      `pdf_text_length, summary, summary_status, summary_error, created_at, updated_at FROM files ` +
      `${where.length > 0 ? `WHERE ${where.join(' AND ')} ` : ''}` +
      `ORDER BY id DESC LIMIT ?;`;
    const rows = await dbCtx.dbAll(sql, ...params, limit);
    res.json({ success: true, owner, count: rows.length, files: rows });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'records query failed' });
  }
});

app.get('/file/status', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.query.owner);
    const dbCtx = await getDbContext(owner);
    const id = Number(req.query.id);
    const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    if ((!Number.isFinite(id) || id <= 0) && !key) {
      res.status(400).json({ success: false, message: 'id or key is required' });
      return;
    }
    const row = Number.isFinite(id) && id > 0
      ? await dbCtx.dbGet(
        `SELECT id, bucket, s3_key, filename, content_type, summary_status, summary, summary_error, created_at, updated_at
         FROM files
         WHERE id = ?
         LIMIT 1;`,
        Math.floor(id),
      )
      : await dbCtx.dbGet(
        `SELECT id, bucket, s3_key, filename, content_type, summary_status, summary, summary_error, created_at, updated_at
         FROM files
         WHERE s3_key = ?
         LIMIT 1;`,
        key,
      );
    if (!row) {
      res.status(200).json({
        success: true,
        owner,
        file: {
          id: Number.isFinite(id) && id > 0 ? Math.floor(id) : null,
          bucket: null,
          s3_key: key || null,
          filename: null,
          content_type: null,
          summary_status: 'deleted',
          summary: null,
          summary_error: 'status record removed',
          created_at: null,
          updated_at: null,
        },
      });
      return;
    }
    res.json({ success: true, owner, file: row });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'status query failed' });
  }
});

app.delete('/file/delete', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.query.owner ?? req.body?.owner);
    const dbCtx = await getDbContext(owner);
    let bucket = resolveBucket(req.query.bucket ?? req.body?.bucket, owner);
    const keyCandidate = req.query.key ?? req.body?.key;
    let key = typeof keyCandidate === 'string' ? keyCandidate.trim() : '';
    const idCandidate = req.query.id ?? req.body?.id;
    const id = Number(idCandidate);
    if ((!key || !bucket) && Number.isFinite(id) && id > 0) {
      const row = await dbCtx.dbGet('SELECT bucket, s3_key FROM files WHERE id = ? LIMIT 1;', id);
      bucket = row?.bucket ? String(row.bucket) : bucket;
      key = row?.s3_key ? String(row.s3_key) : key;
    }
    if (!key) {
      res.status(400).json({ success: false, message: 'key or id is required' });
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    await dbCtx.dbRun('DELETE FROM files WHERE bucket = ? AND s3_key = ?;', bucket, key);
    res.json({ success: true, owner, bucket, key });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'delete failed' });
  }
});

async function start(): Promise<void> {
  const meCtx = await getDbContext(DEFAULT_OWNER);
  const sonjaCtx = await getDbContext(SONJA_OWNER);
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] listening on port ${PORT}`);
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] s3 endpoint ${S3_ENDPOINT} bucket ${S3_DEFAULT_BUCKET}`);
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] owner=${DEFAULT_OWNER} sqlite ${meCtx.path} bucket ${resolveDefaultBucketForOwner(DEFAULT_OWNER)}`);
    // eslint-disable-next-line no-console
    console.log(`[mservice-file] owner=${SONJA_OWNER} sqlite ${sonjaCtx.path} bucket ${resolveDefaultBucketForOwner(SONJA_OWNER)}`);
  });
}

start().catch((err: any) => {
  // eslint-disable-next-line no-console
  console.error('[mservice-file] failed to start', err?.message || err);
  process.exit(1);
});
