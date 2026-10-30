[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [ValidateSet(
        'menu',
        'mdpi',
        'scidir-webvpn',
        'scidir-carsi',
        'scidir-api',
        'wiley',
        'wiley-advanced',
        'watchdog',
        'elsevier-check',
        'progress',
        'captcha-test'
    )]
    [string]$Task,

    [ValidateSet('webvpn', 'carsi', 'wiley')]
    [string]$Mode,

    [string]$CaptchaProfile = 'human',
    [string]$CaptchaMode = '',

    [int]$Max = 0,
    [string[]]$Only = @(),
    [switch]$RetryNoAccess,
    [switch]$Watch,
    [switch]$DryRun
)

$ErrorActionPreference = 'Continue'
$Root = $PSScriptRoot
$StateDir = Join-Path $Root 'state'
$DataDir = Join-Path $Root 'data'
$DownloadRoot = Join-Path $Root 'downloads'
$script:TaskExitCode = 0
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path -LiteralPath $StateDir)) {
    New-Item -ItemType Directory -Path $StateDir | Out-Null
}
Set-Location -LiteralPath $Root

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------

function Resolve-NodePath {
    $command = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }

    $candidates = @(
        (Join-Path $env:ProgramFiles 'nodejs\node.exe')
    )
    $programFilesX86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
    if ($programFilesX86) {
        $candidates += Join-Path $programFilesX86 'nodejs\node.exe'
    }
    foreach ($candidate in $candidates) {
        if ($candidate -and (Test-Path -LiteralPath $candidate -PathType Leaf)) {
            return $candidate
        }
    }
    throw 'Node.js was not found. Install Node.js or add node.exe to PATH.'
}

$Node = Resolve-NodePath

function Format-ArgumentList {
    param([string[]]$Items)
    return ($Items | ForEach-Object {
        if ($_ -match '\s') { '"' + $_ + '"' } else { $_ }
    }) -join ' '
}

function Invoke-NodeTask {
    param(
        [string[]]$NodeArguments,
        [string]$LogName
    )

    $NodeArguments = @($NodeArguments)
    if (-not $NodeArguments -or $NodeArguments.Count -eq 0) {
        throw 'No Node script was specified.'
    }
    $scriptPath = Join-Path $Root $NodeArguments[0]
    if (-not (Test-Path -LiteralPath $scriptPath -PathType Leaf)) {
        throw "Node script not found: $scriptPath"
    }
    $NodeArguments[0] = $scriptPath

    $logPath = Join-Path $StateDir $LogName
    $display = Format-ArgumentList (@($Node) + $NodeArguments)
    Write-Host ''
    Write-Host ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $display)

    if ($DryRun) {
        Write-Host 'DRY RUN: command not executed.'
        $script:TaskExitCode = 0
        return
    }

    [IO.File]::AppendAllText($logPath, [Environment]::NewLine, $Utf8NoBom)
    [IO.File]::AppendAllText(
        $logPath,
        ('[' + (Get-Date).ToString('yyyy-MM-dd HH:mm:ss') + '] ' + $display + [Environment]::NewLine),
        $Utf8NoBom
    )

    & $Node @NodeArguments 2>&1 | ForEach-Object {
        $line = [string]$_
        Write-Host $line
        [IO.File]::AppendAllText($logPath, $line + [Environment]::NewLine, $Utf8NoBom)
    }
    $script:TaskExitCode = $LASTEXITCODE
    if ($null -eq $script:TaskExitCode) { $script:TaskExitCode = 0 }
}

function Resolve-ListPath {
    param(
        [string]$RelativePath,
        [bool]$AllowPrompt = $true
    )

    $candidate = Join-Path $Root $RelativePath
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
    }

    Write-Host ''
    Write-Host "[!] List file not found: $candidate"
    $available = @(Get-ChildItem -LiteralPath $DataDir -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)
    if ($available.Count -gt 0) {
        Write-Host 'Available JSON lists:'
        for ($i = 0; $i -lt $available.Count; $i++) {
            Write-Host ('  {0}. {1}' -f ($i + 1), $available[$i].Name)
        }
    }

    if ($DryRun -or -not $AllowPrompt -or -not [Environment]::UserInteractive) {
        throw "List file is missing: $RelativePath"
    }

    $answer = (Read-Host 'Enter a list path or number (empty cancels)').Trim()
    if (-not $answer) { throw 'No list selected.' }

    $choice = 0
    if ([int]::TryParse($answer, [ref]$choice) -and $choice -ge 1 -and $choice -le $available.Count) {
        return $available[$choice - 1].FullName
    }

    $selected = if ([IO.Path]::IsPathRooted($answer)) {
        $answer
    } else {
        Join-Path $Root $answer
    }
    if (-not (Test-Path -LiteralPath $selected -PathType Leaf)) {
        throw "List file does not exist: $selected"
    }
    return (Resolve-Path -LiteralPath $selected).Path
}

