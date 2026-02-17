#!/usr/bin/env bash
set -euo pipefail

IMAGE="${IMAGE:-quay.io/minio/minio:latest}"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-s3-local}"
APP_PORT="${APP_PORT:-9000}"
CONSOLE_PORT="${CONSOLE_PORT:-9001}"
DATA_DIR="${DATA_DIR:-$PWD/data}"
ENV_FILE="${ENV_FILE:-$PWD/.env}"
DEFAULT_BUCKET="${DEFAULT_BUCKET:-files}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH."
  exit 1
fi

mkdir -p "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
MINIO_ROOT_USER=minioadmin
MINIO_ROOT_PASSWORD=minioadmin
MINIO_DEFAULT_BUCKET=$DEFAULT_BUCKET
EOF
  echo "==> Created $ENV_FILE"
fi

MINIO_ROOT_USER="$(grep -E '^MINIO_ROOT_USER=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true)"
MINIO_ROOT_PASSWORD="$(grep -E '^MINIO_ROOT_PASSWORD=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true)"
MINIO_DEFAULT_BUCKET="$(grep -E '^MINIO_DEFAULT_BUCKET=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2- || true)"

if [[ -z "$MINIO_ROOT_USER" || -z "$MINIO_ROOT_PASSWORD" ]]; then
  echo "MINIO_ROOT_USER and MINIO_ROOT_PASSWORD must be set in $ENV_FILE"
  exit 1
fi

if [[ -z "$MINIO_DEFAULT_BUCKET" ]]; then
  MINIO_DEFAULT_BUCKET="$DEFAULT_BUCKET"
fi

echo "==> Pulling images..."
docker pull "$IMAGE" >/dev/null
docker pull "$MC_IMAGE" >/dev/null

echo "==> Recreating container '$CONTAINER_NAME'..."
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true

docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --env-file "$ENV_FILE" \
  -p "$APP_PORT:9000" \
  -p "$CONSOLE_PORT:9001" \
  -v "$DATA_DIR:/data" \
  "$IMAGE" server /data --console-address ":9001" >/dev/null

echo "==> Waiting for MinIO API..."
for _ in $(seq 1 45); do
  if curl -fsS "http://localhost:${APP_PORT}/minio/health/live" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

if ! curl -fsS "http://localhost:${APP_PORT}/minio/health/live" >/dev/null 2>&1; then
  echo "MinIO did not become healthy in time."
  docker logs "$CONTAINER_NAME" || true
  exit 1
fi

echo "==> Ensuring bucket '$MINIO_DEFAULT_BUCKET' exists..."
docker run --rm \
  --network "container:${CONTAINER_NAME}" \
  -e MC_HOST_local="http://${MINIO_ROOT_USER}:${MINIO_ROOT_PASSWORD}@127.0.0.1:9000" \
  "$MC_IMAGE" sh -c "mc mb --ignore-existing local/${MINIO_DEFAULT_BUCKET}" >/dev/null

echo "==> S3 server is ready"
echo "API:     http://localhost:${APP_PORT}"
echo "Console: http://localhost:${CONSOLE_PORT}"
echo "Bucket:  ${MINIO_DEFAULT_BUCKET}"

docker ps --filter "name=$CONTAINER_NAME"

echo "==> Following logs (Ctrl+C to stop):"
docker logs -f "$CONTAINER_NAME"
