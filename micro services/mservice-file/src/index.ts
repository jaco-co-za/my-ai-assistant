import express, { Request, Response, NextFunction } from 'express';
import dotenv from 'dotenv';
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

const S3_ENDPOINT = process.env.S3_ENDPOINT || 'http://localhost:9000';
const S3_REGION = process.env.S3_REGION || 'us-east-1';
const S3_ACCESS_KEY = process.env.S3_ACCESS_KEY || 'minioadmin';
const S3_SECRET_KEY = process.env.S3_SECRET_KEY || 'minioadmin';
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
    res.json({ status: 'ok', bucket, endpoint: S3_ENDPOINT });
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
    const key = typeof req.body?.key === 'string' ? req.body.key.trim() : '';
    const dataBase64 = typeof req.body?.data_base64 === 'string' ? req.body.data_base64.trim() : '';
    const contentType = typeof req.body?.content_type === 'string' ? req.body.content_type.trim() : 'application/octet-stream';

    if (!key || !dataBase64) {
      res.status(400).json({ success: false, message: 'bucket/key/data_base64 required' });
      return;
    }

    const bytes = Buffer.from(dataBase64, 'base64');
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: bytes,
        ContentType: contentType,
      }),
    );

    res.status(201).json({ success: true, bucket, key, bytes: bytes.length, content_type: contentType });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'upload failed' });
  }
});

app.get('/file/download', authMiddleware, async (req, res) => {
  try {
    const bucket = resolveBucket(req.query.bucket);
    const key = typeof req.query.key === 'string' ? req.query.key.trim() : '';
    if (!key) {
      res.status(400).json({ success: false, message: 'key is required' });
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

app.delete('/file/delete', authMiddleware, async (req, res) => {
  try {
    const bucket = resolveBucket(req.query.bucket ?? req.body?.bucket);
    const keyCandidate = req.query.key ?? req.body?.key;
    const key = typeof keyCandidate === 'string' ? keyCandidate.trim() : '';
    if (!key) {
      res.status(400).json({ success: false, message: 'key is required' });
      return;
    }
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    res.json({ success: true, bucket, key });
  } catch (err: any) {
    res.status(500).json({ success: false, message: err?.message || 'delete failed' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`[mservice-file] listening on port ${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`[mservice-file] s3 endpoint ${S3_ENDPOINT} bucket ${S3_DEFAULT_BUCKET}`);
});