# ---------------------------------------------------------------------------
# Batch task catalog
#
# Adding a new download batch = adding one entry here. No switch-case edit.
#
#   Script          node script to run
#   Subcommand      'download' / 'login' prefix; empty for mdpi.mjs (no subcommands)
#   List / OutDir   relative paths under the project root
#   Options         extra download flags
#   LoginOptions    extra flags for the login run
#   Log             log file name under state\
#   Relogin         run the login flow when the download exits with code 10
#   SkipAware       supports --retry-no-access (scidir only)
# ---------------------------------------------------------------------------

$BatchTasks = @{
    'mdpi' = @{
        Label        = 'MDPI (open access)'
        Script       = 'scripts\mdpi.mjs'
        Subcommand   = ''
        List         = 'data\manifests\newlist21_papers.json'
        OutDir       = 'downloads_mdpi'
        Options      = @('--delay', '1200')
        LoginOptions = @()
        Log          = 'mdpi_out.log'
        Relogin      = $false
        SkipAware    = $false
    }
    'scidir-webvpn' = @{
        Label        = 'SciDir / WebVPN'
        Script       = 'scripts\scidir.mjs'
        Subcommand   = 'download'
        List         = 'data\manifests\newlist3_sd.json'
        OutDir       = 'downloads_scidir'
        Options      = @('--visible', '--size', '800,600', '--rotate', '9', '--delay', '2500')
        LoginOptions = @('--size', '800,600')
        Log          = 'scidir_out.log'
        Relogin      = $true
        SkipAware    = $true
    }
    'scidir-carsi' = @{
        Label        = 'SciDir / CARSI direct'
        Script       = 'scripts\scidir.mjs'
        Subcommand   = 'download'
        List         = 'data\manifests\newlist3_sd.json'
        OutDir       = 'downloads_scidir'
        Options      = @('--direct', '--rotate', '0', '--delay', '3000')
        LoginOptions = @('--direct')
        Log          = 'scidir_out.log'
        Relogin      = $true
        SkipAware    = $true
    }
    'wiley' = @{
        Label        = 'Wiley batch 1 (list.txt)'
        Script       = 'scripts\wiley.mjs'
        Subcommand   = 'download'
        List         = 'data\manifests\wiley_papers.json'
        OutDir       = 'downloads_wiley'
        Options      = @('--delay', '10000')
        LoginOptions = @()
        Log          = 'wiley_out.log'
        Relogin      = $true
        SkipAware    = $false
    }
    'wiley-advanced' = @{
        Label        = 'Wiley Advanced (list2)'
        Script       = 'scripts\wiley.mjs'
        Subcommand   = 'download'
        List         = 'data\manifests\list2_papers.json'
        OutDir       = 'downloads_wiley2'
        Options      = @('--delay', '10000')
        LoginOptions = @()
        Log          = 'wiley_out.log'
        Relogin      = $true
        SkipAware    = $false
    }
}

function Invoke-BatchTask {
    param([hashtable]$Spec)

    $listPath = Resolve-ListPath -RelativePath $Spec.List -AllowPrompt $true
    $outputDir = Join-Path $DownloadRoot $Spec.OutDir
    if (-not $DryRun -and -not (Test-Path -LiteralPath $outputDir)) {
        New-Item -ItemType Directory -Path $outputDir | Out-Null
    }

    $downloadArgs = @($Spec.Script)
    if ($Spec.Subcommand) { $downloadArgs += $Spec.Subcommand }
    $downloadArgs += @($Spec.Options)
    $downloadArgs += @('--list', $listPath, '--outdir', $outputDir)
    if ($Max -gt 0) { $downloadArgs += @('--max', [string]$Max) }
    if ($Only.Count -gt 0) { $downloadArgs += @('--only', ($Only -join ',')) }
    if ($RetryNoAccess -and $Spec.SkipAware) { $downloadArgs += '--retry-no-access' }

    $relogins = 0
    while ($true) {
        Invoke-NodeTask -NodeArguments $downloadArgs -LogName $Spec.Log
        if ($script:TaskExitCode -eq 0) { return }
        if ($script:TaskExitCode -ne 10 -or -not $Spec.Relogin) { return }

        if ($relogins -ge 3) {
            Write-Host '[!] Login retry limit reached.'
            $script:TaskExitCode = 10
            return
        }

        $relogins++
        Write-Host ''
        Write-Host 'Session expired. A visible login window will be opened.'
        $loginArgs = @($Spec.Script, 'login') + @($Spec.LoginOptions)
        Invoke-NodeTask -NodeArguments $loginArgs -LogName $Spec.Log
        if ($script:TaskExitCode -ne 0) { return }
    }
}

