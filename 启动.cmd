@echo off
setlocal
cd /d "%~dp0app"

echo.
echo   ChromaStack - hybrid layered color print planner
echo   Local server: http://127.0.0.1:8123/
echo   Close this window to stop the server.
echo.

where py >/dev/null 2>/dev/null
if %errorlevel%==0 (
  start "" "http://127.0.0.1:8123/"
  py -3 -m http.server 8123 --bind 127.0.0.1
) else (
  start "" "http://127.0.0.1:8123/"
  python -m http.server 8123 --bind 127.0.0.1
)
pause
