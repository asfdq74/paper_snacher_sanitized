[CmdletBinding()]
param(
    [ValidateSet('human', 'human_slow', 'human_fast', 'linear', 'ease', 'jitter', 'stepped')]
    [string]$Profile = 'human',

    [switch]$Login,

    [switch]$BrowserAutofill,

    [string]$AutofillProfile = '.browser_profile_scidir',

    [ValidateRange(0, 2147483647)]
    [int]$Seed,

    [ValidateRange(0, 15000)]
    [int]$HoldMs = 5000
)

$ErrorActionPreference = 'Stop'
$mainScript = Join-Path $PSScriptRoot 'webvpn-captcha-risk-test.mjs'

if (-not (Test-Path -LiteralPath $mainScript)) {
    throw "Test script not found: $mainScript"
}

Write-Host ''
Write-Host 'WEBVPN WebVPN CAPTCHA manual test' -ForegroundColor Cyan
Write-Host "Profile: $Profile"
Write-Host 'The browser is always headed. Old test profiles and WEBVPN cookies are cleaned first.'
Write-Host 'One CAPTCHA attempt and at most one login submission will be made.'
if ($Login -and $BrowserAutofill) {
    throw '-Login and -BrowserAutofill cannot be used together.'
}
if ($BrowserAutofill) {
    Write-Host "Browser autofill profile: $AutofillProfile"
    Write-Host 'The source profile is copied. Its saved credentials will be submitted once.'
}
Write-Host ''

$confirmation = Read-Host "Type START to continue"
if ($confirmation -ne 'START') {
    Write-Host 'Cancelled.'
    exit 2
}

$env:WEBVPN_CAPTCHA_TEST_AUTHORIZED = '1'
$exitCode = 1

try {
    $nodeArgs = @(
        $mainScript,
        '--run',
        '--profile', $Profile,
        '--hold-ms', [string]$HoldMs
    )
    if ($PSBoundParameters.ContainsKey('Seed')) {
        $nodeArgs += @('--seed', [string]$Seed)
    }

    if ($Login -or $BrowserAutofill) {
        $env:WEBVPN_CAPTCHA_TEST_CONFIRM = '1'
    }

    if ($Login) {
        $username = (Read-Host 'Dedicated test username').Trim()
        if (-not $username) {
            throw 'A dedicated test username is required for login mode.'
        }

        $securePassword = Read-Host 'Dedicated test password' -AsSecureString
        $passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
        try {
            $env:WEBVPN_CAPTCHA_TEST_USERNAME = $username
            $env:WEBVPN_CAPTCHA_TEST_PASSWORD =
                [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
        }
        finally {
            [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
        }
        $nodeArgs += '--login'
    }
    elseif ($BrowserAutofill) {
        $profilePath = if ([IO.Path]::IsPathRooted($AutofillProfile)) {
            $AutofillProfile
        }
        else {
            Join-Path (Split-Path $PSScriptRoot -Parent) $AutofillProfile
        }
        if (-not (Test-Path -LiteralPath $profilePath -PathType Container)) {
            throw "Autofill profile not found: $profilePath"
        }
        $nodeArgs += @(
            '--browser-autofill',
            '--autofill-profile', $profilePath
        )
    }

    & node @nodeArgs
    $exitCode = $LASTEXITCODE
}
finally {
    foreach ($name in @(
        'WEBVPN_CAPTCHA_TEST_AUTHORIZED',
        'WEBVPN_CAPTCHA_TEST_CONFIRM',
        'WEBVPN_CAPTCHA_TEST_USERNAME',
        'WEBVPN_CAPTCHA_TEST_PASSWORD'
    )) {
        Remove-Item "Env:$name" -ErrorAction SilentlyContinue
    }
}

exit $exitCode
