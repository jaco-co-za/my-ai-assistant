@echo off
setlocal

set "MONOREPO_URL=https://github.com/jaco-co-za/my-ai-assistant.git"
set "MONOREPO_BRANCH=master"
set "SERVER_RELATIVE_DIR=servers/voice-to-text"
set "SHARED_DOCKER_NETWORK=ai-assistant-network"
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

for /f "delims=" %%i in ('git rev-parse --show-toplevel 2^>nul') do set "REPO_ROOT=%%i"
if "%REPO_ROOT%"=="" (
  echo [error] This folder is not inside a git repo. Clone %MONOREPO_URL% first.
  exit /b 1
)

echo [git] Pulling latest from %MONOREPO_URL% (%MONOREPO_BRANCH%)...
git -C "%REPO_ROOT%" fetch "%MONOREPO_URL%" "%MONOREPO_BRANCH%"
git -C "%REPO_ROOT%" checkout "%MONOREPO_BRANCH%"
git -C "%REPO_ROOT%" pull --ff-only "%MONOREPO_URL%" "%MONOREPO_BRANCH%"
if errorlevel 1 (
  echo [error] git pull failed.
  exit /b 1
)

cd /d "%REPO_ROOT%\%SERVER_RELATIVE_DIR%"

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
)

docker network inspect "%SHARED_DOCKER_NETWORK%" >nul 2>&1
if errorlevel 1 (
  docker network create "%SHARED_DOCKER_NETWORK%" >nul
)

echo [docker] Building and starting whisper-service...
docker compose up -d --build whisper-service
if errorlevel 1 (
  echo [error] docker compose up failed.
  exit /b 1
)

echo [ok] Whisper service is running in Docker on http://localhost:3221
endlocal
