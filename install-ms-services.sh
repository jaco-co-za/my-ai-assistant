#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"

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

run_script "$ROOT_DIR/micro services/mservice-email/install.sh" "mservice-email"
run_script "$ROOT_DIR/micro services/mservice-file/install.sh" "mservice-file"
run_script "$ROOT_DIR/micro services/mss-homeassistant/install.sh" "mss-homeassistant"
run_script "$ROOT_DIR/micro services/ai-assistant/install.sh" "ai-assistant"
run_script "$ROOT_DIR/micro services/sonja-file-ui/install.sh" "sonja-file-ui"

echo "[ok] micro service installers completed"
