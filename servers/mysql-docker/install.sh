#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-$ROOT_DIR/.env}"
ENV_EXAMPLE_FILE="$ROOT_DIR/.env.example"

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
echo "Host: ${MYSQL_HOST_BIND_IP:-127.0.0.1}"
echo "Port: ${MYSQL_PORT:-3306}"
echo "Database: ${MYSQL_DATABASE}"
echo "User: ${MYSQL_USER}"
echo "Container: ${MYSQL_CONTAINER_NAME:-mysql-local}"
