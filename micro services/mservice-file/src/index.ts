import express, { Request, Response, NextFunction } from 'express';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import mysql from 'mysql2/promise';
import PDFParser from 'pdf2json';
import mammoth from 'mammoth';
import sharp from 'sharp';
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
const SONJA_REFINEMENT_MAX_ITERATIONS = Number.parseInt(process.env.SONJA_REFINEMENT_MAX_ITERATIONS || '3', 10);
const SONJA_REFINEMENT_CONFIDENCE_THRESHOLD = Number.parseInt(process.env.SONJA_REFINEMENT_CONFIDENCE_THRESHOLD || '80', 10);
const SONJA_REFINEMENT_REVIEW_CHARS = Number.parseInt(process.env.SONJA_REFINEMENT_REVIEW_CHARS || '12000', 10);
const SONJA_REFINEMENT_MAX_REVIEW_CHUNKS = Number.parseInt(process.env.SONJA_REFINEMENT_MAX_REVIEW_CHUNKS || '12', 10);
const SONJA_REFINEMENT_MAX_ROWS = Number.parseInt(process.env.SONJA_REFINEMENT_MAX_ROWS || '120', 10);
const ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.ASSISTANT_TIMEOUT_MS || '120000', 10);
const FILE_QUERY_ASSISTANT_TIMEOUT_MS = Number.parseInt(process.env.FILE_QUERY_ASSISTANT_TIMEOUT_MS || '30000', 10);
const FILE_QUERY_ASSISTANT_RETRIES = Number.parseInt(process.env.FILE_QUERY_ASSISTANT_RETRIES || '2', 10);
const FILE_QUERY_ASSISTANT_RETRY_DELAY_MS = Number.parseInt(process.env.FILE_QUERY_ASSISTANT_RETRY_DELAY_MS || '1200', 10);
const FILE_QUERY_USE_ASSISTANT = String(process.env.FILE_QUERY_USE_ASSISTANT || 'false').toLowerCase() === 'true';
const SONJA_REFINEMENT_ENABLED = String(process.env.SONJA_REFINEMENT_ENABLED || 'true').toLowerCase() === 'true';
const SONJA_STRICT_LLM_COMPLETION = String(process.env.SONJA_STRICT_LLM_COMPLETION || 'true').toLowerCase() === 'true';
const SONJA_KEYWORD_MODEL = (process.env.SONJA_KEYWORD_MODEL || 'qwen2.5:7b').trim();
const SONJA_MATCH_MODEL = (process.env.SONJA_MATCH_MODEL || 'qwen2.5:7b').trim();
const SONJA_MATCH_CONFIDENCE = Number.parseInt(process.env.SONJA_MATCH_CONFIDENCE || '90', 10);
const SONJA_SEARCH_BATCH_SIZE = Math.max(1, Number.parseInt(process.env.SONJA_SEARCH_BATCH_SIZE || '5', 10));
const SONJA_SEARCH_MAX_SCAN_ROWS = Math.max(SONJA_SEARCH_BATCH_SIZE, Number.parseInt(process.env.SONJA_SEARCH_MAX_SCAN_ROWS || '200', 10));
const SONJA_EMBEDDING_SEARCH_ENABLED = String(process.env.SONJA_EMBEDDING_SEARCH_ENABLED || 'true').toLowerCase() !== 'false';
const SONJA_EMBEDDING_OLLAMA_URL = (process.env.SONJA_EMBEDDING_OLLAMA_URL || process.env.OLLAMA_URL || 'http://192.168.55.73:11434')
  .trim()
  .replace(/\/+$/, '');
const SONJA_EMBEDDING_MODEL = (process.env.SONJA_EMBEDDING_MODEL || 'qwen3-embedding').trim();
const SONJA_EMBEDDING_CANDIDATE_LIMIT = Number.parseInt(process.env.SONJA_EMBEDDING_CANDIDATE_LIMIT || '2000', 10);
const SONJA_EMBEDDING_MIN_SCORE = Number.parseFloat(process.env.SONJA_EMBEDDING_MIN_SCORE || '0');
const VECTOR_MYSQL_HOST_RAW = (
  process.env.VECTOR_MYSQL_HOST ||
  process.env.MYSQL_HOST ||
  process.env.VECTORIZER_MYSQL_HOST ||
  '127.0.0.1'
).trim();
const VECTOR_MYSQL_HOST = VECTOR_MYSQL_HOST_RAW === '%' ? '127.0.0.1' : VECTOR_MYSQL_HOST_RAW;
const VECTOR_MYSQL_PORT = Number.parseInt(process.env.VECTOR_MYSQL_PORT || process.env.MYSQL_PORT || '3306', 10);
const VECTOR_MYSQL_DATABASE = (process.env.VECTOR_MYSQL_DATABASE || process.env.MYSQL_DATABASE || '').trim();
const VECTOR_MYSQL_USER = (
  process.env.VECTOR_MYSQL_USER ||
  process.env.MYSQL_USER ||
  process.env.VECTORIZER_MYSQL_USER ||
  ''
).trim();
const VECTOR_MYSQL_PASSWORD = (
  process.env.VECTOR_MYSQL_PASSWORD ||
  process.env.MYSQL_PASSWORD ||
  process.env.VECTORIZER_MYSQL_PASSWORD ||
  ''
).trim();
const FILE_EXTRACTION_TIMEOUT_MS = Number.parseInt(process.env.FILE_EXTRACTION_TIMEOUT_MS || '120000', 10);
const S3_OPERATION_TIMEOUT_MS = Number.parseInt(process.env.S3_OPERATION_TIMEOUT_MS || '60000', 10);
const FILE_SUMMARY_TEXT_LIMIT = Number.parseInt(process.env.FILE_SUMMARY_TEXT_LIMIT || '12000', 10);
const FILE_SUMMARY_CHUNK_CHARS = Number.parseInt(process.env.FILE_SUMMARY_CHUNK_CHARS || '4000', 10);
const FILE_SUMMARY_CHUNK_OVERLAP_CHARS = Number.parseInt(process.env.FILE_SUMMARY_CHUNK_OVERLAP_CHARS || '400', 10);
const FILE_SUMMARY_MAX_CHUNKS = Number.parseInt(process.env.FILE_SUMMARY_MAX_CHUNKS || '24', 10);
const FILE_SUMMARY_PENDING_STALE_MS = Number.parseInt(process.env.FILE_SUMMARY_PENDING_STALE_MS || '180000', 10);
const FILE_PDF_DIRECT_LLM_TIMEOUT_MS = Number.parseInt(process.env.FILE_PDF_DIRECT_LLM_TIMEOUT_MS || '30000', 10);
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
const require = createRequire(import.meta.url);
const PDFDocument = require('pdfkit');

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
const activeSummaryAbortControllers = new Map<string, AbortController>();
let vectorMysqlPool: mysql.Pool | null = null;

type SummaryStatus = 'pending' | 'completed' | 'failed' | 'skipped';
type ContentScope = 'business' | 'personal';

function buildSummaryJobKey(owner: string, fileId: number): string {
  return `${normalizeOwner(owner)}:${Math.floor(fileId)}`;
}

type FileSqlPlan = {
  delivery: 'attach' | 'none';
  sql: string;
};

type FileSearchMode = 'summary-like' | 'assistant' | 'embedding';

type SonjaReviewResult = {
  confidence: number;
  satisfied: boolean;
  refinedPrompt: string;
  matchedIds: number[];
  reason: string;
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
  'school',
  'grade',
  'class',
  'lesson',
  'homework',
  'assignment',
  'worksheet',
  'exam',
  'test',
  'subject',
  'student',
  'teacher',
  'math',
  'maths',
  'afrikaans',
  'english',
  'science',
  'history',
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

function stripSonjaPromptPrefix(prompt: string): string {
  const text = String(prompt || '').trim();
  if (!text) {
    return '';
  }
  return text
    .replace(/\bsonja\b/gi, ' ')
    .replace(/\bfiles?\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function isJpegAttachment(contentType: string, filename: string): boolean {
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  return type.includes('image/jpeg') || name.endsWith('.jpg') || name.endsWith('.jpeg');
}

function isPngAttachment(contentType: string, filename: string): boolean {
  const type = String(contentType || '').toLowerCase();
  const name = String(filename || '').toLowerCase();
  return type.includes('image/png') || name.endsWith('.png');
}

function toPdfFilename(filename: string): string {
  const name = String(filename || '').trim();
  if (!name) {
    return 'file.pdf';
  }
  if (name.toLowerCase().endsWith('.pdf')) {
    return name;
  }
  if (name.toLowerCase().endsWith('.png')) {
    return `${name.slice(0, -4)}.pdf`;
  }
  return `${name}.pdf`;
}

async function convertPngBufferToPdfBuffer(pngBuffer: Buffer): Promise<Buffer> {
  const metadata = await sharp(pngBuffer).metadata();
  const width = Math.max(1, Math.round(Number(metadata.width || 1200)));
  const height = Math.max(1, Math.round(Number(metadata.height || 1600)));
  return await new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({
      autoFirstPage: false,
      margin: 0,
      compress: true,
      size: [width, height],
    });
    const chunks: Uint8Array[] = [];
    doc.on('data', (chunk: Buffer | Uint8Array) => {
      chunks.push(chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk));
    });
    doc.on('end', () => resolve(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))));
    doc.on('error', reject);
    doc.addPage({ size: [width, height], margin: 0 });
    doc.image(pngBuffer, 0, 0, { fit: [width, height], align: 'center', valign: 'center' });
    doc.end();
  });
}

