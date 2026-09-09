@echo off
rem Registers start.cmd in the user's Startup folder and disables display/sleep timeouts.
rem Windows auto-login (netplwiz) must be enabled by the owner separately.
setlocal
cd /d "%~dp0"
powershell -NoProfile -Command ^
  "$s = (New-Object -ComObject WScript.Shell).CreateShortcut([IO.Path]::Combine([Environment]::GetFolderPath('Startup'), 'URC24 Photo Booth.lnk'));" ^
  "$s.TargetPath = '%~dp0start.cmd'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Save(); 'shortcut created: ' + $s.FullName"
powercfg /change monitor-timeout-ac 0
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
echo Done. The booth will start after login. Enable auto-login: run netplwiz, untick "Users must enter a user name and password".
pause
endlocal