function Select-WatchdogMode {
    if ($Mode) { return $Mode }
    if ($DryRun) { return 'webvpn' }

    Write-Host ''
    Write-Host 'Watchdog target:'
    Write-Host '  1. SciDir WebVPN'
    Write-Host '  2. SciDir CARSI'
    Write-Host '  3. Wiley Advanced'
    while ($true) {
        $answer = (Read-Host 'Select 1-3').Trim()
        switch ($answer) {
            '1' { return 'webvpn' }
            '2' { return 'carsi' }
            '3' { return 'wiley' }
            default { Write-Host 'Invalid selection.' }
        }
    }
}

function Select-TaskFromMenu {
    $menu = @(
        @{ Task = 'scidir-webvpn';  Label = 'SciDir download     (WebVPN, main batch)' },
        @{ Task = 'scidir-carsi';   Label = 'SciDir download     (CARSI direct)' },
        @{ Task = 'wiley-advanced';  Label = 'Wiley Advanced      (list2 papers)' },
        @{ Task = 'wiley';           Label = 'Wiley batch 1       (list.txt)' },
        @{ Task = 'mdpi';            Label = 'MDPI                (open access)' },
        @{ Task = 'progress';        Label = 'Progress / ETA      (read-only)' },
        @{ Task = 'watchdog';        Label = 'Watchdog            (auto restart on block)' },
        @{ Task = 'elsevier-check';  Label = 'Check Elsevier API  (3 seconds)' },
        @{ Task = 'scidir-api';      Label = 'Elsevier official API' }
    )

    Write-Host ''
    Write-Host 'What do you want to run?'
    for ($i = 0; $i -lt $menu.Count; $i++) {
        Write-Host ('  {0}. {1}' -f ($i + 1), $menu[$i].Label)
    }
    Write-Host ('  {0}. Exit' -f ($menu.Count + 1))

    while ($true) {
        $answer = (Read-Host 'Select').Trim()
        $choice = 0
        if ([int]::TryParse($answer, [ref]$choice)) {
            if ($choice -ge 1 -and $choice -le $menu.Count) { return $menu[$choice - 1].Task }
            if ($choice -eq $menu.Count + 1) { return 'exit' }
        }
        Write-Host 'Invalid selection.'
    }
}

