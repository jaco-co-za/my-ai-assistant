import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

type StorageMode = 's3' | 'local';

const STORAGE_MODE: StorageMode = (process.env.ATTACHMENT_STORAGE_BACKEND || 's3').toLowerCase() === 'local'
  ? 'local'
  : 's3';
const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://192.168.55.113:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'aiassist';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'MASEHARRE@123';
const S3_FORCE_PATH_STYLE = String(process.env.S3_FORCE_PATH_STYLE || 'true').toLowerCase() === 'true';
const S3_BUCKET = process.env.EMAIL_S3_BUCKET || process.env.S3_DEFAULT_BUCKET || process.env.S3_BUCKET || 'files';
const S3_PREFIX = (process.env.EMAIL_S3_PREFIX || 'email-attachments').replace(/^\/+|\/+$/g, '');

let s3Client: S3Client | null = null;
let s3BucketReady = false;

function getS3Client(): S3Client {
  if (s3Client) {
    return s3Client;
  }
  s3Client = new S3Client({
    region: S3_REGION,
    endpoint: S3_ENDPOINT,
    forcePathStyle: S3_FORCE_PATH_STYLE,
    credentials: {
      accessKeyId: S3_ACCESS_KEY,
      secretAccessKey: S3_SECRET_KEY,
    },
  });
  return s3Client;
}

async function ensureS3BucketExists(): Promise<void> {
  if (s3BucketReady || STORAGE_MODE !== 's3') {
    return;
  }
  const s3 = getS3Client();
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }));
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }));
  }
  s3BucketReady = true;
}

function sanitizeFilename(value?: string | null): string {
  if (!value || value.trim().length === 0) {
    return 'attachment';
  }
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function parseS3Uri(storagePath: string): { bucket: string; key: string } | null {
  const raw = String(storagePath || '').trim();
  if (!raw.startsWith('s3://')) {
    return null;
  }
  const noScheme = raw.slice('s3://'.length);
  const slashIndex = noScheme.indexOf('/');
  if (slashIndex <= 0 || slashIndex === noScheme.length - 1) {
    return null;
  }
  return {
    bucket: noScheme.slice(0, slashIndex),
    key: noScheme.slice(slashIndex + 1),
  };
}

function resolveLocalPath(storagePath: string, localDir?: string): string {
  if (path.isAbsolute(storagePath)) {
    return storagePath;
  }
  if (localDir && localDir.trim().length > 0) {
    const basename = path.basename(storagePath);
    if (basename && basename !== storagePath) {
      return path.resolve(process.cwd(), localDir, basename);
    }
  }
  return path.resolve(process.cwd(), storagePath);
}

async function getObjectBuffer(bucket: string, key: string): Promise<Buffer> {
  const s3 = getS3Client();
  const object = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
  if (!object.Body) {
    return Buffer.alloc(0);
  }
  if (typeof (object.Body as any).transformToByteArray === 'function') {
    const bytes = await (object.Body as any).transformToByteArray();
    return Buffer.from(bytes);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of object.Body as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

export function getAttachmentStorageMode(): StorageMode {
  return STORAGE_MODE;
}

export async function storeAttachmentPayload(args: {
  emailId: number;
  index: number;
  filename?: string | null;
  payload: Record<string, unknown>;
  localDir?: string;
}): Promise<string> {
  const safeName = sanitizeFilename(args.filename || `attachment_${args.index}`);
  const payload = JSON.stringify(args.payload);
  if (STORAGE_MODE === 's3') {
    await ensureS3BucketExists();
    const key = `${S3_PREFIX}/${args.emailId}/${args.index}_${safeName}.json`;
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: payload,
        ContentType: 'application/json',
      }),
    );
    return `s3://${S3_BUCKET}/${key}`;
  }

  const dir = args.localDir || './attachments';
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${args.emailId}_${args.index}_${safeName}.json`);
  await writeFile(filePath, payload);
  return filePath;
}

export async function storeAttachmentBinary(args: {
  emailId: number;
  index: number;
  filename?: string | null;
  contentType?: string | null;
  content: Buffer;
  localDir?: string;
}): Promise<string> {
  const safeName = sanitizeFilename(args.filename || `attachment_${args.index}`);
  if (STORAGE_MODE === 's3') {
    await ensureS3BucketExists();
    const key = `${S3_PREFIX}/${args.emailId}/${args.index}_${safeName}`;
    await getS3Client().send(
      new PutObjectCommand({
        Bucket: S3_BUCKET,
        Key: key,
        Body: args.content,
        ContentType: args.contentType || 'application/octet-stream',
      }),
    );
    return `s3://${S3_BUCKET}/${key}`;
  }

  const dir = args.localDir || './attachments';
  await mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${args.emailId}_${args.index}_${safeName}`);
  await writeFile(filePath, args.content);
  return filePath;
}

export async function readAttachmentFile(storagePath: string, localDir?: string): Promise<Buffer> {
  const s3Ref = parseS3Uri(storagePath);
  if (s3Ref) {
    return await getObjectBuffer(s3Ref.bucket, s3Ref.key);
  }
  const resolved = resolveLocalPath(storagePath, localDir);
  return await readFile(resolved);
}

export async function deleteAttachmentObject(storagePath: string, localDir?: string): Promise<void> {
  const s3Ref = parseS3Uri(storagePath);
  if (s3Ref) {
    await getS3Client().send(
      new DeleteObjectCommand({
        Bucket: s3Ref.bucket,
        Key: s3Ref.key,
      }),
    );
    return;
  }
  const resolved = resolveLocalPath(storagePath, localDir);
  await rm(resolved, { force: true });
}
