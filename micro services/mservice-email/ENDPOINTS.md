# Endpoints

## POST `/get-mail`

Search for mail records. Request body must include **at least one** of:
`id`, `subject`, `body`, `attachment`, `from`.

Optional fields:
- `limit` (number)
- `sort` (string `"field:asc|desc"` or `{ "field": "...", "direction": "asc|desc" }`)

Behavior:
- Searches in order: `id` → `subject` → `body` → `from` → `attachment`.
- `id` matches either internal `email_messages.id` or `server_uid` (exact match).
- Text comparisons are case-insensitive (lowercase match).
- `attachment` returns **only** attachment rows (no binary).
- If `limit` not supplied, returns all.
- Sorting is optional via `sort` (e.g. `received_at:asc` or `received_at:desc`).

Example:
```bash
curl -X POST http://localhost:3222/get-mail \
  -H "Content-Type: application/json" \
  -d '{"subject":"invoice","limit":50,"sort":"received_at:desc"}'
```

## POST `/llm-query`

Send an orchestrator prompt to the LLM and return the matching rows from SQLite.

Request body:
- `prompt` (string, required)
- `result` (string, optional: parser output like `verb: ... | intent: ...`)

Behavior:
- Runs learning list/delete commands when requested.
- Adds learnings when the user is teaching.
- Otherwise, converts the prompt into a safe SQL `SELECT` against the email schema and returns rows.

Example:
```bash
curl -X POST http://localhost:3222/llm-query \
  -H "Content-Type: application/json" \
  -d '{"prompt":"Show the 10 most recent emails from Alice"}'
```
