# Local S3 (MinIO)

Run your own S3-compatible server locally with persistent storage.

## Start

```bash
cd servers/s3-local
cp .env.example .env
chmod +x install.sh
./install.sh
```

## Endpoints

- S3 API: `http://localhost:9000`
- MinIO Console: `http://localhost:9001`

## Credentials

Configured in `.env`:

- `MINIO_ROOT_USER`
- `MINIO_ROOT_PASSWORD`

Default bucket created by script: `MINIO_DEFAULT_BUCKET`.