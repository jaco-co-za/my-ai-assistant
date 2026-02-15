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
- `SKIP_AUTH`: Skip auth checks when `true` (default `false`)
- `AUTH_BEARER_TOKEN`: Bearer token required for requests when auth is enabled

## First-time SQLite Init

The service uses a single SQLite file located at `./data/email.db`.
Attachments are stored as base64 JSON files in `./attachments`.

Initialize the schema once:
```bash
npm run init:sqlite
```