async function toVisionImageBase64(content: Buffer, contentType: string, filename: string): Promise<string> {
  if (!isImageAttachment(contentType, filename)) {
    return content.toString('base64');
  }
  if (isJpegAttachment(contentType, filename)) {
    return content.toString('base64');
  }
  try {
    // Normalize non-JPEG images (gif/png/webp/bmp/tiff) into a single-frame PNG.
    const normalized = await sharp(content)
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .png()
      .toBuffer();
    return normalized.toString('base64');
  } catch {
    return content.toString('base64');
  }
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
  const isJpegLike =
    String(contentType || '').toLowerCase().includes('image/jpeg') ||
    String(filename || '').toLowerCase().endsWith('.jpg') ||
    String(filename || '').toLowerCase().endsWith('.jpeg');

  if (businessScore > personalScore) {
    return 'business';
  }
  if (personalScore > businessScore) {
    return 'personal';
  }

  // Only JPG/JPEG images default to personal when no stronger business signal exists.
  if (isImage && isJpegLike) {
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

function isExtractionTimeoutError(err: unknown, label: string): boolean {
  const message = String((err as { message?: unknown })?.message || err || '').toLowerCase();
  return message.includes(`${label.toLowerCase()} timed out after`);
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

function toSafeChunkSize(value: number): number {
  if (!Number.isFinite(value) || value < 500) {
    return 4000;
  }
  return Math.floor(value);
}

function toSafeChunkOverlap(value: number, chunkSize: number): number {
  const overlap = Number.isFinite(value) ? Math.floor(value) : 0;
  if (overlap < 0) {
    return 0;
  }
  return Math.min(overlap, Math.max(0, chunkSize - 200));
}

function toSafeMaxChunks(value: number): number {
  if (!Number.isFinite(value) || value < 1) {
    return 24;
  }
  return Math.floor(value);
}

function splitTextIntoChunks(
  text: string,
  chunkSize: number,
  overlap: number,
  maxChunks: number = Number.MAX_SAFE_INTEGER,
): string[] {
  const normalized = String(text || '').trim();
  if (!normalized) {
    return [];
  }
  const chunks: string[] = [];
  let cursor = 0;
  const step = Math.max(1, chunkSize - overlap);
  while (cursor < normalized.length && chunks.length < maxChunks) {
    const end = Math.min(normalized.length, cursor + chunkSize);
    const part = normalized.slice(cursor, end).trim();
    if (part.length > 0) {
      chunks.push(part);
    }
    if (end >= normalized.length) {
      break;
    }
    cursor += step;
  }
  return chunks;
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
  options?: {
    model?: string;
    imageBase64?: string;
    fileBase64?: string;
    fileName?: string;
    fileContentType?: string;
    extraGuidance?: string[];
    signal?: AbortSignal;
  },
): Promise<string | null> {
  if (!ASSISTANT_URL) {
    return null;
  }
  const authorizationHeader = ASSISTANT_AUTH ? `Bearer ${ASSISTANT_AUTH}` : '';
  const url = ASSISTANT_URL.match(/^https?:\/\//i) ? ASSISTANT_URL : `http://${ASSISTANT_URL}`;
  const controller = new AbortController();
  const externalSignal = options?.signal;
  const abortFromExternal = (): void => {
    if (!controller.signal.aborted) {
      controller.abort();
    }
  };
  if (externalSignal) {
    if (externalSignal.aborted) {
      throw new Error('summary pipeline canceled');
    }
    externalSignal.addEventListener('abort', abortFromExternal, { once: true });
  }
  const timeoutMs =
    Number.isFinite(ASSISTANT_TIMEOUT_MS) && ASSISTANT_TIMEOUT_MS > 0 ? ASSISTANT_TIMEOUT_MS : 120000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const userLines = [
      'Create a detailed summary for the uploaded file.',
      'Use extracted text when available, else use filename/content type/caption.',
      'For images, infer key visible details directly from the image.',
      'Include important names, numbers, dates, places, topics, and key phrases to improve later search recall.',
      'Prefer completeness over brevity.',
      'Do not include labels and return summary text only.',
      ...(Array.isArray(options?.extraGuidance) ? options.extraGuidance : []),
      `Payload: ${JSON.stringify(payload)}`,
    ];
    const userMessage: Record<string, unknown> = {
      role: 'user',
      content: userLines.join('\n'),
    };
    if (options?.imageBase64) {
      userMessage.images = [options.imageBase64];
    }
    if (options?.fileBase64) {
      userMessage.files = [
        {
          filename: options.fileName || 'upload.bin',
          content_type: options.fileContentType || 'application/octet-stream',
          data: options.fileBase64,
        },
      ];
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
  } catch (err: any) {
    if (externalSignal?.aborted) {
      throw new Error('summary pipeline canceled');
    }
    if (err?.name === 'AbortError' && externalSignal?.aborted) {
      throw new Error('summary pipeline canceled');
    }
    return null;
  } finally {
    clearTimeout(timer);
    if (externalSignal) {
      externalSignal.removeEventListener('abort', abortFromExternal);
    }
  }
}

async function requestParsedSummaryFromAssistant(
  payload: Record<string, unknown>,
  options?: {
    model?: string;
    imageBase64?: string;
    fileBase64?: string;
    fileName?: string;
    fileContentType?: string;
    extraGuidance?: string[];
    signal?: AbortSignal;
  },
): Promise<{ raw: string; parsedSummary: string }> {
  const raw = await sendSummaryRequestToAssistant(payload, options);
  if (!raw) {
    throw new Error('Summary service returned an empty response');
  }
  const parsedSummary = parseAssistantSummary(raw);
  if (!parsedSummary) {
    throw new Error('Summary service response could not be parsed');
  }
  return { raw, parsedSummary };
}

async function summarizeExtractedTextInChunks(args: {
  basePayload: Record<string, unknown>;
  extractedText: string;
  model: string;
  signal?: AbortSignal;
}): Promise<{ raw: string; parsedSummary: string; chunkCount: number }> {
  const chunkSize = toSafeChunkSize(FILE_SUMMARY_CHUNK_CHARS);
  const chunkOverlap = toSafeChunkOverlap(FILE_SUMMARY_CHUNK_OVERLAP_CHARS, chunkSize);
  const maxChunksPerPass = toSafeMaxChunks(FILE_SUMMARY_MAX_CHUNKS);
  const chunks = splitTextIntoChunks(args.extractedText, chunkSize, chunkOverlap, Number.MAX_SAFE_INTEGER);
  if (chunks.length <= 1) {
    const single = await requestParsedSummaryFromAssistant(
      { ...args.basePayload, extracted_text: trimForSummary(args.extractedText, FILE_SUMMARY_TEXT_LIMIT) },
      { model: args.model, signal: args.signal },
    );
    return { ...single, chunkCount: 1 };
  }

  const chunkSummaries: string[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const chunkPayload = {
      ...args.basePayload,
      extracted_text: chunks[i],
      summary_strategy: 'chunk-map',
      chunk_index: i + 1,
      chunk_total: chunks.length,
    };
    const chunkResult = await requestParsedSummaryFromAssistant(chunkPayload, {
      model: args.model,
      signal: args.signal,
      extraGuidance: [
        `This is chunk ${i + 1} of ${chunks.length}.`,
        'Summarize only this chunk and keep details factual.',
      ],
    });
    chunkSummaries.push(chunkResult.parsedSummary);
  }

  const reduceOnce = async (
    summaries: string[],
    strategy: string,
    pass: number,
  ): Promise<{ raw: string; parsedSummary: string }> => {
    const mergedChunkText = summaries.map((value, index) => `Chunk ${index + 1}: ${value}`).join('\n');
    const reducePayload = {
      ...args.basePayload,
      extracted_text: trimForSummary(mergedChunkText, FILE_SUMMARY_TEXT_LIMIT),
      summary_strategy: strategy,
      chunk_total: summaries.length,
      reduce_pass: pass,
    };
    return await requestParsedSummaryFromAssistant(reducePayload, {
      model: args.model,
      signal: args.signal,
      extraGuidance: [
        'Combine the chunk summaries into one concise final summary.',
        'Preserve key entities, numbers, and document intent.',
      ],
    });
  };

  let pass = 1;
  let working = chunkSummaries.slice();
  let latestRaw = '';
  let latestSummary = '';
  while (working.length > maxChunksPerPass) {
    const nextRound: string[] = [];
    for (let start = 0; start < working.length; start += maxChunksPerPass) {
      const group = working.slice(start, start + maxChunksPerPass);
      if (group.length === 1) {
        nextRound.push(group[0]);
        continue;
      }
      const reduced = await reduceOnce(group, 'chunk-reduce-pass', pass);
      latestRaw = reduced.raw;
      latestSummary = reduced.parsedSummary;
      nextRound.push(reduced.parsedSummary);
    }
    working = nextRound;
    pass += 1;
  }

  if (working.length === 1) {
    return {
      raw: latestRaw || JSON.stringify({ ai_summary: working[0] }),
      parsedSummary: latestSummary || working[0],
      chunkCount: chunks.length,
    };
  }
  const finalReduce = await reduceOnce(working, 'chunk-reduce', pass);
  return { ...finalReduce, chunkCount: chunks.length };
}

function parseAssistantJsonContent(raw: string): Record<string, unknown> | null {
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
    } else if (outer && typeof outer === 'object') {
      return outer as Record<string, unknown>;
    }
    if (!content) {
      return null;
    }
    return JSON.parse(content) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeConfidence(value: unknown): number {
  const raw = Number(value);
  if (!Number.isFinite(raw)) {
    return 0;
  }
  return Math.max(0, Math.min(100, Math.round(raw)));
}

async function sleep(ms: number): Promise<void> {
  const waitMs = Number.isFinite(ms) ? Math.max(0, Math.floor(ms)) : 0;
  if (waitMs <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

function buildSonjaReviewChunks(rows: any[]): string[] {
  const maxChars = Math.max(2000, SONJA_REFINEMENT_REVIEW_CHARS);
  const maxChunks = Math.max(1, SONJA_REFINEMENT_MAX_REVIEW_CHUNKS);
  const limitedRows = rows.slice(0, Math.max(1, SONJA_REFINEMENT_MAX_ROWS));
  const chunks: string[] = [];
  let current = '';
  for (const row of limitedRows) {
    const line = JSON.stringify({
      id: Number(row?.id || 0),
      filename: String(row?.filename || ''),
      summary: trimForSummary(String(row?.summary || ''), 1600),
      caption: trimForSummary(String(row?.caption || ''), 400),
      created_at: String(row?.created_at || ''),
    });
    if (!line.trim()) {
      continue;
    }
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxChars) {
      if (current) {
        chunks.push(current);
      }
      current = line;
      if (chunks.length >= maxChunks) {
        break;
      }
      continue;
    }
    current = next;
  }
  if (current && chunks.length < maxChunks) {
    chunks.push(current);
  }
  return chunks.length > 0 ? chunks : [''];
}

async function sendSonjaReviewRequestToAssistant(payload: Record<string, unknown>): Promise<SonjaReviewResult | null> {
  if (!ASSISTANT_URL) {
    return null;
  }
  const authorizationHeader = ASSISTANT_AUTH ? `Bearer ${ASSISTANT_AUTH}` : '';
  const url = ASSISTANT_URL.match(/^https?:\/\//i) ? ASSISTANT_URL : `http://${ASSISTANT_URL}`;
  const timeoutMs = Number.isFinite(FILE_QUERY_ASSISTANT_TIMEOUT_MS) && FILE_QUERY_ASSISTANT_TIMEOUT_MS > 0
    ? FILE_QUERY_ASSISTANT_TIMEOUT_MS
    : 30000;
  const retries = Number.isFinite(FILE_QUERY_ASSISTANT_RETRIES) ? Math.max(0, FILE_QUERY_ASSISTANT_RETRIES) : 0;
  const retryDelayMs =
    Number.isFinite(FILE_QUERY_ASSISTANT_RETRY_DELAY_MS) && FILE_QUERY_ASSISTANT_RETRY_DELAY_MS > 0
      ? FILE_QUERY_ASSISTANT_RETRY_DELAY_MS
      : 1200;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
    const messagePayload = {
      Authorization: ASSISTANT_AUTH,
      authorization: ASSISTANT_AUTH,
      model: FILE_SQL_MODEL,
      messages: [
        {
          role: 'system',
          content:
            'You evaluate file-search relevance. Return ONLY valid JSON with fields: confidence (0-100 integer), satisfied (boolean), refined_prompt (string), matched_ids (number[]), reason (string).',
        },
        {
          role: 'user',
          content: [
            'Task: compare the user request with candidate file summaries.',
            'Rules:',
            '- confidence is how well candidate summaries match the user request.',
            '- satisfied=true only if confidence >= 80.',
            '- matched_ids: only ids that clearly match the user request.',
            '- Grade matching is strict only when user explicitly asks for strict/exact/only grade matching.',
            '- For grade ranges (for example 1 to 6), treat grades inside range as matches.',
            '- refined_prompt: improved search prompt to get closer matches if not satisfied.',
            '- reason: one short sentence.',
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
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    }
    const parsed = parseAssistantJsonContent(raw);
    if (!parsed) {
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    }
    const matchedRaw = Array.isArray(parsed.matched_ids) ? parsed.matched_ids : [];
    const matchedIds = matchedRaw
      .map((item) => Number(item))
      .filter((id) => Number.isFinite(id) && id > 0)
      .map((id) => Math.floor(id));
    const confidence = normalizeConfidence(parsed.confidence);
    const satisfied = Boolean(parsed.satisfied) || confidence >= SONJA_REFINEMENT_CONFIDENCE_THRESHOLD;
    return {
      confidence,
      satisfied,
      refinedPrompt: String(parsed.refined_prompt || '').trim(),
      matchedIds: Array.from(new Set(matchedIds)),
      reason: String(parsed.reason || '').trim(),
    };
    } catch {
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function sendSonjaJsonRequestToAssistant(args: {
  model: string;
  system: string;
  user: string;
  temperature?: number;
}): Promise<Record<string, unknown> | null> {
  if (!ASSISTANT_URL) {
    return null;
  }
  const authorizationHeader = ASSISTANT_AUTH ? `Bearer ${ASSISTANT_AUTH}` : '';
  const url = ASSISTANT_URL.match(/^https?:\/\//i) ? ASSISTANT_URL : `http://${ASSISTANT_URL}`;
  const timeoutMs = Number.isFinite(FILE_QUERY_ASSISTANT_TIMEOUT_MS) && FILE_QUERY_ASSISTANT_TIMEOUT_MS > 0
    ? FILE_QUERY_ASSISTANT_TIMEOUT_MS
    : 30000;
  const retries = Number.isFinite(FILE_QUERY_ASSISTANT_RETRIES) ? Math.max(0, FILE_QUERY_ASSISTANT_RETRIES) : 0;
  const retryDelayMs =
    Number.isFinite(FILE_QUERY_ASSISTANT_RETRY_DELAY_MS) && FILE_QUERY_ASSISTANT_RETRY_DELAY_MS > 0
      ? FILE_QUERY_ASSISTANT_RETRY_DELAY_MS
      : 1200;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const messagePayload = {
        Authorization: ASSISTANT_AUTH,
        authorization: ASSISTANT_AUTH,
        model: args.model,
        messages: [
          { role: 'system', content: args.system },
          { role: 'user', content: args.user },
        ],
        temperature: Number.isFinite(args.temperature) ? args.temperature : 0.1,
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
        if (attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        return null;
      }
      const parsed = parseAssistantJsonContent(raw);
      if (!parsed) {
        if (attempt < retries) {
          await sleep(retryDelayMs);
          continue;
        }
        return null;
      }
      return parsed;
    } catch {
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

function extractLanguageConstraintsFromPrompt(prompt: string): string[] {
  const text = String(prompt || '').toLowerCase();
  if (!text) {
    return [];
  }
  const patterns: Array<{ key: string; rx: RegExp }> = [
    { key: 'afrikaans', rx: /\bafrikaans\b/i },
    { key: 'english', rx: /\benglish\b/i },
    { key: 'isizulu', rx: /\bisizulu\b|\bzulu\b/i },
    { key: 'isixhosa', rx: /\bisixhosa\b|\bxhosa\b/i },
    { key: 'sepedi', rx: /\bsepedi\b|\bnorthern sotho\b/i },
    { key: 'setswana', rx: /\bsetswana\b|\btswana\b/i },
    { key: 'sesotho', rx: /\bsesotho\b/i },
    { key: 'xitsonga', rx: /\bxitsonga\b|\btsonga\b/i },
    { key: 'tshivenda', rx: /\btshivenda\b|\bvenda\b/i },
    { key: 'siswati', rx: /\bsiswati\b|\bswati\b/i },
    { key: 'isindebele', rx: /\bisindebele\b|\bndebele\b/i },
  ];
  return patterns.filter((item) => item.rx.test(text)).map((item) => item.key);
}

type SonjaPromptPlan = {
  keywords: string[];
  grades: number[];
  subjects: string[];
  languages: string[];
};

async function extractSonjaPromptPlan(prompt: string): Promise<SonjaPromptPlan> {
  const fallback = extractPromptSearchTokens(prompt).slice(0, 8);
  const parsed = await sendSonjaJsonRequestToAssistant({
    model: SONJA_KEYWORD_MODEL,
    system:
      'Extract a strict search plan from a user file query. Return ONLY JSON: {"keywords":["..."],"grades":[number],"subjects":["..."],"languages":["..."]}.',
    user: JSON.stringify({
      prompt,
      rules: [
        'Keep only nouns/key topics/grade/subject/language tokens.',
        'Exclude adjectives, greetings, and filler.',
        'Do not include "sonja", "file", or "files".',
        'If user specifies grade, include in grades.',
        'If user specifies subject, include in subjects.',
        'If user specifies language, include in languages.',
        'Return 3-8 keywords when possible.',
      ],
    }),
    temperature: 0,
  });
  const rawKeywords = Array.isArray(parsed?.keywords) ? parsed?.keywords : [];
  const keywords = rawKeywords
    .map((value) => String(value || '').trim().toLowerCase())
    .filter((value) => value.length >= 2)
    .map((value) => value.replace(/\s+/g, ' '))
    .filter((value) => value !== 'sonja' && value !== 'file' && value !== 'files');
  const grades = Array.isArray(parsed?.grades)
    ? parsed.grades
      .map((value) => Number(value))
      .filter((value) => Number.isFinite(value) && value >= 0 && value <= 12)
      .map((value) => Math.floor(value))
    : [];
  const subjects = Array.isArray(parsed?.subjects)
    ? parsed.subjects.map((value) => String(value || '').trim().toLowerCase()).filter((value) => value.length > 0)
    : [];
  const languages = Array.isArray(parsed?.languages)
    ? parsed.languages.map((value) => String(value || '').trim().toLowerCase()).filter((value) => value.length > 0)
    : [];

  const uniqueKeywords = Array.from(new Set(keywords));
  return {
    keywords: (uniqueKeywords.length > 0 ? uniqueKeywords : fallback).slice(0, 8),
    grades: Array.from(new Set(grades)),
    subjects: Array.from(new Set(subjects)),
    languages: Array.from(new Set(languages)),
  };
}

async function scoreSonjaCandidateMatch(args: {
  prompt: string;
  summary: string;
  filename: string;
  gradeConstraints: number[];
  subjectConstraints: string[];
  languageConstraints: string[];
}): Promise<{ score: number; matched: boolean; reason: string }> {
  const parsed = await sendSonjaJsonRequestToAssistant({
    model: SONJA_MATCH_MODEL,
    system:
      'You score how well a file summary matches a user query. Return ONLY JSON: {"score":0-100 integer,"matched":boolean,"reason":"short"}',
    user: JSON.stringify({
      user_prompt: args.prompt,
      candidate: {
        filename: args.filename,
        summary: trimForSummary(args.summary, 4000),
      },
      constraints: {
        grade: args.gradeConstraints,
        subject: args.subjectConstraints,
        language: args.languageConstraints,
      },
      rules: [
        'Honor constraints with strict AND logic.',
        'If user supplied grade(s), candidate must satisfy grade.',
        'If user supplied subject(s), candidate must satisfy subject.',
        'If user supplied language(s), candidate must satisfy language.',
        'If 2 constraints are supplied, both must match.',
        'If 3 constraints are supplied, all 3 must match.',
        `Only set matched=true when score >= ${SONJA_MATCH_CONFIDENCE}.`,
      ],
    }),
    temperature: 0.05,
  });
  const score = normalizeConfidence(parsed?.score);
  const matched = Boolean(parsed?.matched) && score >= SONJA_MATCH_CONFIDENCE;
  const reason = String(parsed?.reason || '').trim();
  return { score, matched, reason };
}

async function runSonjaSummaryIterativeSearch(args: {
  prompt: string;
  owner: string;
  dbCtx: DbContext;
  dateConstraint: DateConstraint | null;
}): Promise<{ rows: any[]; effectiveSql: string }> {
  const normalizedOwner = normalizeOwner(args.owner);
  const plan = await extractSonjaPromptPlan(args.prompt);
  const keywords = plan.keywords;
  const gradeConstraints = plan.grades;
  const subjectConstraints = plan.subjects;
  const languageConstraints = plan.languages;
  // eslint-disable-next-line no-console
  console.log(
    `[sonja-search] extracted keywords=${JSON.stringify(keywords)} grades=${JSON.stringify(gradeConstraints)} subjects=${JSON.stringify(subjectConstraints)} languages=${JSON.stringify(languageConstraints)}`,
  );
  const selected = new Map<number, { row: any; score: number; reason: string }>();
  let scanned = 0;
  let cursorId: number | null = null;
  const sqlParts: string[] = [];

  while (scanned < SONJA_SEARCH_MAX_SCAN_ROWS) {
    const clauses: string[] = ["COALESCE(content_scope,'business') <> 'personal'", "TRIM(COALESCE(summary,'')) <> ''"];
    const params: unknown[] = [];
    if (cursorId !== null) {
      clauses.push('id < ?');
      params.push(cursorId);
    }
    if (keywords.length > 0) {
      const keywordClauses: string[] = [];
      for (const keyword of keywords) {
        keywordClauses.push('LOWER(COALESCE(summary,\'\')) LIKE ?');
        params.push(tokenToLikePattern(keyword));
      }
      clauses.push(`(${keywordClauses.join(' OR ')})`);
    }
    if (args.dateConstraint) {
      clauses.push(`(${args.dateConstraint.clause})`);
      params.push(...args.dateConstraint.params);
    }
    params.push(SONJA_SEARCH_BATCH_SIZE);
    const sql =
      'SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, content_scope, summary_status, created_at ' +
      `FROM files WHERE ${clauses.join(' AND ')} ORDER BY id DESC LIMIT ?`;
    const batch = await args.dbCtx.dbAll(sql, ...params);
    sqlParts.push(sql);
    // eslint-disable-next-line no-console
    console.log(
      `[sonja-search] sqlite batch size=${Array.isArray(batch) ? batch.length : 0} cursor=${cursorId ?? 'none'} keywords=${JSON.stringify(keywords)}`,
    );
    if (Array.isArray(batch) && batch.length > 0) {
      const matchedList = batch
        .map((row) => `${Number(row?.id || 0)}:${String(row?.filename || '').trim() || '(unnamed)'}`)
        .join(' | ');
      // eslint-disable-next-line no-console
      console.log(`[sonja-search] sqlite batch matches ${matchedList}`);
    }
    if (!Array.isArray(batch) || batch.length === 0) {
      break;
    }
    scanned += batch.length;
    cursorId = Number(batch[batch.length - 1]?.id || 0);

    for (const row of batch) {
      const id = Number(row?.id);
      if (!Number.isFinite(id) || id <= 0 || selected.has(id)) {
        continue;
      }
      const summary = String(row?.summary || '').trim();
      if (!summary) {
        continue;
      }
      const scored = await scoreSonjaCandidateMatch({
        prompt: args.prompt,
        summary,
        filename: String(row?.filename || ''),
        gradeConstraints,
        subjectConstraints,
        languageConstraints,
      });
      if (!scored.matched) {
        continue;
      }
      selected.set(id, { row: { ...row, content_scope: 'business' }, score: scored.score, reason: scored.reason });
    }
  }

  const rows = Array.from(selected.values())
    .sort((a, b) => b.score - a.score)
    .map((item) => item.row);
  const debugSql =
    `/* sonja iterative summary search keywords=${JSON.stringify(keywords)} grades=${JSON.stringify(gradeConstraints)} ` +
    `subjects=${JSON.stringify(subjectConstraints)} languages=${JSON.stringify(languageConstraints)} scanned=${scanned} selected=${rows.length} */ ` +
    `${sqlParts.join(' ; ')}`;
  return { rows: await filterRowsForOwnerSearch({ owner: normalizedOwner, rows, dbCtx: args.dbCtx }), effectiveSql: debugSql };
}

async function reviewSonjaRowsAgainstPrompt(args: {
  originalPrompt: string;
  currentPrompt: string;
  iteration: number;
  rows: any[];
}): Promise<SonjaReviewResult | null> {
  const chunks = buildSonjaReviewChunks(args.rows);
  const collected: SonjaReviewResult[] = [];
  for (let i = 0; i < chunks.length; i += 1) {
    const review = await sendSonjaReviewRequestToAssistant({
      original_prompt: args.originalPrompt,
      current_prompt: args.currentPrompt,
      iteration: args.iteration,
      chunk_index: i + 1,
      chunk_total: chunks.length,
      candidates_ndjson: chunks[i],
    });
    if (review) {
      collected.push(review);
    }
  }
  if (collected.length === 0) {
    return null;
  }
  const matchedIds = Array.from(new Set(collected.flatMap((item) => item.matchedIds)));
  const confidence = Math.round(
    collected.reduce((sum, item) => sum + normalizeConfidence(item.confidence), 0) / Math.max(1, collected.length),
  );
  const satisfied = confidence >= SONJA_REFINEMENT_CONFIDENCE_THRESHOLD || collected.some((item) => item.satisfied);
  const refinedPrompt =
    collected
      .map((item) => item.refinedPrompt)
      .find((value) => value && value.trim().length > 0) || '';
  const reason =
    collected
      .map((item) => item.reason)
      .find((value) => value && value.trim().length > 0) || '';
  return { confidence, satisfied, refinedPrompt, matchedIds, reason };
}

async function sendSqlPlanRequestToAssistant(payload: Record<string, unknown>): Promise<string | null> {
  if (!ASSISTANT_URL) {
    return null;
  }
  const authorizationHeader = ASSISTANT_AUTH ? `Bearer ${ASSISTANT_AUTH}` : '';
  const url = ASSISTANT_URL.match(/^https?:\/\//i) ? ASSISTANT_URL : `http://${ASSISTANT_URL}`;
  const timeoutMs = Number.isFinite(FILE_QUERY_ASSISTANT_TIMEOUT_MS) && FILE_QUERY_ASSISTANT_TIMEOUT_MS > 0
    ? FILE_QUERY_ASSISTANT_TIMEOUT_MS
    : 30000;
  const retries = Number.isFinite(FILE_QUERY_ASSISTANT_RETRIES) ? Math.max(0, FILE_QUERY_ASSISTANT_RETRIES) : 0;
  const retryDelayMs =
    Number.isFinite(FILE_QUERY_ASSISTANT_RETRY_DELAY_MS) && FILE_QUERY_ASSISTANT_RETRY_DELAY_MS > 0
      ? FILE_QUERY_ASSISTANT_RETRY_DELAY_MS
      : 1200;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
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
            '- If payload.owner is sonja, use summary-based matching only. Do not use filename/caption/pdf_text/source_sender for semantic matching.',
            '- Apply strict grade constraints only when user explicitly asks for strict/exact/only grade matching.',
            '- Subject constraints are strict: for single-subject prompts (for example "grade 3 math"), avoid broad multi-subject summaries unless user explicitly asks for mixed/all-subject content.',
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
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    }
    return raw;
    } catch {
      if (attempt < retries) {
        await sleep(retryDelayMs);
        continue;
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
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

function sqlUsesNonSummaryTextSearch(sql: string): boolean {
  const normalized = String(sql || '').toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    /\bfilename\b/.test(normalized) ||
    /\bcaption\b/.test(normalized) ||
    /\bpdf_text\b/.test(normalized) ||
    /\bsource_sender\b/.test(normalized)
  );
}

function sqlTargetsPersonalScope(sql: string): boolean {
  const normalized = String(sql || '').toLowerCase().replace(/\s+/g, ' ');
  if (!normalized) {
    return false;
  }
  return /\bcontent_scope\s*=\s*'personal'\b/.test(normalized) || /\bcontent_scope\s+in\s*\(\s*'personal'\s*\)/.test(normalized);
}

function extractPromptSearchTokens(prompt: string): string[] {
  const stopwords = new Set([
    'a', 'an', 'and', 'any', 'about', 'for', 'from', 'find', 'get', 'give', 'show', 'list', 'search', 'look',
    'looking', 'me', 'my', 'the', 'to', 'with', 'files', 'file', 'documents', 'document', 'please', 'latest',
    'last', 'recent', 'upload', 'uploads', 'other', 'thing', 'things', 'stuff',
  ]);
  const tokens = String(prompt || '')
    .toLowerCase()
    .split(/[^a-z0-9@._-]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && !stopwords.has(token));
  return Array.from(new Set(tokens)).slice(0, 5);
}

function tokenToLikePattern(token: string): string {
  const normalized = String(token || '')
    .toLowerCase()
    .trim()
    .replace(/[_\-\s]+/g, '%')
    .replace(/%+/g, '%');
  if (!normalized) {
    return '%%';
  }
  return `%${normalized}%`;
}

function parseGradeNumbersFromText(text: string): number[] {
  const out = new Set<number>();
  const normalized = String(text || '')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!normalized) {
    return [];
  }

  const rangeRegex = /\b(?:grade|grades|graad)\s*(\d{1,2})\s*(?:to|through|tot|\-)\s*(\d{1,2})\b/gi;
  let rangeMatch: RegExpExecArray | null;
  while ((rangeMatch = rangeRegex.exec(normalized)) !== null) {
    const left = Number(rangeMatch[1]);
    const right = Number(rangeMatch[2]);
    if (!Number.isFinite(left) || !Number.isFinite(right)) {
      continue;
    }
    const start = Math.max(0, Math.min(left, right));
    const end = Math.min(12, Math.max(left, right));
    for (let i = start; i <= end; i += 1) {
      out.add(i);
    }
  }

  const singleRegex = /\b(?:grade|grades|graad)\s*(\d{1,2})\b/gi;
  let singleMatch: RegExpExecArray | null;
  while ((singleMatch = singleRegex.exec(normalized)) !== null) {
    const value = Number(singleMatch[1]);
    if (Number.isFinite(value) && value >= 0 && value <= 12) {
      out.add(value);
    }
  }
  return Array.from(out).sort((a, b) => a - b);
}

function promptRequestsStrictGradeMatching(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  if (!text) {
    return false;
  }
  return (
    /\bstrict\b/.test(text) ||
    /\bexact\b/.test(text) ||
    /\bonly\b/.test(text) ||
    /\bmust match\b/.test(text) ||
    /\bno other grades?\b/.test(text) ||
    /\bexclude other grades?\b/.test(text) ||
    /\bjust grade\b/.test(text)
  );
}

function applyGradeConstraintFilter(
  rows: any[],
  prompt: string,
  options?: { requireGradeInSummary?: boolean },
): any[] {
  const promptGrades = parseGradeNumbersFromText(prompt);
  if (promptGrades.length === 0) {
    return rows;
  }
  if (!promptRequestsStrictGradeMatching(prompt)) {
    return rows;
  }
  const requireGradeInSummary = Boolean(options?.requireGradeInSummary);
  const allowed = new Set(promptGrades);
  return rows.filter((row) => {
    const summaryGrades = parseGradeNumbersFromText(String(row?.summary || ''));
    if (summaryGrades.length === 0) {
      return !requireGradeInSummary;
    }
    return summaryGrades.some((grade) => allowed.has(grade));
  });
}

type SubjectKey = 'math' | 'afrikaans' | 'english' | 'science' | 'history' | 'geography' | 'language';

const SUBJECT_PATTERNS: Record<SubjectKey, RegExp[]> = {
  math: [
    /\bmath\b/i,
    /\bmaths\b/i,
    /\bmathematics\b/i,
    /\bwiskunde\b/i,
    /\barithmetic\b/i,
    /\bgeometry\b/i,
    /\bfractions?\b/i,
    /\baddition\b/i,
    /\bsubtraction\b/i,
    /\bmultiplication\b/i,
    /\bdivision\b/i,
    /\bnumber (?:line|sequence|names?)\b/i,
  ],
  afrikaans: [/\bafrikaans\b/i],
  english: [/\benglish\b/i],
  science: [/\bscience\b/i, /\bnatuurwetenskap\b/i],
  history: [/\bhistory\b/i, /\bgeskiedenis\b/i],
  geography: [/\bgeography\b/i, /\baardrykskunde\b/i],
  language: [
    /\bword search\b/i,
    /\bwordsearch\b/i,
    /\bword-search\b/i,
    /\bvocabulary\b/i,
    /\bspelling\b/i,
    /\bcomprehension\b/i,
    /\breading\b/i,
  ],
};

const LANGUAGE_HEAVY_PATTERNS = [
  /\bword search\b/i,
  /\bvocabulary\b/i,
  /\bspelling\b/i,
  /\breading comprehension\b/i,
  /\bcomprehension\b/i,
  /\bphonics\b/i,
];

function detectSubjects(text: string): Set<SubjectKey> {
  const out = new Set<SubjectKey>();
  const raw = String(text || '');
  for (const [subject, patterns] of Object.entries(SUBJECT_PATTERNS) as Array<[SubjectKey, RegExp[]]>) {
    if (patterns.some((pattern) => pattern.test(raw))) {
      out.add(subject);
    }
  }
  return out;
}

function promptAllowsMixedSubjects(prompt: string): boolean {
  const text = String(prompt || '').toLowerCase();
  return /\b(all subjects|all subject|mixed|workbook|term work|overview|full pack|complete)\b/.test(text);
}

function applySubjectConstraintFilter(rows: any[], prompt: string): any[] {
  const promptSubjects = detectSubjects(prompt);
  if (promptSubjects.size === 0) {
    return rows;
  }
  const allowMixed = promptAllowsMixedSubjects(prompt);
  const promptSubjectList = Array.from(promptSubjects);
  return rows.filter((row) => {
    const summary = String(row?.summary || '');
    const summarySubjects = detectSubjects(summary);
    const isMathPrompt = promptSubjects.has('math');
    const isLanguagePrompt = promptSubjects.has('language');
    const hasMathSignal = SUBJECT_PATTERNS.math.some((pattern) => pattern.test(summary));
    const isLanguageHeavy = LANGUAGE_HEAVY_PATTERNS.some((pattern) => pattern.test(summary));
    const wantsLanguage = promptSubjects.has('language') || promptSubjects.has('english') || promptSubjects.has('afrikaans');

    if (isMathPrompt) {
      if (!hasMathSignal) {
        return false;
      }
      if (isLanguageHeavy && !hasMathSignal) {
        return false;
      }
    } else if (isLanguagePrompt) {
      if (!isLanguageHeavy) {
        return false;
      }
      // Keep language requests focused: exclude math-only summaries.
      if (hasMathSignal && !wantsLanguage) {
        return false;
      }
    } else if (summarySubjects.size === 0) {
      return false;
    }
    if (isLanguageHeavy && !wantsLanguage) {
      return false;
    }

    const hasRequested = promptSubjectList.some((subject) => summarySubjects.has(subject));
    if (!hasRequested) {
      return false;
    }
    // For single-subject prompts, suppress broad multi-subject summaries unless user asked for mixed content.
    if (!allowMixed && promptSubjectList.length === 1 && summarySubjects.size >= 3) {
      return false;
    }
    return true;
  });
}

function applyPromptTokenRelevanceFilter(rows: any[], prompt: string): any[] {
  const tokens = extractPromptSearchTokens(prompt);
  if (tokens.length === 0) {
    return rows;
  }
  const tokenPatterns = tokens.map((token) => new RegExp(`\\b${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'));
  return rows.filter((row) => {
    const summary = String(row?.summary || '');
    if (!summary) {
      return false;
    }
    return tokenPatterns.some((pattern) => pattern.test(summary));
  });
}

function canUseSonjaEmbeddingSearch(): boolean {
  return (
    SONJA_EMBEDDING_SEARCH_ENABLED &&
    Boolean(SONJA_EMBEDDING_OLLAMA_URL) &&
    Boolean(VECTOR_MYSQL_DATABASE) &&
    Boolean(VECTOR_MYSQL_USER) &&
    Boolean(VECTOR_MYSQL_PASSWORD)
  );
}

async function getVectorMysqlPool(): Promise<mysql.Pool> {
  if (vectorMysqlPool) {
    return vectorMysqlPool;
  }
  vectorMysqlPool = mysql.createPool({
    host: VECTOR_MYSQL_HOST || '127.0.0.1',
    port: Number.isFinite(VECTOR_MYSQL_PORT) && VECTOR_MYSQL_PORT > 0 ? VECTOR_MYSQL_PORT : 3306,
    database: VECTOR_MYSQL_DATABASE,
    user: VECTOR_MYSQL_USER,
    password: VECTOR_MYSQL_PASSWORD,
    waitForConnections: true,
    connectionLimit: 5,
    queueLimit: 0,
    charset: 'utf8mb4',
  });
  return vectorMysqlPool;
}

function vectorDot(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += (a[i] || 0) * (b[i] || 0);
  }
  return sum;
}

function vectorNorm(a: number[]): number {
  return Math.sqrt(vectorDot(a, a));
}

function vectorCosine(a: number[], b: number[], na: number, nb: number): number {
  if (!na || !nb) {
    return 0;
  }
  return vectorDot(a, b) / (na * nb);
}

function toEmbeddingVector(raw: unknown): number[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value));
}

async function embedPromptForSonjaSearch(prompt: string): Promise<number[]> {
  const response = await withTimeout(
    fetch(`${SONJA_EMBEDDING_OLLAMA_URL}/api/embed`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        model: SONJA_EMBEDDING_MODEL,
        input: prompt,
      }),
    }),
    FILE_QUERY_ASSISTANT_TIMEOUT_MS,
    'sonja embedding request',
  );
  const raw = await response.text();
  if (!response.ok) {
    throw new Error(`sonja embedding query failed (${response.status}): ${raw}`);
  }
  const parsed = JSON.parse(raw);
  const vector = Array.isArray(parsed?.embeddings) ? parsed.embeddings[0] : parsed?.embedding;
  const out = toEmbeddingVector(vector);
  if (out.length === 0) {
    throw new Error('sonja embedding query returned empty vector');
  }
  return out;
}

function parseSubjectFiltersFromPrompt(prompt: string): string[] {
  const subjects = Array.from(detectSubjects(prompt));
  if (subjects.length === 0) {
    return [];
  }
  const expanded = new Set<string>();
  for (const subject of subjects) {
    if (subject === 'language') {
      expanded.add('afrikaans');
      expanded.add('english');
      continue;
    }
    expanded.add(subject);
  }
  return Array.from(expanded).filter((value) => value !== 'unknown');
}

async function runSonjaEmbeddingSearch(args: {
  prompt: string;
  owner: string;
}): Promise<{ ids: number[]; debugSql: string }> {
  if (!canUseSonjaEmbeddingSearch()) {
    return { ids: [], debugSql: '/* sonja embedding search unavailable: missing config */' };
  }
  const pool = await getVectorMysqlPool();
  const queryVec = await embedPromptForSonjaSearch(args.prompt);
  const queryNorm = vectorNorm(queryVec);
  const tokens = extractPromptSearchTokens(args.prompt).slice(0, 8);
  const gradeNumbers = parseGradeNumbersFromText(args.prompt);
  const subjects = parseSubjectFiltersFromPrompt(args.prompt);
  const where: string[] = ['owner = ?'];
  const params: unknown[] = [normalizeOwner(args.owner)];
  if (gradeNumbers.length > 0) {
    const placeholders = gradeNumbers.map(() => '?').join(',');
    where.push(`grade IN (${placeholders})`);
    params.push(...gradeNumbers);
  }
  if (subjects.length > 0) {
    const placeholders = subjects.map(() => '?').join(',');
    where.push(`subject IN (${placeholders})`);
    params.push(...subjects);
  }
  if (tokens.length > 0) {
    const tokenClauses: string[] = [];
    for (const token of tokens) {
      tokenClauses.push('(LOWER(COALESCE(filename,\'\')) LIKE ? OR LOWER(COALESCE(summary,\'\')) LIKE ?)');
      const like = tokenToLikePattern(token);
      params.push(like, like);
    }
    where.push(`(${tokenClauses.join(' OR ')})`);
  }
  const candidateLimit = Math.max(100, Math.min(10000, Number.isFinite(SONJA_EMBEDDING_CANDIDATE_LIMIT) ? SONJA_EMBEDDING_CANDIDATE_LIMIT : 2000));
  params.push(candidateLimit);
  const sql =
    'SELECT file_id, filename, chunk_index, embedding_json ' +
    'FROM sonja_file_embedding_chunks ' +
    `WHERE ${where.join(' AND ')} ` +
    'ORDER BY updated_at DESC LIMIT ?';

  const [rows] = await pool.query(sql, params);
  const rankedByFile = new Map<number, { fileId: number; score: number }>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const fileId = Number((row as any)?.file_id);
    if (!Number.isFinite(fileId) || fileId <= 0) {
      continue;
    }
    const embeddingRaw = (row as any)?.embedding_json;
    let parsed: unknown = embeddingRaw;
    if (typeof embeddingRaw === 'string') {
      try {
        parsed = JSON.parse(embeddingRaw);
      } catch {
        parsed = null;
      }
    }
    const vec = toEmbeddingVector(parsed);
    if (vec.length === 0) {
      continue;
    }
    const score = vectorCosine(vec, queryVec, vectorNorm(vec), queryNorm);
    if (Number.isFinite(SONJA_EMBEDDING_MIN_SCORE) && score < SONJA_EMBEDDING_MIN_SCORE) {
      continue;
    }
    const existing = rankedByFile.get(fileId);
    if (!existing || score > existing.score) {
      rankedByFile.set(fileId, { fileId, score });
    }
  }
  const ids = Array.from(rankedByFile.values())
    .sort((a, b) => b.score - a.score)
    .slice(0, FILE_SQL_MAX_ROWS)
    .map((entry) => entry.fileId);
  return { ids, debugSql: `${sql} /* vector-ranked files=${ids.length} */` };
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
    const like = tokenToLikePattern(token);
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
      'SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, content_scope, summary_status, created_at ' +
      `FROM files WHERE (${clauses.join(' OR ')})` +
      (dateConstraint ? ` AND (${dateConstraint.clause})` : '') +
      ` ORDER BY id DESC LIMIT ${FILE_SQL_MAX_ROWS}`,
    params: [...params, ...(dateConstraint ? dateConstraint.params : [])],
  };
}

function buildSummaryFallbackQuery(prompt: string, dateConstraint: DateConstraint | null): { sql: string; params: string[] } | null {
  const tokens = extractPromptSearchTokens(prompt);
  const gradeNumbers = parseGradeNumbersFromText(prompt);
  if (tokens.length === 0 && gradeNumbers.length === 0) {
    return null;
  }
  const tokenClauses: string[] = [];
  const gradeClauses: string[] = [];
  const params: string[] = [];
  for (const token of tokens) {
    tokenClauses.push(`lower(coalesce(summary,'')) LIKE ?`);
    params.push(tokenToLikePattern(token));
  }
  for (const grade of gradeNumbers) {
    gradeClauses.push(`(lower(coalesce(summary,'')) LIKE ? OR lower(coalesce(summary,'')) LIKE ?)`);
    params.push(`%grade ${grade}%`, `%graad ${grade}%`);
  }
  const whereParts: string[] = [];
  if (tokenClauses.length > 0) {
    whereParts.push(`(${tokenClauses.join(' OR ')})`);
  }
  if (gradeClauses.length > 0) {
    whereParts.push(`(${gradeClauses.join(' OR ')})`);
  }
  const baseWhere = whereParts.length > 0 ? whereParts.join(' AND ') : '1=0';
  return {
    sql:
      'SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, content_scope, summary_status, created_at ' +
      `FROM files WHERE ${baseWhere}` +
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
  return args.rows
    .map((row) => {
      const id = Number(row?.id);
      if (!Number.isFinite(id) || id <= 0) {
        return null;
      }
      const scope = scopeById.get(Math.floor(id)) || 'business';
      if (scope === 'personal') {
        return null;
      }
      return { ...row, content_scope: scope };
    })
    .filter((row): row is any => Boolean(row));
}

async function runFileSearchQuery(args: {
  prompt: string;
  owner: string;
  dbCtx: DbContext;
  sourceChannel: string;
  sourceFrom: string;
}): Promise<{ rows: any[]; effectiveSql: string; delivery: 'attach' | 'none'; searchMode: FileSearchMode }> {
  const isSonjaOwner = normalizeOwner(args.owner) === SONJA_OWNER;
  const dateConstraint = extractDateConstraintFromPrompt(args.prompt);
  if (isSonjaOwner) {
    const sonjaPrompt = String(args.prompt || '').trim();
    const iterative = await runSonjaSummaryIterativeSearch({
      prompt: sonjaPrompt,
      owner: args.owner,
      dbCtx: args.dbCtx,
      dateConstraint,
    });
    const delivery = wantsFileDelivery(args.prompt) ? 'attach' : 'none';
    return { rows: iterative.rows, effectiveSql: iterative.effectiveSql, delivery, searchMode: 'summary-like' };
  }

  const planPayload = {
    prompt: args.prompt,
    owner: args.owner,
    source_channel: args.sourceChannel || null,
    source_from: args.sourceFrom || null,
  };
  const rawPlan = FILE_QUERY_USE_ASSISTANT ? await sendSqlPlanRequestToAssistant(planPayload) : null;
  const parsedPlan = rawPlan ? parseFileSqlPlan(rawPlan) : null;
  const strictSonjaAssistant = isSonjaOwner && SONJA_STRICT_LLM_COMPLETION;
  if (strictSonjaAssistant && FILE_QUERY_USE_ASSISTANT && (!rawPlan || !parsedPlan || !parsedPlan.sql)) {
    throw new Error('assistant plan was incomplete; refusing fallback for strict sonja query');
  }
  const fallbackSql =
    `SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, content_scope, summary_status, created_at FROM files ORDER BY id DESC LIMIT ${FILE_SQL_MAX_ROWS}`;
  const summaryFirstQuery = buildSummaryFallbackQuery(args.prompt, dateConstraint);
  let rows = summaryFirstQuery ? await args.dbCtx.dbAll(summaryFirstQuery.sql, ...summaryFirstQuery.params) : [];
  rows = await filterRowsForOwnerSearch({ owner: args.owner, rows, dbCtx: args.dbCtx });
  rows = applyGradeConstraintFilter(rows, args.prompt, { requireGradeInSummary: isSonjaOwner });
  if (isSonjaOwner) {
    rows = applySubjectConstraintFilter(rows, args.prompt);
    rows = applyPromptTokenRelevanceFilter(rows, args.prompt);
  }
  let effectiveSql = summaryFirstQuery?.sql || '';
  let sql = enforceSafeFileSql(parsedPlan?.sql || fallbackSql);
  if (sqlHasSourceConstraint(sql) && !promptMentionsSourceConstraint(args.prompt)) {
    sql = fallbackSql;
  }
  if (isSonjaOwner && sqlUsesNonSummaryTextSearch(sql)) {
    sql = summaryFirstQuery?.sql || fallbackSql;
  }
  if (isSonjaOwner && sqlTargetsPersonalScope(sql)) {
    sql = summaryFirstQuery?.sql || fallbackSql;
  }
  if (rows.length === 0) {
    if (dateConstraint && !sqlHasDateConstraint(sql)) {
      sql = fallbackSql;
    }
    rows = await args.dbCtx.dbAll(sql);
    rows = await filterRowsForOwnerSearch({ owner: args.owner, rows, dbCtx: args.dbCtx });
    rows = applyGradeConstraintFilter(rows, args.prompt, { requireGradeInSummary: isSonjaOwner });
    if (isSonjaOwner) {
      rows = applySubjectConstraintFilter(rows, args.prompt);
      rows = applyPromptTokenRelevanceFilter(rows, args.prompt);
    }
    effectiveSql = sql;
  }
  if ((!rows || rows.length === 0) && args.prompt) {
    const fallbackQuery = isSonjaOwner
      ? buildSummaryFallbackQuery(args.prompt, dateConstraint)
      : buildContentFallbackQuery(args.prompt, dateConstraint);
    if (fallbackQuery) {
      let fallbackRows = await args.dbCtx.dbAll(fallbackQuery.sql, ...fallbackQuery.params);
      fallbackRows = await filterRowsForOwnerSearch({ owner: args.owner, rows: fallbackRows, dbCtx: args.dbCtx });
      fallbackRows = applyGradeConstraintFilter(fallbackRows, args.prompt, { requireGradeInSummary: isSonjaOwner });
      if (isSonjaOwner) {
        fallbackRows = applySubjectConstraintFilter(fallbackRows, args.prompt);
        fallbackRows = applyPromptTokenRelevanceFilter(fallbackRows, args.prompt);
      }
      if (fallbackRows.length > 0) {
        rows = fallbackRows;
        effectiveSql = fallbackQuery.sql;
      }
    }
  }
  if (isSonjaOwner) {
    effectiveSql = `${effectiveSql || fallbackSql} /* personal scope excluded for sonja */`;
  }
  const delivery = parsedPlan?.delivery === 'attach' || wantsFileDelivery(args.prompt) ? 'attach' : 'none';
  return { rows, effectiveSql, delivery, searchMode: 'assistant' };
}

async function refineSonjaSearchResults(args: {
  originalPrompt: string;
  owner: string;
  dbCtx: DbContext;
  sourceChannel: string;
  sourceFrom: string;
  initialRows: any[];
  initialSql: string;
}): Promise<{ rows: any[]; effectiveSql: string; confidence: number; iterations: number }> {
  if (normalizeOwner(args.owner) !== SONJA_OWNER) {
    return { rows: args.initialRows, effectiveSql: args.initialSql, confidence: 0, iterations: 0 };
  }
  if (SONJA_STRICT_LLM_COMPLETION && !FILE_QUERY_USE_ASSISTANT) {
    throw new Error('FILE_QUERY_USE_ASSISTANT must be enabled for strict sonja query');
  }
  if (SONJA_STRICT_LLM_COMPLETION && !SONJA_REFINEMENT_ENABLED) {
    throw new Error('SONJA_REFINEMENT_ENABLED must be enabled for strict sonja query');
  }
  if (!SONJA_REFINEMENT_ENABLED) {
    return { rows: args.initialRows, effectiveSql: args.initialSql, confidence: 0, iterations: 0 };
  }
  if (!ASSISTANT_URL) {
    return { rows: args.initialRows, effectiveSql: args.initialSql, confidence: 0, iterations: 0 };
  }
  const maxIterations = Math.max(0, SONJA_REFINEMENT_MAX_ITERATIONS);
  if (SONJA_STRICT_LLM_COMPLETION && maxIterations <= 0) {
    throw new Error('SONJA_REFINEMENT_MAX_ITERATIONS must be greater than 0 for strict sonja query');
  }
  if (maxIterations <= 0) {
    return { rows: args.initialRows, effectiveSql: args.initialSql, confidence: 0, iterations: 0 };
  }
  const normalizedOriginalPrompt =
    normalizeOwner(args.owner) === SONJA_OWNER ? stripSonjaPromptPrefix(args.originalPrompt) : args.originalPrompt;
  let currentPrompt = normalizedOriginalPrompt;
  let currentRows = Array.isArray(args.initialRows) ? args.initialRows : [];
  let currentSql = args.initialSql;
  let finalConfidence = 0;
  let appliedIterations = 0;
  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (!Array.isArray(currentRows) || currentRows.length === 0) {
      break;
    }
    const review = await reviewSonjaRowsAgainstPrompt({
      originalPrompt: normalizedOriginalPrompt,
      currentPrompt,
      iteration,
      rows: currentRows,
    });
    if (!review) {
      if (SONJA_STRICT_LLM_COMPLETION) {
        throw new Error('assistant refinement review did not complete for strict sonja query');
      }
      break;
    }
    appliedIterations = iteration;
    finalConfidence = review.confidence;
    if (review.matchedIds.length > 0) {
      const matched = new Set(review.matchedIds);
      const filtered = currentRows.filter((row) => matched.has(Number(row?.id)));
      if (filtered.length > 0) {
        currentRows = filtered;
      }
    }
    if (review.satisfied || review.confidence >= SONJA_REFINEMENT_CONFIDENCE_THRESHOLD) {
      break;
    }
    const refinedPromptRaw = String(review.refinedPrompt || '').trim();
    const refinedPrompt = normalizeOwner(args.owner) === SONJA_OWNER
      ? stripSonjaPromptPrefix(refinedPromptRaw)
      : refinedPromptRaw;
    if (!refinedPrompt || refinedPrompt.toLowerCase() === currentPrompt.toLowerCase()) {
      break;
    }
    currentPrompt = refinedPrompt;
    const nextQuery = await runFileSearchQuery({
      prompt: currentPrompt,
      owner: args.owner,
      dbCtx: args.dbCtx,
      sourceChannel: args.sourceChannel,
      sourceFrom: args.sourceFrom,
    });
    currentRows = nextQuery.rows;
    currentSql = `${nextQuery.effectiveSql} /* sonja refinement iteration=${iteration} confidence=${review.confidence} */`;
  }
  return { rows: currentRows, effectiveSql: currentSql, confidence: finalConfidence, iterations: appliedIterations };
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
  owner: string;
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
  contentScope: ContentScope;
  baseMetadata: Record<string, string>;
  content: Buffer;
}): Promise<void> {
  const jobKey = buildSummaryJobKey(args.owner, args.fileId);
  const abortController = new AbortController();
  activeSummaryAbortControllers.set(jobKey, abortController);
  let extractedPdfText = '';
  let summary: string | null = null;
  let summaryRawResponse = '';
  let summaryError = '';
  let summaryModel = ASSISTANT_MODEL;
  let extractor: string | null = null;
  let resolvedContentScope: ContentScope = args.contentScope;
  let usedPdfImageFallback = false;
  let useDirectPdfLlmFallback = false;
  let rawFileBase64: string | null = null;
  try {
    const isPdf = isPdfAttachment(args.contentType, args.filename);
    const isWord = isWordAttachment(args.contentType, args.filename);
    const isImage = isImageAttachment(args.contentType, args.filename);
    if (!isPdf && !isWord && !isImage) {
      throw new Error('Unsupported extractable file type');
    }
    if (isPdf) {
      const pdfExtractionBudgetMs =
        Number.isFinite(FILE_PDF_DIRECT_LLM_TIMEOUT_MS) && FILE_PDF_DIRECT_LLM_TIMEOUT_MS > 0
          ? FILE_PDF_DIRECT_LLM_TIMEOUT_MS
          : FILE_EXTRACTION_TIMEOUT_MS;
      try {
        extractedPdfText = normalizeWhitespace(
          await withTimeout(extractPdfTextFromBuffer(args.content), pdfExtractionBudgetMs, 'pdf extraction'),
        );
      } catch (pdfExtractionError: unknown) {
        if (!isExtractionTimeoutError(pdfExtractionError, 'pdf extraction')) {
          throw pdfExtractionError;
        }
        // eslint-disable-next-line no-console
        console.warn(`[mservice-file][summary] pdf extraction timed out; using direct file LLM fallback fileId=${args.fileId} filename=${args.filename}`);
        useDirectPdfLlmFallback = true;
        extractor = 'pdf-direct-llm-fallback';
        extractedPdfText = '';
        rawFileBase64 = args.content.toString('base64');
      }
      if (hasMeaningfulPdfText(extractedPdfText)) {
        extractor = 'pdf2json';
      } else if (!useDirectPdfLlmFallback) {
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
      const canAttachRawFilePayload = isPdf && useDirectPdfLlmFallback && !!rawFileBase64;
      const payload = buildSummaryPayload(useImageInput, usedPdfImageFallback);
      const normalizedImageBase64 = canAttachImagePayload
        ? await toVisionImageBase64(args.content, args.contentType, args.filename)
        : undefined;
      return await requestParsedSummaryFromAssistant(payload, {
        model: summaryModel,
        imageBase64: normalizedImageBase64,
        fileBase64: canAttachRawFilePayload ? rawFileBase64 || undefined : undefined,
        fileName: canAttachRawFilePayload ? args.filename : undefined,
        fileContentType: canAttachRawFilePayload ? args.contentType : undefined,
        extraGuidance: canAttachRawFilePayload
          ? [
            'PDF text extraction timed out; use the attached PDF document directly to generate the summary.',
          ]
          : undefined,
        signal: abortController.signal,
      });
    };

    const useImageSummaryInput = isImage || usedPdfImageFallback;
    try {
      const shouldUseChunkedSummary =
        !useImageSummaryInput &&
        extractedPdfText.length > Math.max(toSafeChunkSize(FILE_SUMMARY_CHUNK_CHARS), FILE_SUMMARY_TEXT_LIMIT);
      const firstAttempt = shouldUseChunkedSummary
        ? await summarizeExtractedTextInChunks({
          basePayload: buildSummaryPayload(false, usedPdfImageFallback),
          extractedText: extractedPdfText,
          model: summaryModel,
          signal: abortController.signal,
        })
        : await requestSummary(useImageSummaryInput);
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

    resolvedContentScope = inferContentScope({
      contentType: args.contentType,
      filename: args.filename,
      caption: args.caption,
      summary,
      extractedText: extractedPdfText,
      requestedScope: args.contentScope,
    });
    const metadataWithSummary: Record<string, string> = {
      ...args.baseMetadata,
      ...(metadataValue(summary, 512) ? { summary: metadataValue(summary, 512)! } : {}),
      content_scope: resolvedContentScope,
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
           content_scope = ?,
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
      resolvedContentScope,
      summaryModel,
      summaryRawResponse || null,
      JSON.stringify({ ...args.baseMetadata, content_scope: resolvedContentScope, summary: safeSummarySnippet(summary, 512) }),
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
           content_scope = ?,
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
      resolvedContentScope,
      summaryError,
      summaryModel,
      summaryRawResponse || null,
      JSON.stringify({ ...args.baseMetadata, content_scope: resolvedContentScope }),
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
  } finally {
    activeSummaryAbortControllers.delete(jobKey);
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
    let contentType = typeof req.body?.content_type === 'string' ? req.body.content_type.trim() : 'application/octet-stream';
    let filename = sanitizeFilename(typeof req.body?.filename === 'string' ? req.body.filename.trim() : '');
    const source = typeof req.body?.source === 'string' ? req.body.source.trim() : '';
    const sourceSender = typeof req.body?.source_sender === 'string' ? req.body.source_sender.trim() : '';
    const sourceMessageId =
      typeof req.body?.source_message_id === 'string' ? req.body.source_message_id.trim() : '';
    const caption = typeof req.body?.caption === 'string' ? req.body.caption : '';
    const requestedContentScope = req.body?.content_scope;
    const callbackUrl = typeof req.body?.callback_url === 'string' ? req.body.callback_url.trim() : '';
    const callbackAuthorization =
      typeof req.body?.callback_authorization === 'string' ? req.body.callback_authorization.trim() : '';
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

    const originalBytes = Buffer.from(dataBase64, 'base64');
    let bytes = originalBytes;
    let convertedPngToPdf = false;
    if (isPngAttachment(contentType, filename)) {
      try {
        bytes = Buffer.from(await convertPngBufferToPdfBuffer(originalBytes));
        filename = toPdfFilename(filename);
        contentType = 'application/pdf';
        convertedPngToPdf = true;
      } catch (conversionError: any) {
        // eslint-disable-next-line no-console
        console.warn(`[mservice-file][upload] png->pdf conversion failed, using original PNG: ${String(conversionError?.message || conversionError)}`);
      }
    }
    const key = toUploadKey({ source: `${owner}/${source || 'ui'}`, filename, providedKey });
    const contentHash = crypto.createHash('sha256').update(originalBytes).digest('hex');
    const initialContentScope = inferContentScope({
      contentType,
      filename,
      caption,
      requestedScope: requestedContentScope,
    });
    const skipSummaryForJpeg = isJpegAttachment(contentType, filename);
    const shouldProcessPdfSummary =
      !skipSummaryForJpeg &&
      (isPdfAttachment(contentType, filename) || isWordAttachment(contentType, filename) || isImageAttachment(contentType, filename));
    const baseMetadata: Record<string, string> = {
      ...(metadataValue(source, 64) ? { source: metadataValue(source, 64)! } : {}),
      ...(metadataValue(sourceSender, 128) ? { source_sender: metadataValue(sourceSender, 128)! } : {}),
      ...(metadataValue(sourceMessageId, 128) ? { source_message_id: metadataValue(sourceMessageId, 128)! } : {}),
      ...(metadataValue(caption, 256) ? { caption: metadataValue(caption, 256)! } : {}),
      content_scope: initialContentScope,
    };
    await ensureBucketExists(bucket);
    if (FILE_DEDUP_ENABLED) {
      const existing = await dbCtx.dbGet(
        `SELECT id, bucket, s3_key, filename, content_type, size_bytes, caption, summary, content_scope, summary_status, pdf_text_length, updated_at
         FROM files
         WHERE bucket = ? AND content_hash = ?
         ORDER BY id DESC
         LIMIT 1;`,
        bucket,
        contentHash,
      );
      if (existing?.id) {
        const existingId = Number(existing.id) || 0;
        const existingSummaryStatusRaw = String(existing.summary_status || '').trim().toLowerCase();
        const existingSummaryRaw = String(existing.summary || '').trim();
        const hasNaSummary = existingSummaryRaw.toUpperCase() === 'NA';
        const hasNoUsableSummary = existingSummaryRaw.length === 0 || hasNaSummary;
        const jobKey = buildSummaryJobKey(owner, existingId);
        const hasActiveJob = activeSummaryAbortControllers.has(jobKey);
        const updatedAtMs = Date.parse(String(existing.updated_at || ''));
        const isPendingStale =
          existingSummaryStatusRaw === 'pending' &&
          Number.isFinite(updatedAtMs) &&
          Date.now() - updatedAtMs > FILE_SUMMARY_PENDING_STALE_MS;
        const defaultSummaryStatus = shouldProcessPdfSummary && ASSISTANT_URL ? 'pending' : 'skipped';
        let resolvedSummaryStatus =
          existingSummaryStatusRaw === 'pending' ||
            existingSummaryStatusRaw === 'completed' ||
            existingSummaryStatusRaw === 'failed' ||
            existingSummaryStatusRaw === 'skipped'
            ? existingSummaryStatusRaw
            : defaultSummaryStatus;
        let summaryAsync = false;
        if (!shouldProcessPdfSummary && resolvedSummaryStatus !== 'skipped' && existingId > 0) {
          const fallbackSummary = skipSummaryForJpeg ? 'NA' : null;
          await dbCtx.dbRun(
            `UPDATE files
             SET summary = COALESCE(summary, ?),
                 summary_status = 'skipped',
                 summary_error = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?;`,
            fallbackSummary,
            existingId,
          );
          resolvedSummaryStatus = 'skipped';
        }
        const shouldRetryFailedSummary =
          shouldProcessPdfSummary &&
          (hasNaSummary || (resolvedSummaryStatus === 'failed' && hasNoUsableSummary));
        if (shouldRetryFailedSummary) {
          resolvedSummaryStatus = 'pending';
        }
        if (shouldProcessPdfSummary && resolvedSummaryStatus === 'pending' && !hasActiveJob && isPendingStale) {
          // eslint-disable-next-line no-console
          console.log(
            `[mservice-file][upload] restarting stale pending summary owner=${owner} fileId=${existingId} ageMs=${Date.now() - updatedAtMs}`,
          );
        }
        if (convertedPngToPdf && existingId > 0) {
          await dbCtx.dbRun(
            `UPDATE files
             SET filename = ?,
                 content_type = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?;`,
            filename,
            contentType,
            existingId,
          );
        }
        const shouldStartSummaryJob =
          shouldProcessPdfSummary &&
          ASSISTANT_URL &&
          resolvedSummaryStatus === 'pending' &&
          existingId > 0 &&
          (!hasActiveJob || shouldRetryFailedSummary || isPendingStale);
        const shouldWaitForExistingPending =
          shouldProcessPdfSummary &&
          ASSISTANT_URL &&
          resolvedSummaryStatus === 'pending' &&
          existingId > 0 &&
          hasActiveJob &&
          !shouldRetryFailedSummary &&
          !isPendingStale;

        if (shouldStartSummaryJob) {
          summaryAsync = true;
          await dbCtx.dbRun(
            `UPDATE files
                 SET summary = CASE
                     WHEN UPPER(TRIM(COALESCE(summary, ''))) = 'NA' THEN NULL
                     WHEN ? = 1 AND TRIM(COALESCE(summary, '')) = '' THEN NULL
                     ELSE summary
                   END,
                 summary_status = 'pending',
                 summary_error = NULL,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?;`,
            resolvedSummaryStatus === 'pending' ? 1 : 0,
            existingId,
          );
          const dedupKey = String(existing.s3_key || key);
          const dedupFilename = filename || String(existing.filename || '');
          const dedupContentType = contentType || String(existing.content_type || 'application/octet-stream');
          void runPdfSummaryPipeline({
            dbRun: dbCtx.dbRun,
            owner,
            fileId: existingId,
            bucket: String(existing.bucket || bucket),
            key: dedupKey,
            filename: dedupFilename,
            contentType: dedupContentType,
            source,
            sourceSender,
            sourceMessageId,
            caption,
            callbackUrl,
            callbackAuthorization,
            contentScope: normalizeContentScope(existing.content_scope || initialContentScope),
            baseMetadata,
            content: bytes,
          });
        } else if (shouldWaitForExistingPending) {
          summaryAsync = true;
        }
        res.status(200).json({
          success: true,
          duplicate: true,
          deduped: true,
          file_id: existingId > 0 ? existingId : null,
          bucket: String(existing.bucket || bucket),
          key: String(existing.s3_key || ''),
          filename: String(convertedPngToPdf ? filename : (existing.filename || filename || '')),
          content_type: String(convertedPngToPdf ? contentType : (existing.content_type || contentType)),
          bytes: Number(existing.size_bytes || bytes.length),
          caption: existing.caption ?? null,
          summary: typeof existing.summary === 'string' ? existing.summary : null,
          content_scope: normalizeContentScope(existing.content_scope),
          summary_status: resolvedSummaryStatus,
          pdf_text_length: Number(existing.pdf_text_length || 0),
          summary_async: summaryAsync,
        });
        return;
      }
    }
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

    const initialSummaryStatus: SummaryStatus =
      shouldProcessPdfSummary && ASSISTANT_URL ? 'pending' : 'skipped';
    const initialSummary = skipSummaryForJpeg ? 'NA' : null;

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
        content_scope,
        summary_status,
        summary_error,
        summary_model,
        summary_raw_response,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
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
        content_scope = excluded.content_scope,
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
      initialSummary,
      initialContentScope,
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
      summary: initialSummary,
      content_scope: initialContentScope,
      summary_status: initialSummaryStatus,
      pdf_text_length: 0,
      summary_async: shouldProcessPdfSummary && ASSISTANT_URL.length > 0,
    });

    if (fileId && shouldProcessPdfSummary && ASSISTANT_URL) {
      void runPdfSummaryPipeline({
        dbRun: dbCtx.dbRun,
        owner,
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
        contentScope: initialContentScope,
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
    const owner = normalizeOwner(req.body?.owner ?? req.body?.query_owner ?? req.body?.source_owner);
    const rawPrompt = typeof req.body?.prompt === 'string' ? req.body.prompt.trim() : '';
    const prompt = owner === SONJA_OWNER ? stripSonjaPromptPrefix(rawPrompt) : rawPrompt;
    const dbCtx = await getDbContext(owner);
    const sourceChannel = typeof req.body?.source_channel === 'string' ? req.body.source_channel.trim() : '';
    const sourceFrom = typeof req.body?.source_from === 'string' ? req.body.source_from.trim() : '';
    if (!prompt) {
      res.status(400).json({ success: false, message: 'prompt is required' });
      return;
    }

    const initialQuery = await runFileSearchQuery({
      prompt,
      owner,
      dbCtx,
      sourceChannel,
      sourceFrom,
    });
    const isSonjaOwner = normalizeOwner(owner) === SONJA_OWNER;
    const refinement = isSonjaOwner
      ? { rows: initialQuery.rows, effectiveSql: initialQuery.effectiveSql, confidence: 0, iterations: 0 }
      : await refineSonjaSearchResults({
        originalPrompt: prompt,
        owner,
        dbCtx,
        sourceChannel,
        sourceFrom,
        initialRows: initialQuery.rows,
        initialSql: initialQuery.effectiveSql,
      });
    let rows = refinement.rows;
    if (normalizeOwner(owner) === SONJA_OWNER && initialQuery.searchMode !== 'embedding') {
      rows = applyPromptTokenRelevanceFilter(rows, prompt);
    }
    const effectiveSql = refinement.effectiveSql || initialQuery.effectiveSql;
    const isWhatsapp = String(sourceChannel || '').toLowerCase() === 'whatsapp' || isWhatsappChatId(sourceFrom);
    const delivery = initialQuery.delivery;

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
      const baseMessage = lines.length > 0 ? `Sending ${lines.length} file(s):\n${lines.join('\n')}` : 'No matching files found.';
      res.json({
        success: true,
        owner,
        type: 'attachment',
        message: baseMessage,
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
      search_mode: initialQuery.searchMode,
      refinement:
        normalizeOwner(owner) === SONJA_OWNER
          ? { enabled: false }
          : { enabled: false },
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
    const offsetRaw = Number(req.query.offset);
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
    const source = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const sourceSender = typeof req.query.source_sender === 'string' ? req.query.source_sender.trim() : '';
    const sourceMessageId =
      typeof req.query.source_message_id === 'string' ? req.query.source_message_id.trim() : '';
    const contentScope =
      typeof req.query.content_scope === 'string' ? normalizeContentScope(req.query.content_scope) : '';
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
    if (contentScope) {
      where.push('content_scope = ?');
      params.push(contentScope);
    }
    const sql =
      `SELECT id, source, source_message_id, source_sender, bucket, s3_key, filename, content_type, size_bytes, caption, ` +
      `pdf_text_length, summary, content_scope, summary_status, summary_error, created_at, updated_at FROM files ` +
      `${where.length > 0 ? `WHERE ${where.join(' AND ')} ` : ''}` +
      `ORDER BY id DESC LIMIT ? OFFSET ?;`;
    const rows = await dbCtx.dbAll(sql, ...params, limit, offset);
    res.json({
      success: true,
      owner,
      count: rows.length,
      limit,
      offset,
      next_offset: offset + rows.length,
      files: rows,
    });
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
        `SELECT id, bucket, s3_key, filename, content_type, content_scope, summary_status, summary, summary_error, created_at, updated_at
         FROM files
         WHERE id = ?
         LIMIT 1;`,
        Math.floor(id),
      )
      : await dbCtx.dbGet(
        `SELECT id, bucket, s3_key, filename, content_type, content_scope, summary_status, summary, summary_error, created_at, updated_at
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
          content_scope: 'business',
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

app.post('/file/cancel-summary', authMiddleware, async (req, res) => {
  try {
    const owner = normalizeOwner(req.body?.owner ?? req.query.owner);
    const dbCtx = await getDbContext(owner);
    const id = Number(req.body?.id ?? req.query.id);
    const key = typeof req.body?.key === 'string'
      ? req.body.key.trim()
      : typeof req.query?.key === 'string'
        ? req.query.key.trim()
        : '';
    if ((!Number.isFinite(id) || id <= 0) && !key) {
      res.status(400).json({ success: false, message: 'id or key is required' });
      return;
    }
    const row = Number.isFinite(id) && id > 0
      ? await dbCtx.dbGet(
        `SELECT id, s3_key, summary_status FROM files WHERE id = ? LIMIT 1;`,
        Math.floor(id),
      )
      : await dbCtx.dbGet(
        `SELECT id, s3_key, summary_status FROM files WHERE s3_key = ? LIMIT 1;`,
        key,
      );
    if (!row?.id) {
      res.status(404).json({ success: false, message: 'file record not found' });
      return;
    }
    const fileId = Number(row.id) || 0;
    const jobKey = buildSummaryJobKey(owner, fileId);
    const controller = activeSummaryAbortControllers.get(jobKey);
    if (controller && !controller.signal.aborted) {
      controller.abort();
    }
    await dbCtx.dbRun(
      `UPDATE files
       SET summary_status = 'failed',
           summary_error = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?;`,
      'summary canceled by user',
      fileId,
    );
    res.json({
      success: true,
      owner,
      canceled: true,
      id: fileId,
      key: typeof row.s3_key === 'string' ? row.s3_key : null,
      had_active_job: Boolean(controller),
      summary_status: 'failed',
      summary_error: 'summary canceled by user',
    });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'cancel summary failed' });
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
