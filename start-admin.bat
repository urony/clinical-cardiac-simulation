@echo off
rem Starts the local case-management interface and opens it in the browser.
rem Double-click this file. Close the window (or press Ctrl+C) to stop it.
cd /d "%~dp0"
start "" cmd /c "timeout /t 3 /nobreak >nul & start http://127.0.0.1:4180/"
call npm run admin
pause
