#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"

MONOREPO_BRANCH="$MONOREPO_BRANCH" \
SHARED_DOCKER_NETWORK="$SHARED_DOCKER_NETWORK" \
bash "$ROOT_DIR/micro services/ai-assistant/install.sh"
