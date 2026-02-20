#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
INSTALL_WHATSAPP="${INSTALL_WHATSAPP:-false}"

echo "[run] install-servers.sh"
MONOREPO_BRANCH="$MONOREPO_BRANCH" \
SHARED_DOCKER_NETWORK="$SHARED_DOCKER_NETWORK" \
INSTALL_WHATSAPP="$INSTALL_WHATSAPP" \
bash "$ROOT_DIR/install-servers.sh"

echo "[run] install-ms-services.sh"
MONOREPO_BRANCH="$MONOREPO_BRANCH" \
SHARED_DOCKER_NETWORK="$SHARED_DOCKER_NETWORK" \
bash "$ROOT_DIR/install-ms-services.sh"

echo "[ok] all installers completed"
