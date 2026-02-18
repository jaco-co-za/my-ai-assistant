#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build

docker rm -f ms-file >/dev/null 2>&1 || true

docker build -t ms-file:latest .

PORT_MAPPING="3224:3224"
if [[ -n "${HOST_BIND_IP:-}" ]]; then
  PORT_MAPPING="${HOST_BIND_IP}:3224:3224"
fi

docker run -d \
  --name ms-file \
  --restart unless-stopped \
  --env-file .env \
  -p "$PORT_MAPPING" \
  ms-file:latest

if [[ -n "${HOST_BIND_IP:-}" ]]; then
  echo "mservice-file started on http://${HOST_BIND_IP}:3224"
else
  echo "mservice-file started on port 3224 (all interfaces)"
fi
docker ps --filter "name=ms-file"
