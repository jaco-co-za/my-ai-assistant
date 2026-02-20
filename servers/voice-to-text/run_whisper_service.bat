@echo off
setlocal
cd /d "%~dp0"

if not exist ".venv\Scripts\python.exe" (
  echo [setup] Creating virtual environment...
  py -3 -m venv .venv 2>nul || python -m venv .venv
  if errorlevel 1 (
    echo [error] Failed to create virtual environment.
    pause
    exit /b 1
  )
)

call ".venv\Scripts\activate.bat"
if errorlevel 1 (
  echo [error] Failed to activate virtual environment.
  pause
  exit /b 1
)

echo [setup] Installing dependencies...
python -m pip install --upgrade pip
pip install -r requirements.txt
if errorlevel 1 (
  echo [error] Dependency install failed.
  pause
  exit /b 1
)

if not exist ".env" (
  copy /Y ".env.example" ".env" >nul
  echo [setup] Created .env from .env.example
)

echo.
echo [run] Starting Whisper service on http://localhost:3221
echo [run] Health endpoint: http://localhost:3221/health
echo.
uvicorn app.main:app --host 0.0.0.0 --port 3221

endlocal
