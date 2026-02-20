@echo off
setlocal
cd /d "%~dp0"

set "BASE_URL=http://localhost:3221"

echo [test] Checking health endpoint...
curl -s "%BASE_URL%/health"
echo.

if "%~1"=="" (
  echo.
  echo [hint] To test transcription, pass an audio file:
  echo        test_whisper_service.bat sample.wav
  endlocal
  exit /b 0
)

echo [test] Sending "%~1" to /transcribe ...
curl -s -X POST "%BASE_URL%/transcribe" -F "file=@%~1"
echo.

endlocal
