#!/bin/sh
set -eu

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