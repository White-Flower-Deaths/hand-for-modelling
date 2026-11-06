@echo off
setlocal
cd /d "%~dp0"
echo Starting Form Motion Studio at http://127.0.0.1:8000
echo Keep this window open while using the app. Press Ctrl+C here to stop.
where py >nul 2>&1
if %errorlevel%==0 (
  py -3 -m http.server 8000 --bind 127.0.0.1
) else (
  python -m http.server 8000 --bind 127.0.0.1
)
