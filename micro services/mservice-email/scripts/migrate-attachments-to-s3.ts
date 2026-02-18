import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'node:util';
import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

dotenv.config();

const DB_PATH = process.env.DB_PATH || './data/email.db';
const ATTACHMENTS_DIR = process.env.ATTACHMENTS_DIR || './attachments';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://192.168.55.113:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'aiassist';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'MASEHARRE@123';
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';
const S3_BUCKET = process.env.EMAIL_S3_BUCKET || process.env.S3_DEFAULT_BUCKET || process.env.S3_BUCKET || 'files';
const S3_PREFIX = (process.env.EMAIL_S3_PREFIX || 'email-attachments').replace(/^\/+|\/+$/g, '');
const DELETE_LOCAL_AFTER_MIGRATION =
  String(process.env.DELETE_LOCAL_AFTER_MIGRATION || 'false').toLowerCase() === 'true';

function sanitizeFilename(value?: string | null): string {
  if (!value || value.trim().length === 0) {
    return 'attachment';
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

function resolveLocalStoragePath(storagePath: string): string {
  const raw = String(storagePath || '').trim();
  if (path.isAbsolute(raw)) {
    return raw;
  }
  const cwdPath = path.resolve(process.cwd(), raw);
  const basenamePath = path.resolve(process.cwd(), ATTACHMENTS_DIR, path.basename(raw));
  return `${cwdPath}|||${basenamePath}`;
}

async function pickExistingLocalPath(storagePath: string): Promise<string | null> {
  const resolved = resolveLocalStoragePath(storagePath);
  const candidates = resolved.split('|||').filter((entry) => entry.trim().length > 0);
  for (const candidate of candidates) {
    if (await fileExists(candidate)) {
      return candidate;
    }
  }
  return null;
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

  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  }

  const db = new sqlite3.Database(DB_PATH);
  const dbAll = promisify(db.all.bind(db)) as (sql: string, ...params: unknown[]) => Promise<any[]>;
  const dbRun = promisify(db.run.bind(db)) as (sql: string, ...params: unknown[]) => Promise<void>;

  try {
    const rows = await dbAll(
      `SELECT id, email_id, filename, storage_path
       FROM email_attachments
       ORDER BY id ASC;`,
    );

    let scanned = 0;
    let migrated = 0;
    let skippedS3 = 0;
    let skippedEmpty = 0;
    let missingFiles = 0;
    let failed = 0;

    for (const row of rows) {
      scanned += 1;
      const attachmentId = Number(row?.id);
      const emailId = Number(row?.email_id);
      const filename = row?.filename ? String(row.filename) : null;
      const storagePath = row?.storage_path ? String(row.storage_path) : '';

      if (!Number.isFinite(attachmentId) || attachmentId <= 0) {
        failed += 1;
        continue;
      }
      if (!storagePath) {
        skippedEmpty += 1;
        continue;
      }
      if (storagePath.startsWith('s3://')) {
        skippedS3 += 1;
        continue;
      }

      const localPath = await pickExistingLocalPath(storagePath);
      if (!localPath) {
        missingFiles += 1;
        // eslint-disable-next-line no-console
        console.warn(`[migrate] missing local file for attachment ${attachmentId}: ${storagePath}`);
        continue;
      }

      try {
        const body = await readFile(localPath);
        const safeName = sanitizeFilename(filename || path.basename(localPath));
        const key = `${S3_PREFIX}/migrated/${emailId || 0}/${attachmentId}_${safeName}`;
        await s3.send(
          new PutObjectCommand({
            Bucket: S3_BUCKET,
            Key: key,
            Body: body,
            ContentType: 'application/json',
          }),
        );
        const s3Path = `s3://${S3_BUCKET}/${key}`;
        await dbRun('UPDATE email_attachments SET storage_path = ? WHERE id = ?;', s3Path, attachmentId);
        migrated += 1;
      } catch (err: any) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(`[migrate] failed attachment ${attachmentId}: ${err?.message || 'unknown error'}`);
      }
    }

    // eslint-disable-next-line no-console
    console.log(
      `[migrate] done scanned=${scanned} migrated=${migrated} skipped_s3=${skippedS3} skipped_empty=${skippedEmpty} missing_local=${missingFiles} failed=${failed}`,
    );
    if (DELETE_LOCAL_AFTER_MIGRATION) {
      // eslint-disable-next-line no-console
      console.log('[migrate] local file deletion is not automatic in this script. Keep as backup for now.');
    }
  } finally {
    db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[migrate] fatal error:', err?.message || err);
  process.exit(1);
});
