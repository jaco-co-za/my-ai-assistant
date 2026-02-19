# File Microservice (Local S3)

This service stores and serves files from your own S3-compatible endpoint (for example MinIO).
It also keeps a SQLite index of uploaded files, extracts PDF/Word text (with default password fallback for PDF),
and can generate file summaries through the assistant endpoint.

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
- `GET /file/records?source=whatsapp&source_sender=...&limit=100`
- `DELETE /file/delete?bucket=files&key=path/to/file.pdf`

## Upload Payload

`POST /file/upload` accepts:

- `bucket` (optional)
- `key` (optional, auto-generated when omitted)
- `data_base64` (required)
- `content_type` (optional)
- `filename` (optional)
- `caption` (optional)
- `source` (optional, e.g. `whatsapp`)
- `source_sender` (optional)
- `source_message_id` (optional)

On upload:

- file bytes are saved to S3
- record is upserted in SQLite (`files` table)
- if PDF, text extraction is attempted using `pdf2json`
- if Word (`.docx`/`.doc`), text extraction is attempted using `mammoth`
- if `ASSISTANT_URL` is set, summary is generated and stored in SQLite
- summary snippet is written to S3 object metadata when available
