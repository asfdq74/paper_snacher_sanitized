@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - ScienceDirect
set "DL_ROOT=%CD%\downloads"

echo ============================================================
echo  ScienceDirect downloader (WEBVPN WebVPN, off-screen browser)
echo   list : data\manifests\newlist3_sd.json
echo   out  : %DL_ROOT%\downloads_scidir\
echo   If the WebVPN session expires, a login window pops up.
echo ============================================================

:run
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" download --visible --size 800,600 --list "data\manifests\newlist3_sd.json" --outdir "%DL_ROOT%\downloads_scidir" --rotate 9 --delay 2500
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
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" login --size 800,600
if errorlevel 1 (
  echo Login was not completed; retrying in 10 seconds...
  timeout /t 10 /nobreak >nul
  goto login
)
goto run
