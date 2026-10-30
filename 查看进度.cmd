@echo off
setlocal
echo ============================================================
echo  1 = one-shot report
echo  2 = refresh every 30s (Ctrl+C to quit)
echo ============================================================
choice /c 12 /n /t 15 /d 1 >nul
if errorlevel 2 goto watch
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0entry.ps1" -Task progress
goto end

:watch
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0entry.ps1" -Task progress -Watch

:end
set "EXIT_CODE=%ERRORLEVEL%"
echo.
if not "%EXIT_CODE%"=="0" echo Exit code: %EXIT_CODE%
pause
exit /b %EXIT_CODE%
