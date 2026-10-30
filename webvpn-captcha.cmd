@echo off
setlocal EnableExtensions
cd /d "%~dp0"

set "TEST_SCRIPT=scripts\webvpn-captcha-risk-test.mjs"
set "AUTOFILL_PROFILE=%~dp0.browser_profile_scidir"

if /I "%~1"=="help" goto :usage
if /I "%~1"=="--help" goto :usage
if /I "%~1"=="/?" goto :usage

if not exist "%TEST_SCRIPT%" (
    echo [ERROR] Test script not found: %TEST_SCRIPT%
    set "EXIT_CODE=2"
    goto :done
)

set "PROFILE=%~1"
if not defined PROFILE set "PROFILE=human"

set "MODE=%~2"
if not defined MODE goto :prompt_mode
goto :run

:prompt_mode
echo.
echo WEBVPN WebVPN CAPTCHA manual test
echo.
echo   1. CAPTCHA only
echo   2. CAPTCHA + browser autofill + login
echo.
choice /c 12 /n /m "Select mode [1/2]: "
if errorlevel 2 (
    set "MODE=autofill"
) else (
    set "MODE=captcha"
)

:run
set "WEBVPN_CAPTCHA_TEST_AUTHORIZED=1"
set "WEBVPN_CAPTCHA_TEST_CONFIRM="

if /I "%MODE%"=="captcha" goto :run_captcha
if /I "%MODE%"=="autofill" goto :run_autofill
if /I "%MODE%"=="env-login" goto :run_env_login

echo [ERROR] Unknown mode: %MODE%
echo Use: %~nx0 [profile] [captcha^|autofill^|env-login]
set "EXIT_CODE=2"
goto :done

:run_captcha
node "%TEST_SCRIPT%" --run --profile "%PROFILE%" --hold-ms 5000
set "EXIT_CODE=%ERRORLEVEL%"
goto :done

:run_autofill
if not exist "%AUTOFILL_PROFILE%\Default\Login Data" (
    echo [ERROR] Autofill profile not found: %AUTOFILL_PROFILE%
    set "EXIT_CODE=2"
    goto :done
)
set "WEBVPN_CAPTCHA_TEST_CONFIRM=1"
node "%TEST_SCRIPT%" --run --profile "%PROFILE%" --hold-ms 5000 --browser-autofill --autofill-profile "%AUTOFILL_PROFILE%"
set "EXIT_CODE=%ERRORLEVEL%"
goto :done

:run_env_login
if not defined WEBVPN_CAPTCHA_TEST_USERNAME (
    echo [ERROR] Set WEBVPN_CAPTCHA_TEST_USERNAME before using env-login mode.
    set "EXIT_CODE=2"
    goto :done
)
if not defined WEBVPN_CAPTCHA_TEST_PASSWORD (
    echo [ERROR] Set WEBVPN_CAPTCHA_TEST_PASSWORD before using env-login mode.
    set "EXIT_CODE=2"
    goto :done
)
set "WEBVPN_CAPTCHA_TEST_CONFIRM=1"
node "%TEST_SCRIPT%" --run --profile "%PROFILE%" --hold-ms 5000 --login
set "EXIT_CODE=%ERRORLEVEL%"
goto :done

:usage
echo.
echo Usage:
echo   %~nx0 [profile] [captcha^|autofill^|env-login]
echo.
echo Profiles:
echo   human, human_slow, human_fast, linear, ease, jitter, stepped
echo.
echo Modes:
echo   captcha    Test the image slider only.
echo   autofill   Use browser-saved credentials, then click login.
echo   env-login  Use WEBVPN_CAPTCHA_TEST_USERNAME/PASSWORD, then click login.
echo.
echo Examples:
echo   %~nx0
echo   %~nx0 human autofill
echo   %~nx0 human_fast captcha
echo.
echo Results: output\captcha-risk
set "EXIT_CODE=0"
goto :done

:done
echo.
echo Exit code: %EXIT_CODE%
if /I "%~2"=="nopause" goto :end_without_pause
if /I "%~3"=="nopause" goto :end_without_pause
pause

:end_without_pause
exit /b %EXIT_CODE%
