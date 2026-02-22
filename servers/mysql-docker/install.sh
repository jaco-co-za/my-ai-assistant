#!/usr/bin/env bash
set -euo pipefail

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-main}"
MONOREPO_DIR="${MONOREPO_DIR:-$HOME/my-ai-assistant}"
SERVER_RELATIVE_DIR="servers/mysql-docker"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"
EMBEDDINGS_SCHEMA_SQL="$ROOT_DIR/sql/ensure_embeddings_schema.sql"

sql_escape() {
  local value="${1:-}"
  value="${value//\\/\\\\}"
  value="${value//\'/\'\'}"
  printf "%s" "$value"
}

sync_monorepo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is not installed or not in PATH."
    exit 1
  fi

  local repo_root=""
  if repo_root="$(git -C "$ROOT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "==> Updating monorepo at '$repo_root' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..."
    git -C "$repo_root" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$repo_root" checkout "$MONOREPO_BRANCH"
    git -C "$repo_root" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
    ROOT_DIR="$repo_root/$SERVER_RELATIVE_DIR"
    ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
    ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"
    cd "$ROOT_DIR"
    return
  fi

  if [[ -d "$MONOREPO_DIR/.git" ]]; then
    echo "==> Updating monorepo at '$MONOREPO_DIR' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..."
    git -C "$MONOREPO_DIR" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" checkout "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
  else
    echo "==> Cloning monorepo into '$MONOREPO_DIR'..."
    git clone --branch "$MONOREPO_BRANCH" "$MONOREPO_URL" "$MONOREPO_DIR"
  fi
  ROOT_DIR="$MONOREPO_DIR/$SERVER_RELATIVE_DIR"
  ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
  ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"
  cd "$ROOT_DIR"
}

sync_monorepo

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH."
  exit 1
fi

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "docker compose (or docker-compose) is required."
  exit 1
fi

if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
fi

if [[ ! -f "$ENV_FILE" ]]; then
  cp "$ENV_EXAMPLE_FILE" "$ENV_FILE"
  echo "Created $ENV_FILE from .env.example"
  echo "Update credentials in $ENV_FILE before using in shared environments."
fi

set -a
source "$ENV_FILE"
set +a

if [[ -z "${MYSQL_ROOT_PASSWORD:-}" || -z "${MYSQL_DATABASE:-}" || -z "${MYSQL_USER:-}" || -z "${MYSQL_PASSWORD:-}" ]]; then
  echo "Missing required values in $ENV_FILE."
  echo "Required: MYSQL_ROOT_PASSWORD, MYSQL_DATABASE, MYSQL_USER, MYSQL_PASSWORD"
  exit 1
fi

mkdir -p "${MYSQL_DATA_DIR:-$ROOT_DIR/data}"

echo "Starting MySQL container ${MYSQL_CONTAINER_NAME:-mysql-local}..."
"${COMPOSE[@]}" --env-file "$ENV_FILE" -f "$ROOT_DIR/docker-compose.yml" up -d

echo "Waiting for MySQL health check..."
for _ in $(seq 1 60); do
  STATUS="$(docker inspect -f '{{.State.Health.Status}}' "${MYSQL_CONTAINER_NAME:-mysql-local}" 2>/dev/null || true)"
  if [[ "$STATUS" == "healthy" ]]; then
    break
  fi
  sleep 2
done

STATUS="$(docker inspect -f '{{.State.Health.Status}}' "${MYSQL_CONTAINER_NAME:-mysql-local}" 2>/dev/null || true)"
if [[ "$STATUS" != "healthy" ]]; then
  echo "MySQL container did not become healthy in time."
  docker logs "${MYSQL_CONTAINER_NAME:-mysql-local}" || true
  exit 1
fi

echo "MySQL is ready."

if [[ -f "$EMBEDDINGS_SCHEMA_SQL" ]]; then
  echo "Ensuring Sonja embeddings table exists..."
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    "${MYSQL_DATABASE}" < "$EMBEDDINGS_SCHEMA_SQL"
  echo "Embeddings schema ensured."
fi

VECTORIZER_MYSQL_USER="${VECTORIZER_MYSQL_USER:-sonja_vectorizer}"
VECTORIZER_MYSQL_PASSWORD="${VECTORIZER_MYSQL_PASSWORD:-}"
VECTORIZER_MYSQL_HOST="${VECTORIZER_MYSQL_HOST:-%}"

if [[ -n "$VECTORIZER_MYSQL_USER" && -n "$VECTORIZER_MYSQL_PASSWORD" ]]; then
  echo "Ensuring vectorizer MySQL user exists..."
  SQL_USER="$(sql_escape "$VECTORIZER_MYSQL_USER")"
  SQL_PASS="$(sql_escape "$VECTORIZER_MYSQL_PASSWORD")"
  SQL_HOST="$(sql_escape "$VECTORIZER_MYSQL_HOST")"
  SQL_DB="$(sql_escape "$MYSQL_DATABASE")"
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    -e "CREATE USER IF NOT EXISTS '${SQL_USER}'@'${SQL_HOST}' IDENTIFIED BY '${SQL_PASS}';"
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    -e "ALTER USER '${SQL_USER}'@'${SQL_HOST}' IDENTIFIED BY '${SQL_PASS}';"
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    -e "GRANT SELECT, INSERT, UPDATE ON \`${SQL_DB}\`.\`sonja_file_embedding_chunks\` TO '${SQL_USER}'@'${SQL_HOST}';"
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    -e "GRANT SELECT, INSERT, UPDATE ON \`${SQL_DB}\`.\`sonja_file_embeddings\` TO '${SQL_USER}'@'${SQL_HOST}';"
  docker exec -i "${MYSQL_CONTAINER_NAME:-mysql-local}" mysql \
    -uroot \
    "-p${MYSQL_ROOT_PASSWORD}" \
    -e "FLUSH PRIVILEGES;"
  echo "Vectorizer user ensured: ${VECTORIZER_MYSQL_USER}@${VECTORIZER_MYSQL_HOST}"
else
  echo "Skipping vectorizer user setup (set VECTORIZER_MYSQL_USER and VECTORIZER_MYSQL_PASSWORD in .env)."
fi

echo "Host: ${MYSQL_HOST_BIND_IP:-127.0.0.1}"
echo "Port: ${MYSQL_PORT:-3306}"
echo "Database: ${MYSQL_DATABASE}"
echo "User: ${MYSQL_USER}"
echo "Container: ${MYSQL_CONTAINER_NAME:-mysql-local}"
