#!/usr/bin/env bash
set -euo pipefail

npm ci
npm run build

docker rm -f ms-file >/dev/null 2>&1 || true

docker build -t ms-file:latest .

docker run -d \
  --name ms-file \
  --restart unless-stopped \
  --env-file .env \
  -p 3224:3224 \
  ms-file:latest

echo "mservice-file started on http://localhost:3224"
docker ps --filter "name=ms-file"