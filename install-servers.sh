#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
INSTALL_WHATSAPP="${INSTALL_WHATSAPP:-false}"

run_script() {
  local script_path="$1"
  local label="$2"
  if [[ ! -f "$script_path" ]]; then
    echo "[skip] $label ($script_path not found)"
    return 0
  fi
  echo "[run] $label"
  MONOREPO_BRANCH="$MONOREPO_BRANCH" SHARED_DOCKER_NETWORK="$SHARED_DOCKER_NETWORK" bash "$script_path"
}

if command -v docker >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1 || true
fi

run_script "$ROOT_DIR/servers/chronicle-docker/install.sh" "chronicle-docker"
run_script "$ROOT_DIR/servers/voice-to-text/start_on_login.sh" "voice-to-text"
run_script "$ROOT_DIR/servers/s3-local/install.sh" "s3-local"
run_script "$ROOT_DIR/servers/mysql-docker/install.sh" "mysql-docker"

if [[ "${INSTALL_WHATSAPP,,}" == "true" ]]; then
  run_script "$ROOT_DIR/servers/whatsapp-web-api-rest/install.sh" "whatsapp-web-api-rest"
else
  echo "[skip] whatsapp-web-api-rest (set INSTALL_WHATSAPP=true to include)"
fi

echo "[ok] server installers completed"
