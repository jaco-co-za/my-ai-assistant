#!/bin/sh
set -eu

MONOREPO_URL="${MONOREPO_URL:-https://github.com/jaco-co-za/my-ai-assistant.git}"
MONOREPO_BRANCH="${MONOREPO_BRANCH:-main}"
MONOREPO_DIR="${MONOREPO_DIR:-$HOME/my-ai-assistant}"
SERVER_RELATIVE_DIR="servers/chronicle-docker"
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
    cd "$repo_root/$SERVER_RELATIVE_DIR"
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
  cd "$MONOREPO_DIR/$SERVER_RELATIVE_DIR"
}

sync_monorepo

REPO_URL="https://github.com/soulteary/docker-cronicle"
REPO_DIR="docker-cronicle"

# Remove any existing host install
rm -rf /opt/cronicle

# Fresh clone or update
if [ -d "$REPO_DIR/.git" ]; then
  git -C "$REPO_DIR" pull --ff-only
else
  rm -rf "$REPO_DIR"
  git clone "$REPO_URL" "$REPO_DIR"
fi

# Choose compose command
if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "Error: docker compose or docker-compose not found" >&2
  exit 1
fi

cd "$REPO_DIR"

# (Re)start Cronicle
$COMPOSE down
$COMPOSE up -d

echo "Cronicle is starting. Open: http://localhost:3012"
