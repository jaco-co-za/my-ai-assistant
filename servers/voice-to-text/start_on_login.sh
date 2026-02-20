#!/usr/bin/env bash
set -euo pipefail

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
SERVER_RELATIVE_DIR="servers/voice-to-text"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if ! command -v git >/dev/null 2>&1; then
  echo "[error] git is not installed or not on PATH."
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "[error] docker is not installed or not on PATH."
  exit 1
fi

repo_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "$repo_root" ]; then
  echo "[error] This folder is not inside a git repo. Clone $MONOREPO_URL first."
  exit 1
fi

echo "[git] Pulling latest from $MONOREPO_URL ($MONOREPO_BRANCH)..."
git -C "$repo_root" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
git -C "$repo_root" checkout "$MONOREPO_BRANCH"
git -C "$repo_root" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
cd "$repo_root/$SERVER_RELATIVE_DIR"

if [ ! -f ".env" ]; then
  cp .env.example .env
fi

if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
fi

echo "[docker] Building and starting whisper-service..."
docker compose up -d --build whisper-service

echo "[ok] Whisper service is running in Docker on http://localhost:3221"
