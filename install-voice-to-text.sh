#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"

SHARED_DOCKER_NETWORK="$SHARED_DOCKER_NETWORK" \
bash "$ROOT_DIR/servers/voice-to-text/start_on_login.sh"
