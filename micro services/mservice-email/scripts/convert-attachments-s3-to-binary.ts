import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'node:util';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/email.db';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://192.168.55.113:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'aiassist';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'MASEHARRE@123';
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';
const S3_PREFIX = (process.env.EMAIL_S3_PREFIX || 'email-attachments').replace(/^\/+|\/+$/g, '');
const DELETE_OLD_WRAPPER_KEYS =
  String(process.env.DELETE_OLD_WRAPPER_KEYS || 'false').toLowerCase() === 'true';

type Row = {
  id: number;
  email_id: number;
  filename: string | null;
  content_type: string | null;
  storage_path: string | null;
};

function sanitizeFilename(value?: string | null): string {
  if (!value || value.trim().length === 0) {
    return 'attachment';
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseS3Uri(uri: string): { bucket: string; key: string } | null {
  const raw = String(uri || '').trim();
  if (!raw.startsWith('s3://')) {
    return null;
  }
  const noScheme = raw.slice('s3://'.length);
  const slash = noScheme.indexOf('/');
  if (slash <= 0 || slash === noScheme.length - 1) {
    return null;
  }
  return {
    bucket: noScheme.slice(0, slash),
    key: noScheme.slice(slash + 1),
  };
}

async function getObjectBuffer(s3: S3Client, bucket: string, key: string): Promise<Buffer> {
  const out = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!out.Body) {
    return Buffer.alloc(0);
  }
  if (typeof (out.Body as any).transformToByteArray === 'function') {
    const bytes = await (out.Body as any).transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of out.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function tryParseWrapper(raw: Buffer): { content_base64?: unknown; filename?: unknown; content_type?: unknown } | null {
  try {
    const parsed = JSON.parse(raw.toString('utf-8')) as {
      content_base64?: unknown;
      filename?: unknown;
      content_type?: unknown;
    };
    return parsed;
  } catch {
    return null;
  }
}

async function main() {
  const s3 = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
  });

  const db = new sqlite3.Database(DB_PATH);
  const dbAll = promisify(db.all.bind(db)) as (sql: string, ...params: unknown[]) => Promise<any[]>;
  const dbRun = promisify(db.run.bind(db)) as (sql: string, ...params: unknown[]) => Promise<void>;

  try {
    const rows = (await dbAll(
      `SELECT id, email_id, filename, content_type, storage_path
       FROM email_attachments
       WHERE storage_path LIKE 's3://%'
       ORDER BY id ASC;`,
    )) as Row[];

    let scanned = 0;
    let wrappers = 0;
    let converted = 0;
    let alreadyBinary = 0;
    let skipped = 0;
    let failed = 0;
    let movedPaths = 0;
    let deletedOldKeys = 0;

    for (const row of rows) {
      scanned += 1;
      const attachmentId = Number(row.id);
      const emailId = Number(row.email_id);
      const storagePath = row.storage_path ? String(row.storage_path) : '';
      if (!Number.isFinite(attachmentId) || attachmentId <= 0 || !Number.isFinite(emailId) || emailId <= 0 || !storagePath) {
        skipped += 1;
        continue;
      }

      const s3Ref = parseS3Uri(storagePath);
      if (!s3Ref) {
        skipped += 1;
        continue;
      }

      try {
        const raw = await getObjectBuffer(s3, s3Ref.bucket, s3Ref.key);
        const parsed = tryParseWrapper(raw);
        if (!parsed || typeof parsed.content_base64 !== 'string' || parsed.content_base64.length === 0) {
          alreadyBinary += 1;
          continue;
        }

        wrappers += 1;
        const finalFilename = sanitizeFilename(
          (row.filename && row.filename.trim().length > 0 ? row.filename : null) ||
            (typeof parsed.filename === 'string' ? parsed.filename : null) ||
            'attachment',
        );
        const finalContentType =
          (row.content_type && row.content_type.trim().length > 0 ? row.content_type : null) ||
          (typeof parsed.content_type === 'string' ? parsed.content_type : null) ||
          'application/octet-stream';
        const content = Buffer.from(parsed.content_base64, 'base64');
        const newKey = `${S3_PREFIX}/${emailId}/${attachmentId}_${finalFilename}`;
        const newPath = `s3://${s3Ref.bucket}/${newKey}`;

        await s3.send(
          new PutObjectCommand({
            Bucket: s3Ref.bucket,
            Key: newKey,
            Body: content,
            ContentType: finalContentType,
          }),
        );
        if (newPath !== storagePath) {
          await dbRun('UPDATE email_attachments SET storage_path = ? WHERE id = ?;', newPath, attachmentId);
          movedPaths += 1;
        }
        if (DELETE_OLD_WRAPPER_KEYS && s3Ref.key !== newKey) {
          await s3.send(new DeleteObjectCommand({ Bucket: s3Ref.bucket, Key: s3Ref.key }));
          deletedOldKeys += 1;
        }
        converted += 1;
      } catch (err: any) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(`[convert] failed attachment ${attachmentId}: ${err?.message || 'unknown error'}`);
      }
    }

    const verifyRows = await dbAll(
      `SELECT
         SUM(CASE WHEN storage_path LIKE ? THEN 1 ELSE 0 END) AS migrated_rows,
         SUM(CASE WHEN storage_path LIKE 's3://%' THEN 1 ELSE 0 END) AS s3_rows
       FROM email_attachments;`,
      `s3://%/${S3_PREFIX}/migrated/%`,
    );
    const migratedRows = Number(verifyRows?.[0]?.migrated_rows || 0);
    const s3Rows = Number(verifyRows?.[0]?.s3_rows || 0);

    // eslint-disable-next-line no-console
    console.log(
      `[convert] done scanned=${scanned} wrappers=${wrappers} converted=${converted} already_binary=${alreadyBinary} moved_paths=${movedPaths} deleted_old_keys=${deletedOldKeys} failed=${failed} skipped=${skipped} verify_s3_rows=${s3Rows} verify_migrated_rows=${migratedRows}`,
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[convert] fatal error:', err?.message || err);
  process.exit(1);
});
