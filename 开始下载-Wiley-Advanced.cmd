@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - Wiley Advanced
set "DL_ROOT=%CD%\downloads"

echo ============================================================
echo  Wiley downloader - Advanced family batch (list2)
echo   list : data\manifests\list2_papers.json
echo   out  : %DL_ROOT%\downloads_wiley2\
echo   rate : 10s per paper, max 60 requests / 10 min
echo   Reuses the WebVPN session shared from the SciDir browser.
echo   Already-downloaded papers are skipped, so rerun anytime.
echo   If the session expires, a login window pops up.
echo ============================================================

:run
"C:\Program Files\nodejs\node.exe" "scripts\wiley.mjs" download --list "data\manifests\list2_papers.json" --outdir "%DL_ROOT%\downloads_wiley2" --delay 10000
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
echo  WebVPN session expired - log in in the window that opens
echo  (account + slider). Download resumes automatically after.
echo ============================================================
"C:\Program Files\nodejs\node.exe" "scripts\wiley.mjs" login
if errorlevel 1 (
  echo Login was not completed; retrying in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto login
)
goto run
