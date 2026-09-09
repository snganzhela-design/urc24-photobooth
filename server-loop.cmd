@echo off
rem Restart loop for the booth server. Started minimized by start.cmd.
cd /d "%~dp0"
:loop
node server.mjs
echo [%date% %time%] server exited with code %errorlevel%, restarting in 3 s >> logs\server-restarts.log
timeout /t 3 /nobreak >nul
goto loop
