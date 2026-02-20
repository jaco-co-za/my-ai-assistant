@echo off
setlocal

set "REPO_URL=https://github.com/jaco-co-za/hface-voice-to-text.git"
cd /d "%~dp0"

where git >nul 2>&1
if errorlevel 1 (
  echo [error] git is not installed or not on PATH.
  exit /b 1
)

where docker >nul 2>&1
if errorlevel 1 (
  echo [error] docker is not installed or not on PATH.
  exit /b 1
)

if not exist ".git" (
  echo [error] This folder is not a git repo. Clone %REPO_URL% first.
  exit /b 1
)

echo [git] Pulling latest from %REPO_URL% (main)...
git pull "%REPO_URL%" main
if errorlevel 1 (
  echo [error] git pull failed.
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
)

echo [docker] Building and starting whisper-service...
docker compose up -d --build whisper-service
if errorlevel 1 (
  echo [error] docker compose up failed.
  exit /b 1
)

echo [ok] Whisper service is running in Docker on http://localhost:3221
endlocal
