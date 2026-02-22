# MySQL Docker Server

Runs a local MySQL server with Docker Compose using values from `.env`.

Default image is now `mysql:9`.

## Start

```bash
cd servers/mysql-docker
cp .env.example .env
chmod +x install.sh
./install.sh
```

If `.env` does not exist, `install.sh` creates it from `.env.example`.

## Env values

Set these in `.env`:

- `MYSQL_IMAGE`
- `MYSQL_CONTAINER_NAME`
- `MYSQL_HOST_BIND_IP`
- `MYSQL_PORT`
- `MYSQL_ROOT_PASSWORD`
- `MYSQL_DATABASE`
- `MYSQL_USER`
- `MYSQL_PASSWORD`
- `VECTORIZER_MYSQL_USER`
- `VECTORIZER_MYSQL_PASSWORD`
- `VECTORIZER_MYSQL_HOST` (default `%`)
- `MYSQL_DATA_DIR`
- `MYSQL_TZ`

## Useful commands

```bash
docker compose --env-file .env -f docker-compose.yml logs -f
docker compose --env-file .env -f docker-compose.yml down
```

## Sonja Embeddings Table

`install.sh` now also runs an idempotent schema step that creates:
- `sonja_file_embeddings`
- `sonja_file_embedding_chunks`

It also ensures a dedicated vectorizer user exists (if `VECTORIZER_MYSQL_USER` and `VECTORIZER_MYSQL_PASSWORD` are set) and grants:
- `SELECT, INSERT, UPDATE` on `sonja_file_embeddings`
- `SELECT, INSERT, UPDATE` on `sonja_file_embedding_chunks`

Table purpose:
- Store per-file embedding vectors for Sonja files.
- Filter by `grade`, `subject`, and `educational`.

Chunk table purpose:
- Store one embedding per file chunk for large-file vectorization workflows.

Main columns:
- `owner` (default `sonja`)
- `file_id`
- `grade` (`TINYINT`)
- `subject` (`VARCHAR(128)`)
- `educational` (`TINYINT(1)`, `1` for educational, `0` for non-educational)
- `embedding_model`
- `embedding_dim`
- `embedding_json` (JSON array of embedding numbers)

Example filter search:

```sql
SELECT id, file_id, filename, grade, subject, educational
FROM sonja_file_embeddings
WHERE owner = 'sonja'
  AND grade = 6
  AND subject = 'math'
  AND educational = 1
ORDER BY updated_at DESC
LIMIT 50;
```

## Upgrade Notes (8.x -> 9.x)

- `mysql_native_password` is removed in MySQL 9, so this stack no longer sets `--default-authentication-plugin=mysql_native_password`.
- Existing `.env` files keep old values. Update `MYSQL_IMAGE` in `servers/mysql-docker/.env` to `mysql:9`.
- For existing data directories, take a backup before first MySQL 9 start.
