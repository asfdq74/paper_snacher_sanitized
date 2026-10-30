@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - Elsevier API
set "DL_ROOT=%CD%\downloads"

if not exist "state\elsevier_key.txt" (
  echo [!] Put your Elsevier API key into state\elsevier_key.txt first.
  echo     Apply at https://dev.elsevier.com/apikey/manage
  pause
  exit /b 1
)

echo [1/2] dry run on 2 articles (checks entitlement)...
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" api --list "data\manifests\newlist3_sd.json" --outdir "%DL_ROOT%\downloads_api" --via direct --max 2 --dry-run

echo.
echo [2/2] full run ...
"C:\Program Files\nodejs\node.exe" "scripts\scidir.mjs" api --list "data\manifests\newlist3_sd.json" --outdir "%DL_ROOT%\downloads_api" --via direct --conc 4

echo.
pause
