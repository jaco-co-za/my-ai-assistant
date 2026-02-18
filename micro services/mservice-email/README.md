# Email Micro Service

Node.js worker service for a personal AI assistant. Accepts connections on `PORT` (default `3222`) and prepares for IMAP + SQLite workflows.

## Setup

```bash
npm install
```

## Run

```bash
npm run start
```

## Events (SSE)

Subscribe to live mail changes:
```bash
curl -N http://localhost:3222/events
```

When auth is enabled, include the bearer token:
```bash
curl -N http://localhost:3222/events -H "Authorization: Bearer <token>"
```

Each event is JSON containing the stored `email_messages` row and any
`email_attachments` rows (no binary data included). Event types:
`mail_created`, `mail_updated`, `mail_deleted`.

## Endpoints

See `ENDPOINTS.md`.
## Environment

Copy `.env.example` to `.env` and adjust if needed.

- `PORT`: HTTP port (default 3222)
- `DB_PATH`: SQLite database path (default `./data/email.db`)
- `ATTACHMENTS_DIR`: Directory for base64 attachment files (default `./attachments`)
- `ATTACHMENT_STORAGE_BACKEND`: `s3` (default) or `local`
- `S3_ENDPOINT`: S3-compatible endpoint (default `http://192.168.55.113:9000`)
- `S3_REGION`: S3 region (default `us-east-1`)
- `S3_ACCESS_KEY`: S3 access key (default `aiassist`)
- `S3_SECRET_KEY`: S3 secret key (default `MASEHARRE@123`)
- `S3_FORCE_PATH_STYLE`: `true` for MinIO-compatible path style
- `S3_DEFAULT_BUCKET` or `EMAIL_S3_BUCKET`: target bucket (default `files`)
- `EMAIL_S3_PREFIX`: object key prefix (default `email-attachments`)
- `SKIP_AUTH`: Skip auth checks when `true` (default `false`)
- `AUTH_BEARER_TOKEN`: Bearer token required for requests when auth is enabled

## First-time SQLite Init

The service uses a single SQLite file located at `./data/email.db`.
Attachments are stored as base64 JSON files in `./attachments`.

Initialize the schema once:
```bash
npm run init:sqlite
```

## Attachment Migration to S3

If attachments were previously stored locally in `ATTACHMENTS_DIR`, migrate them once:

```bash
npm run migrate:attachments:s3
```

If older S3 objects were uploaded as JSON wrappers, convert them to real binary files:

```bash
DELETE_OLD_WRAPPER_KEYS=true npm run convert:attachments:s3-binary
```
