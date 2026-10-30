@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - Wiley
set "DL_ROOT=%CD%\downloads"

echo ============================================================
echo  Wiley downloader (WEBVPN WebVPN -^> /doi/pdfdirect)
echo   list : data\manifests\wiley_papers.json
echo   out  : %DL_ROOT%\downloads_wiley\
echo   rate : 10s per paper, max 60 requests / 10 min
echo   Running in an off-screen browser. Already-downloaded
echo   papers are skipped, so you can stop and rerun anytime.
echo   If the WebVPN session expires, a login window pops up.
echo ============================================================

:run
"C:\Program Files\nodejs\node.exe" "scripts\wiley.mjs" download --list "data\manifests\wiley_papers.json" --outdir "%DL_ROOT%\downloads_wiley" --delay 10000
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
echo  Session expired - log in to WebVPN in the window that opens
echo  (account + slider). Download resumes automatically afterwards.
echo ============================================================
"C:\Program Files\nodejs\node.exe" "scripts\wiley.mjs" login
if errorlevel 1 (
  echo Login was not completed; retrying in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto login
)
goto run
