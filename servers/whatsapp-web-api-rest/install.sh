#!/usr/bin/env bash

set -euo pipefail

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-main}"
MONOREPO_DIR="${MONOREPO_DIR:-$HOME/my-ai-assistant}"
SERVER_RELATIVE_DIR="servers/whatsapp-web-api-rest"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"

IMAGE="${IMAGE:-jaco/whatsapp-web-api-rest:add-converse-status}"
CONTAINER_NAME="${CONTAINER_NAME:-whatsapp}"
AUTH_VOLUME="${AUTH_VOLUME:-whatsapp_auth}"
APP_PORT="${APP_PORT:-8085}"
API_AUTH_BEARER_TOKEN="${API_AUTH_BEARER_TOKEN:-}"
WEBHOOK_URLS="${WEBHOOK_URLS:-http://192.168.55.73:3350/receive-msg}"
WEBHOOK_AUTH_BEARER_TOKEN="${WEBHOOK_AUTH_BEARER_TOKEN:-d755d72d2f4a93ca015eecc9b07a7c61ba9cb9a6e6fab8387e93a03d5078b194}"
IMAGE_TAG="${IMAGE_TAG:-local}"
BUILD_SHA="${BUILD_SHA:-dev}"
AUTHORIZED_WHATSAPP_IDS="${AUTHORIZED_WHATSAPP_IDS:-}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

sync_monorepo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is not installed or not in PATH."
    exit 1
  fi

  local repo_root=""
  if repo_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null)"; then
    echo "==> Updating monorepo at '$repo_root' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..." >&2
    git -C "$repo_root" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$repo_root" checkout "$MONOREPO_BRANCH"
    git -C "$repo_root" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
    echo "$repo_root/$SERVER_RELATIVE_DIR"
    return
  fi

  if [[ -d "$MONOREPO_DIR/.git" ]]; then
    echo "==> Updating monorepo at '$MONOREPO_DIR' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..." >&2
    git -C "$MONOREPO_DIR" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" checkout "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
  else
    echo "==> Cloning monorepo into '$MONOREPO_DIR'..." >&2
    git clone --branch "$MONOREPO_BRANCH" "$MONOREPO_URL" "$MONOREPO_DIR"
  fi
  echo "$MONOREPO_DIR/$SERVER_RELATIVE_DIR"
}

DEPLOY_DIR="$(sync_monorepo)"
cd "$DEPLOY_DIR"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
REPO_ENV_FILE="${REPO_ENV_FILE:-$DEPLOY_DIR/.env}"

if [[ -z "$API_AUTH_BEARER_TOKEN" ]]; then
  if command -v openssl >/dev/null 2>&1; then
    API_AUTH_BEARER_TOKEN="$(openssl rand -hex 32)"
  else
    API_AUTH_BEARER_TOKEN="$(cat /proc/sys/kernel/random/uuid | tr -d '-')"
  fi
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker is not installed or not in PATH."
  exit 1
fi

if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
fi

ensure_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"

  if grep -qE "^${key}=" "$file"; then
    return 0
  fi

  printf "%s=%s\n" "$key" "$value" >> "$file"
}

set_env_value() {
  local key="$1"
  local value="$2"
  local file="$3"

  local escaped_value="${value//\\/\\\\}"
  escaped_value="${escaped_value//|/\\|}"

  if grep -qE "^${key}=" "$file"; then
    sed -i "s|^${key}=.*|${key}=${escaped_value}|" "$file"
  else
    printf "%s=%s\n" "$key" "$escaped_value" >> "$file"
  fi
}

