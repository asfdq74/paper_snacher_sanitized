@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - Elsevier API check

echo ============================================================
echo  Checks whether the Elsevier API can serve full text right now
echo  (run this after switching network / exit node)
echo ============================================================
echo.

"C:\Program Files\nodejs\node.exe" "scripts\elscheck.mjs"
echo.
pause
