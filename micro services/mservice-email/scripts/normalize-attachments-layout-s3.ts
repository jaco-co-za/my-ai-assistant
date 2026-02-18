import dotenv from 'dotenv';
import sqlite3 from 'sqlite3';
import { promisify } from 'node:util';
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
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
const DELETE_OLD_MIGRATED_KEYS =
  String(process.env.DELETE_OLD_MIGRATED_KEYS || 'false').toLowerCase() === 'true';

type Row = {
  id: number;
  storage_path: string | null;
};

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

function toCopySource(bucket: string, key: string): string {
  const encodedKey = key.split('/').map((segment) => encodeURIComponent(segment)).join('/');
  return `${bucket}/${encodedKey}`;
}

async function cleanupMigratedPrefix(s3: S3Client, bucket: string, prefix: string): Promise<number> {
  let deleted = 0;
  let continuationToken: string | undefined;
  while (true) {
    const out = await s3.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: prefix,
        ContinuationToken: continuationToken,
      }),
    );
    const keys = (out.Contents || [])
      .map((item) => item.Key || '')
      .filter((key) => key.length > 0);
    if (keys.length > 0) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: bucket,
          Delete: {
            Objects: keys.map((key) => ({ Key: key })),
            Quiet: true,
          },
        }),
      );
      deleted += keys.length;
    }
    if (!out.IsTruncated) {
      break;
    }
    continuationToken = out.NextContinuationToken;
  }
  return deleted;
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

  const migratedPrefix = `${S3_PREFIX}/migrated/`;

  try {
    const rows = (await dbAll(
      `SELECT id, storage_path
       FROM email_attachments
       WHERE storage_path LIKE ?
       ORDER BY id ASC;`,
      `s3://%/${migratedPrefix}%`,
    )) as Row[];

    let scanned = 0;
    let moved = 0;
    let skipped = 0;
    let failed = 0;
    let targetBucket = '';

    for (const row of rows) {
      scanned += 1;
      const attachmentId = Number(row.id);
      const storagePath = row.storage_path ? String(row.storage_path) : '';
      if (!Number.isFinite(attachmentId) || attachmentId <= 0 || !storagePath) {
        skipped += 1;
        continue;
      }

      const parsed = parseS3Uri(storagePath);
      if (!parsed || !parsed.key.startsWith(migratedPrefix)) {
        skipped += 1;
        continue;
      }

      const newKey = `${S3_PREFIX}/${parsed.key.slice(migratedPrefix.length)}`;
      const newPath = `s3://${parsed.bucket}/${newKey}`;
      if (newPath === storagePath) {
        skipped += 1;
        continue;
      }

      try {
        await s3.send(
          new CopyObjectCommand({
            Bucket: parsed.bucket,
            Key: newKey,
            CopySource: toCopySource(parsed.bucket, parsed.key),
          }),
        );
        await dbRun('UPDATE email_attachments SET storage_path = ? WHERE id = ?;', newPath, attachmentId);
        moved += 1;
        targetBucket = parsed.bucket;
      } catch (err: any) {
        failed += 1;
        // eslint-disable-next-line no-console
        console.warn(
          `[normalize] failed attachment ${attachmentId}: ${err?.message || 'copy/update failed'} (${storagePath})`,
        );
      }
    }

    const verifyRows = await dbAll(
      'SELECT COUNT(*) AS remaining FROM email_attachments WHERE storage_path LIKE ?;',
      `s3://%/${migratedPrefix}%`,
    );
    const remaining = Number(verifyRows?.[0]?.remaining || 0);

    let deletedOldKeys = 0;
    if (DELETE_OLD_MIGRATED_KEYS && remaining === 0 && targetBucket) {
      deletedOldKeys = await cleanupMigratedPrefix(s3, targetBucket, migratedPrefix);
    }

    // eslint-disable-next-line no-console
    console.log(
      `[normalize] done scanned=${scanned} moved=${moved} skipped=${skipped} failed=${failed} remaining_migrated_rows=${remaining} deleted_old_keys=${deletedOldKeys}`,
    );
  } finally {
    db.close();
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[normalize] fatal error:', err?.message || err);
  process.exit(1);
});
