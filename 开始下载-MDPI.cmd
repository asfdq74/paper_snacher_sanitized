@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - MDPI
set "DL_ROOT=%CD%\downloads"

echo ============================================================
echo  MDPI downloader  (open access, off-screen browser)
echo   list : data\manifests\newlist21_papers.json
echo   out  : %DL_ROOT%\downloads_mdpi\
echo ============================================================
"C:\Program Files\nodejs\node.exe" "scripts\mdpi.mjs" --list "data\manifests\newlist21_papers.json" --outdir "%DL_ROOT%\downloads_mdpi" --delay 1200

echo.
echo Finished.
pause
