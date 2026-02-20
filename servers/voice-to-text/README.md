# Standalone Whisper Service

A minimal local Whisper API service using FastAPI + faster-whisper.

## 1) Setup

```bash
python -m venv .venv
. .venv/Scripts/activate  # Windows PowerShell: .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
```

## 2) Run

```bash
uvicorn app.main:app --host 0.0.0.0 --port 3221
```

The first startup downloads the model (`WHISPER_MODEL_SIZE`, default `small`).

## 3) Use

Health check:

```bash
curl http://localhost:3221/health
```

Transcribe:

```bash
curl -X POST "http://localhost:3221/transcribe" \
  -F "file=@sample.wav"
```

Translate to English:

```bash
curl -X POST "http://localhost:3221/transcribe?task=translate" \
  -F "file=@sample.mp3"
```

## 4) Docker

```bash
docker compose up -d --build whisper-service
```

## 5) Start-on-login scripts (pull latest + run Docker)

Windows:

```bash
.\start_on_login.bat
```

Linux:

```bash
./start_on_login.sh
```

Both scripts pull latest from `https://github.com/jaco-co-za/hface-voice-to-text.git` and run `docker compose up -d --build whisper-service`.

## 6) Local non-Docker run (optional)

```bash
.\run_whisper_service.bat
```

## 7) Tray controller

```bash
.\run_whisper_tray.bat
```

The tray app monitors API health and can open health/logs.
