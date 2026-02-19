# Sonja File UI

Standalone Vue 3 + Vite UI for Sonja file retrieval only.

## Features

- Prompt + reply interface.
- Auto-prefixes prompts with `sonja file`.
- Queries `mservice-file` `/llm-query` with owner forced to `sonja`.
- Shows thumbnails for image and PDF results.
- Small summary text under each thumbnail.
- Click thumbnail for fullscreen preview.
- Fullscreen share button uses Web Share API (Android share intent where supported).

## Setup

```bash
cd "micro services/sonja-file-ui"
cp .env.example .env
yarn
yarn dev
```

Default port is `5188` (change with `VITE_PORT` in `.env`).

## Env values

- `VITE_PORT`
- `VITE_FILE_SERVICE_URL` (for example `http://localhost:3224`)
- `VITE_FILE_SERVICE_AUTH` (Bearer token for `mservice-file`)
- `VITE_SONJA_PROMPT_PREFIX` (default `sonja file`)
