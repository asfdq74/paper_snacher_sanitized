@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Paper Snacher - watchdog

echo ============================================================
echo  Watchdog - watches ONE download batch at a time.
echo  Each mode only touches its own browser profiles,
echo  so running two watchdogs (one per batch) is safe.
echo.
echo   alerts : state\watchdog_alerts.log
echo   status : state\watchdog_status.txt
echo.
echo   mode = which batch to watch and restart
echo     1 = SciDir WebVPN  (SciDir entry)       port 9227
echo     2 = SciDir CARSI   (SciDir CARSI entry) port 9226
echo     3 = Wiley Advanced (Wiley entry)        port 9231
echo.
echo   On block pages: kill own procs, wipe ALL cookies (both browser
echo   profiles + the exported cookie file), then relaunch at once.
echo   Everything has to be re-authenticated, so a login window pops up.
echo ============================================================
choice /c 123 /n /t 20 /d 1 >nul
if errorlevel 3 goto wiley
if errorlevel 2 goto carsi
goto webvpn

:webvpn
echo mode = webvpn
"C:\Program Files\nodejs\node.exe" "scripts\watchdog.mjs" --mode webvpn --interval 10 --stall-min 10 --fail-streak 5 --restart --block-restart --block-trigger 1 --block-cooldown 0
goto end

:carsi
echo mode = carsi
"C:\Program Files\nodejs\node.exe" "scripts\watchdog.mjs" --mode carsi --interval 10 --stall-min 10 --fail-streak 5 --restart --block-restart --block-trigger 1 --block-cooldown 0
goto end

:wiley
echo mode = wiley
"C:\Program Files\nodejs\node.exe" "scripts\watchdog.mjs" --mode wiley --interval 10 --stall-min 10 --fail-streak 5 --restart --block-restart --block-trigger 1 --block-cooldown 0
goto end

:end
echo.
echo watchdog exited.
pause