function Show-CaptchaUsage {
    Write-Host 'Usage: webvpn-captcha.cmd [profile] [captcha|autofill|env-login]'
    Write-Host 'Profiles: human, human_slow, human_fast, linear, ease, jitter, stepped'
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

if ($Task -eq 'menu') {
    $Task = Select-TaskFromMenu
    if ($Task -eq 'exit') { exit 0 }
}

Write-Host '================================================================'
Write-Host " Paper Snacher entry: $Task"
Write-Host " Root: $Root"
Write-Host " Node: $Node"
if ($DryRun) { Write-Host ' Mode: dry-run' }
Write-Host '================================================================'

try {
    if ($BatchTasks.ContainsKey($Task)) {
        Invoke-BatchTask -Spec $BatchTasks[$Task]
    }
    else {
        switch ($Task) {
            'scidir-api' {
                $list = Resolve-ListPath -RelativePath 'data\manifests\newlist3_sd.json' -AllowPrompt $true
                $out = Join-Path $DownloadRoot 'downloads_api'
                if (-not $DryRun -and -not (Test-Path -LiteralPath $out)) {
                    New-Item -ItemType Directory -Path $out | Out-Null
                }

                Write-Host '[1/2] API dry-run (2 articles)'
                Invoke-NodeTask -LogName 'scidir_api_out.log' -NodeArguments @(
                    'scripts\scidir.mjs', 'api',
                    '--list', $list,
                    '--outdir', $out,
                    '--via', 'direct',
                    '--max', '2',
                    '--dry-run',
                    '--fail-on-error'
                )
                if ($script:TaskExitCode -ne 0) { break }

                Write-Host '[2/2] API full run'
                $fullArgs = @(
                    'scripts\scidir.mjs', 'api',
                    '--list', $list,
                    '--outdir', $out,
                    '--via', 'direct',
                    '--conc', '4',
                    '--fail-on-error'
                )
                if ($Max -gt 0) { $fullArgs += @('--max', [string]$Max) }
                Invoke-NodeTask -LogName 'scidir_api_out.log' -NodeArguments $fullArgs
            }

            'elsevier-check' {
                Invoke-NodeTask -LogName 'elsevier_check_out.log' -NodeArguments @('scripts\elscheck.mjs')
            }

            'progress' {
                $progressArgs = @('scripts\progress.mjs')
                if ($Watch) { $progressArgs += @('--watch', '30') }
                Invoke-NodeTask -LogName 'progress_out.log' -NodeArguments $progressArgs
            }

            'watchdog' {
                $watchMode = Select-WatchdogMode
                Invoke-NodeTask -LogName 'watchdog_out.log' -NodeArguments @(
                    'scripts\watchdog.mjs',
                    '--mode', $watchMode,
                    '--interval', '10',
                    '--stall-min', '10',
                    '--fail-streak', '5',
                    '--restart',
                    '--block-restart',
                    '--block-trigger', '1',
                    '--block-cooldown', '0'
                )
            }

            'captcha-test' {
                $profile = if ($CaptchaProfile) { $CaptchaProfile.Trim().ToLowerInvariant() } else { 'human' }
                $captchaMode = $CaptchaMode.Trim().ToLowerInvariant()
                if ($profile -in @('help', '--help', '/?') -or $captchaMode -in @('help', '--help', '/?')) {
                    Show-CaptchaUsage
                    exit 0
                }

                $profiles = @('human', 'human_slow', 'human_fast', 'linear', 'ease', 'jitter', 'stepped')
                if ($profile -notin $profiles) { throw "Unknown captcha profile: $profile" }

                if (-not $captchaMode) {
                    if ($DryRun) {
                        $captchaMode = 'captcha'
                    } else {
                        Write-Host ''
                        Write-Host 'Captcha test mode:'
                        Write-Host '  1. Captcha only'
                        Write-Host '  2. Captcha + browser autofill + login'
                        Write-Host '  3. Captcha + environment credentials + login'
                        $selection = (Read-Host 'Select 1-3').Trim()
                        $captchaMode = switch ($selection) {
                            '1' { 'captcha' }
                            '2' { 'autofill' }
                            '3' { 'env-login' }
                            default { '' }
                        }
                        if (-not $captchaMode) { throw 'Invalid captcha test mode.' }
                    }
                }

                if ($captchaMode -notin @('captcha', 'autofill', 'env-login')) {
                    throw "Unknown captcha test mode: $captchaMode"
                }

                $captchaArgs = @(
                    'scripts\webvpn-captcha-risk-test.mjs',
                    '--run',
                    '--profile', $profile,
                    '--hold-ms', '5000'
                )

                if ($captchaMode -eq 'autofill') {
                    $autofillProfile = Join-Path $Root '.browser_profile_scidir'
                    $loginData = Join-Path $autofillProfile 'Default\Login Data'
                    if (-not (Test-Path -LiteralPath $loginData -PathType Leaf)) {
                        throw "Autofill profile not found: $autofillProfile"
                    }
                    $env:WEBVPN_CAPTCHA_TEST_AUTHORIZED = '1'
                    $env:WEBVPN_CAPTCHA_TEST_CONFIRM = '1'
                    $captchaArgs += @('--browser-autofill', '--autofill-profile', $autofillProfile)
                }
                elseif ($captchaMode -eq 'env-login') {
                    if (-not $env:WEBVPN_CAPTCHA_TEST_USERNAME -or -not $env:WEBVPN_CAPTCHA_TEST_PASSWORD) {
                        throw 'Set WEBVPN_CAPTCHA_TEST_USERNAME and WEBVPN_CAPTCHA_TEST_PASSWORD first.'
                    }
                    $env:WEBVPN_CAPTCHA_TEST_AUTHORIZED = '1'
                    $env:WEBVPN_CAPTCHA_TEST_CONFIRM = '1'
                    $captchaArgs += '--login'
                }
                else {
                    $env:WEBVPN_CAPTCHA_TEST_AUTHORIZED = '1'
                }

                Invoke-NodeTask -LogName 'captcha_test_out.log' -NodeArguments $captchaArgs
            }

            default { throw "Unknown task: $Task" }
        }
    }
}
catch {
    Write-Host ''
    Write-Host ('ERROR: ' + $_.Exception.Message)
    $script:TaskExitCode = 2
}

Write-Host ''
if ($script:TaskExitCode -eq 0) {
    Write-Host 'Task completed.'
} else {
    Write-Host ("Task exited with code $script:TaskExitCode.")
}
exit $script:TaskExitCode
