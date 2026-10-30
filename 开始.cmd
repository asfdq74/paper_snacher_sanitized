@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0entry.ps1" -Task menu
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
