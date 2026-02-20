#!/usr/bin/env bash
set -euo pipefail

REPO_URL="https://github.com/jaco-co-za/hface-voice-to-text.git"
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

if [ ! -d ".git" ]; then
  echo "[error] This folder is not a git repo. Clone $REPO_URL first."
  exit 1
fi

echo "[git] Pulling latest from $REPO_URL (main)..."
git pull "$REPO_URL" main

if [ ! -f ".env" ]; then
  cp .env.example .env
fi

if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
  docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
fi

echo "[docker] Building and starting whisper-service..."
docker compose up -d --build whisper-service

echo "[ok] Whisper service is running in Docker on http://localhost:3221"