inject_env_file() {
  local src_file="$1"
  local dest_file="$2"

  if [[ ! -f "$src_file" ]]; then
    return 0
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    [[ -z "$line" ]] && continue
    [[ "$line" =~ ^[[:space:]]*# ]] && continue
    line="${line#export }"
    if [[ "$line" =~ ^[A-Za-z_][A-Za-z0-9_]*= ]]; then
      local key="${line%%=*}"
      local value="${line#*=}"
      set_env_value "$key" "$value" "$dest_file"
    fi
  done < "$src_file"
}

ENV_DIR="$(dirname "$ENV_FILE")"
mkdir -p "$ENV_DIR"

if [[ ! -f "$ENV_FILE" ]]; then
  cat > "$ENV_FILE" <<EOF
APP_PORT=$APP_PORT

# Required bearer token for incoming API requests.
# Clients must send: Authorization: Bearer <token>
API_AUTH_BEARER_TOKEN=$API_AUTH_BEARER_TOKEN

# Optional startup webhook registration:
# comma/semicolon/newline separated URLs
WEBHOOK_URLS=$WEBHOOK_URLS

# Optional file path that contains webhook URLs (newline or CSV)
# WEBHOOKS_FILE=/data/webhooks.csv

# Optional bearer token used in outbound webhook requests
WEBHOOK_AUTH_BEARER_TOKEN=$WEBHOOK_AUTH_BEARER_TOKEN

# Optional startup metadata log fields
IMAGE_TAG=$IMAGE_TAG
BUILD_SHA=$BUILD_SHA
AUTHORIZED_WHATSAPP_IDS=$AUTHORIZED_WHATSAPP_IDS
EOF
  echo "==> Created default env file at '$ENV_FILE'"
else
  ensure_env_value "APP_PORT" "$APP_PORT" "$ENV_FILE"
  ensure_env_value "API_AUTH_BEARER_TOKEN" "$API_AUTH_BEARER_TOKEN" "$ENV_FILE"
  ensure_env_value "WEBHOOK_URLS" "$WEBHOOK_URLS" "$ENV_FILE"
  ensure_env_value "WEBHOOK_AUTH_BEARER_TOKEN" "$WEBHOOK_AUTH_BEARER_TOKEN" "$ENV_FILE"
  ensure_env_value "IMAGE_TAG" "$IMAGE_TAG" "$ENV_FILE"
  ensure_env_value "BUILD_SHA" "$BUILD_SHA" "$ENV_FILE"
  ensure_env_value "AUTHORIZED_WHATSAPP_IDS" "$AUTHORIZED_WHATSAPP_IDS" "$ENV_FILE"
  echo "==> Reused env file at '$ENV_FILE' (added missing defaults only)"
fi

inject_env_file "$REPO_ENV_FILE" "$ENV_FILE"
if [[ -f "$REPO_ENV_FILE" ]]; then
  echo "==> Injected values from '$REPO_ENV_FILE' into '$ENV_FILE'"
fi

# Align docker port publish with the effective env file value.
if grep -qE '^APP_PORT=' "$ENV_FILE"; then
  APP_PORT="$(grep -E '^APP_PORT=' "$ENV_FILE" | tail -n1 | cut -d'=' -f2- | tr -d '[:space:]')"
fi
if [[ -z "$APP_PORT" ]]; then
  echo "APP_PORT is empty. Set APP_PORT in '$ENV_FILE' to a valid TCP port (1-65535)."
  exit 1
fi
if [[ ! "$APP_PORT" =~ ^[0-9]+$ ]]; then
  echo "APP_PORT='$APP_PORT' is invalid. APP_PORT must be numeric (1-65535)."
  exit 1
fi
if (( APP_PORT < 1 || APP_PORT > 65535 )); then
  echo "APP_PORT='$APP_PORT' is out of range. Use a port between 1 and 65535."
  exit 1
fi
echo "==> Effective APP_PORT: $APP_PORT"

echo "==> Building docker image '$IMAGE'..."
docker build --pull -t "$IMAGE" .

echo "==> Recreating container '$CONTAINER_NAME'..."
docker volume create "$AUTH_VOLUME" >/dev/null
docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
docker run -d \
  --name "$CONTAINER_NAME" \
  --restart unless-stopped \
  --network "$SHARED_DOCKER_NETWORK" \
  --env-file "$ENV_FILE" \
  -p "$APP_PORT:$APP_PORT" \
  -v "$AUTH_VOLUME:/app/auth_info" \
  "$IMAGE" >/dev/null

echo "==> Container status:"
docker ps --filter "name=$CONTAINER_NAME"

echo "==> Following logs (Ctrl+C to stop):"
docker logs -f "$CONTAINER_NAME"
