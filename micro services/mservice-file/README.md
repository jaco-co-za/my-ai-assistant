# File Microservice (Local S3)

This service stores and serves files from your own S3-compatible endpoint (for example MinIO).

## Quick Start

1. Start local S3 server:

```bash
cd ../../servers/s3-local
cp .env.example .env
chmod +x install.sh
./install.sh
```

2. Configure file service:

```bash
cd ../../micro\ services/mservice-file
cp .env.example .env
```

3. Run locally:

```bash
npm install
npm run dev
```

Or containerized:

```bash
chmod +x install.sh
./install.sh
```

## Endpoints

- `GET /health`
- `POST /bucket/create`
- `POST /file/upload`
- `GET /file/download?bucket=files&key=path/to/file.pdf`
- `GET /file/list?bucket=files&prefix=path/`
- `DELETE /file/delete?bucket=files&key=path/to/file.pdf`