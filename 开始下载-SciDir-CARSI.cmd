@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - ScienceDirect (CARSI direct)
set "DL_ROOT=%CD%\downloads"

echo ============================================================
echo  ScienceDirect downloader - CARSI direct mode
echo   list : data\manifests\newlist3_sd.json
echo   out  : %DL_ROOT%\downloads_scidir\
echo   Uses the CARSI institutional session (no WebVPN, no campus IP).
echo   Already-downloaded papers are skipped, so you can stop/rerun.
echo   If the CARSI session expires, a login window pops up.
echo ============================================================

:run
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" download --direct --list "data\manifests\newlist3_sd.json" --outdir "%DL_ROOT%\downloads_scidir" --rotate 0 --delay 3000
if errorlevel 10 goto login
if errorlevel 1 (
  echo Script exited with an error. Press any key to retry, or close this window.
  pause >nul
  goto run
)
echo.
echo Finished.
pause
exit /b 0

:login
echo.
echo ============================================================
echo  CARSI session expired.
echo  In the window that opens:
echo    1) click "Access through your organization"
echo    2) search and pick "Example University"
echo    3) sign in with your WEBVPN account
echo  Download resumes automatically afterwards.
echo ============================================================
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" login --direct
if errorlevel 1 (
  echo Login was not completed; retrying in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto login
)
goto run
