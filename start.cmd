@echo off
rem URC24 photo booth: starts the local server (auto-restart loop) and Chrome/Edge in kiosk mode.
rem ASCII only in .cmd files (Windows console codepage mangles Cyrillic).
setlocal
cd /d "%~dp0"

if not exist ".env" (
  echo [ERROR] .env not found. Copy .env.example to .env and fill AI_API_KEY and UPLOAD_TOKEN.
  pause
  exit /b 1
)
where node >nul 2>nul || (
  echo [ERROR] node.exe not found in PATH. Install Node.js 20+ from nodejs.org.
  pause
  exit /b 1
)

set "BROWSER="
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%LocalAppData%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set "BROWSER=%%~P"
if not defined BROWSER (
  echo [ERROR] Neither Chrome nor Edge found.
  pause
  exit /b 1
)

if not exist logs mkdir logs
start "urc24-booth-server" /min cmd /c "%~dp0server-loop.cmd"

rem wait until the server answers (max ~20 s)
set /a tries=0
:wait
set /a tries+=1
powershell -NoProfile -Command "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:3777/api/status).StatusCode -eq 200 } catch { exit 1 }" >nul 2>nul
if errorlevel 1 (
  if %tries% geq 10 goto launch
  timeout /t 2 /nobreak >nul
  goto wait
)

:launch
start "" "%BROWSER%" --kiosk "http://127.0.0.1:3777/" ^
  --use-fake-ui-for-media-stream ^
  --autoplay-policy=no-user-gesture-required ^
  --noerrdialogs --disable-session-crashed-bubble --disable-infobars ^
  --disable-features=TranslateUI --no-first-run --no-default-browser-check ^
  --overscroll-history-navigation=0 --disable-pinch ^
  --user-data-dir="%~dp0chrome-profile"
endlocal
