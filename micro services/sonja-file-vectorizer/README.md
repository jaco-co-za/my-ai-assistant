# Sonja File Vectorizer

CLI tool to:
- fetch all Sonja files from `mservice-file`
- download files one by one
- chunk files larger than 1 MB into 250 KB pieces
- generate embeddings with Ollama (`qwen3-embedding`)
- upsert chunk vectors into MySQL (`sonja_file_embedding_chunks`)

## Run

```bash
cd "micro services/sonja-file-vectorizer"
npm install
node src/index.mjs
```

Optional:

```bash
node src/index.mjs --limit 50
node src/index.mjs --dry-run
```

## Environment

- `FILE_SERVICE_URL` (default `http://192.168.55.113:3224`)
- `FILE_SERVICE_AUTH` (Bearer token value or full header)
- `OLLAMA_URL` (default `http://192.168.55.113:11434`)
- `OLLAMA_MODEL` (default `qwen3-embedding`)
- `VECTOR_OWNER` (default `sonja`)
- `LARGE_FILE_BYTES` (default `1048576`)
- `CHUNK_BYTES` (default `256000`)
- `MYSQL_HOST` (default `127.0.0.1`)
- `MYSQL_PORT` (default `3306`)
- `MYSQL_DATABASE` (required)
- `MYSQL_USER` (required)
- `MYSQL_PASSWORD` (required)

If `FILE_SERVICE_AUTH` is not set, the tool attempts to read `AUTH_BEARER_TOKEN` from `micro services/mservice-file/.env`.
If MySQL env vars are not set, it attempts to read from `servers/mysql-docker/.env`.
