#!/usr/bin/env bash
set -euo pipefail

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-main}"
MONOREPO_DIR="${MONOREPO_DIR:-$HOME/my-ai-assistant}"
SERVER_RELATIVE_DIR="servers/s3-local"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sync_monorepo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is not installed or not in PATH."
    exit 1
  fi

  local repo_root=""
  if repo_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "==> Updating monorepo at '$repo_root' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..."
    git -C "$repo_root" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$repo_root" checkout "$MONOREPO_BRANCH"
    git -C "$repo_root" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
    cd "$repo_root/$SERVER_RELATIVE_DIR"
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
  cd "$MONOREPO_DIR/$SERVER_RELATIVE_DIR"
}

sync_monorepo

IMAGE="${IMAGE:-quay.io/minio/minio:latest}"
MC_IMAGE="${MC_IMAGE:-quay.io/minio/mc:latest}"
CONTAINER_NAME="${CONTAINER_NAME:-s3-local}"
HOST_BIND_IP="${HOST_BIND_IP:-192.168.55.113}"
APP_PORT="${APP_PORT:-9000}"
CONSOLE_PORT="${CONSOLE_PORT:-9001}"
DATA_DIR="${DATA_DIR:-$PWD/data}"
ENV_FILE="${ENV_FILE:-$PWD/.env}"
DEFAULT_BUCKET="${DEFAULT_BUCKET:-files}"

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH."
  exit 1
fi

if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
fi

mkdir -p "$DATA_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
MINIO_ROOT_USER=aiassist
MINIO_ROOT_PASSWORD=MASEHARRE@123
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
  --network "$SHARED_DOCKER_NETWORK" \
  --env-file "$ENV_FILE" \
  -p "$HOST_BIND_IP:$APP_PORT:9000" \
  -p "$HOST_BIND_IP:$CONSOLE_PORT:9001" \
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
  "$MC_IMAGE" mb --ignore-existing "local/${MINIO_DEFAULT_BUCKET}" >/dev/null

echo "==> S3 server is ready"
echo "API:     http://${HOST_BIND_IP}:${APP_PORT}"
echo "Console: http://${HOST_BIND_IP}:${CONSOLE_PORT}"
echo "Bucket:  ${MINIO_DEFAULT_BUCKET}"

docker ps --filter "name=$CONTAINER_NAME"

echo "==> Following logs (Ctrl+C to stop):"
docker logs -f "$CONTAINER_NAME"
