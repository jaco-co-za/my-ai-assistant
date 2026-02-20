#!/usr/bin/env bash
set -euo pipefail

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-master}"
MONOREPO_DIR="${MONOREPO_DIR:-$HOME/my-ai-assistant}"
SERVICE_RELATIVE_DIR="micro services/mservice-file"
SHARED_DOCKER_NETWORK="${SHARED_DOCKER_NETWORK:-ai-assistant-network}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

sync_monorepo() {
  if ! command -v git >/dev/null 2>&1; then
    echo "Git is not installed or not in PATH."
    exit 1
  fi

  repo_root="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel 2>/dev/null || true)"
  if [ -n "$repo_root" ]; then
    echo "Updating monorepo at '$repo_root' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..."
    git -C "$repo_root" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$repo_root" checkout "$MONOREPO_BRANCH"
    git -C "$repo_root" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
    cd "$repo_root/$SERVICE_RELATIVE_DIR"
    return
  fi

  if [ -d "$MONOREPO_DIR/.git" ]; then
    echo "Updating monorepo at '$MONOREPO_DIR' from '$MONOREPO_URL' ($MONOREPO_BRANCH)..."
    git -C "$MONOREPO_DIR" fetch "$MONOREPO_URL" "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" checkout "$MONOREPO_BRANCH"
    git -C "$MONOREPO_DIR" pull --ff-only "$MONOREPO_URL" "$MONOREPO_BRANCH"
  else
    echo "Cloning monorepo into '$MONOREPO_DIR'..."
    git clone --branch "$MONOREPO_BRANCH" "$MONOREPO_URL" "$MONOREPO_DIR"
  fi
  cd "$MONOREPO_DIR/$SERVICE_RELATIVE_DIR"
}

sync_monorepo

ensure_shared_network() {
  if ! docker network inspect "$SHARED_DOCKER_NETWORK" >/dev/null 2>&1; then
    docker network create "$SHARED_DOCKER_NETWORK" >/dev/null
  fi
}

if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose)
else
  echo "Error: docker compose or docker-compose not found" >&2
  exit 1
fi

ensure_shared_network

if [ ! -f ".env" ] && [ -f ".env.example" ]; then
  cp .env.example .env
fi

mkdir -p data

"${COMPOSE[@]}" down --remove-orphans || true
"${COMPOSE[@]}" up -d --build

echo "mservice-file is starting on http://localhost:3224"
