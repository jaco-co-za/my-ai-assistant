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

echo [setup] Installing tray dependencies...
pip install -r windows\tray\requirements-tray.txt
if errorlevel 1 (
  echo [error] Failed to install tray dependencies.
  pause
  exit /b 1
)

python windows\tray\whisper_tray.py

endlocal
