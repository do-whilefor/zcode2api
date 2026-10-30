param([Parameter(Mandatory = $true)][string]$BinaryPath)

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$builtBinary = (Resolve-Path -LiteralPath $BinaryPath).Path
$shellPath = (Get-Process -Id $PID).Path
$tempBase = [IO.Path]::GetTempPath().TrimEnd([IO.Path]::DirectorySeparatorChar)
$smokeRoot = Join-Path $tempBase ('zcode2api-startup-' + [guid]::NewGuid().ToString('N'))
$packageRoot = Join-Path $smokeRoot 'Windows release with spaces'
$trackedProcesses = @{}
$savedEnvironment = @{}
foreach ($name in @('PATH', 'ZCODE2API_DATA_DIR', 'ZCODE2API_WEB_PORT', 'ZCODE2API_GATEWAY_PORT', 'ZCODE2API_HOST', 'ZCODE2API_ADMIN_PASSWORD')) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Invoke-StartupScript([string]$ScriptPath) {
    $logPrefix = Join-Path $smokeRoot ([guid]::NewGuid().ToString('N'))
    $child = Start-Process -FilePath $shellPath -ArgumentList ('-NoProfile -File "' + $ScriptPath + '"') -WindowStyle Hidden -PassThru -RedirectStandardOutput ($logPrefix + '.stdout') -RedirectStandardError ($logPrefix + '.stderr')
    # Retain the handle so Windows PowerShell 5.1 can read ExitCode after exit.
    $childHandle = $child.Handle
    # Wait only for the script, not its intentionally persistent service child.
    if (!$child.WaitForExit(60000)) {
        Stop-Process -Id $child.Id -Force
        throw "Script timed out: $ScriptPath"
    }
    if ($child.ExitCode -ne 0) {
        $details = Get-Content -LiteralPath ($logPrefix + '.stdout'), ($logPrefix + '.stderr') -Raw
        throw "Script failed: $ScriptPath`n$details"
    }
}

function Invoke-StartupCase([string]$Root, [string]$DataSetting, [string]$ExpectedData, [switch]$WithoutGo) {
    if ($WithoutGo) {
        $env:PATH = "$env:SystemRoot\System32;$env:SystemRoot"
        if (Get-Command go -ErrorAction SilentlyContinue) { throw 'Go must be unavailable for the packaged startup test.' }
    } else { $env:PATH = $savedEnvironment['PATH'] }
    $env:ZCODE2API_DATA_DIR = $DataSetting
    $startScript = Join-Path $Root 'scripts/start.ps1'
    $stopScript = Join-Path $Root 'scripts/stop.ps1'
    $portsFile = Join-Path $ExpectedData 'ports.json'
    $expectedBinary = if (Test-Path -LiteralPath (Join-Path $Root 'go.mod')) { Join-Path $Root 'bin/zcode2api.exe' } else { Join-Path $Root 'zcode2api.exe' }
    try { Invoke-StartupScript $startScript }
    finally {
        if (Test-Path -LiteralPath $portsFile) {
            $ports = Get-Content -LiteralPath $portsFile -Raw | ConvertFrom-Json
            $trackedProcesses[[int]$ports.pid] = $expectedBinary
        }
    }
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$($ports.web_port)/healthz" -TimeoutSec 5
    if (!$health.ok) { throw 'Web health check failed.' }
    $assets = Invoke-WebRequest -Uri "http://127.0.0.1:$($ports.web_port)/claims-view.js" -UseBasicParsing -TimeoutSec 5
    if ($assets.StatusCode -ne 200 -or !$assets.Content.Contains('function claimablePlans')) { throw 'Embedded Web assets are missing.' }
    if (!(Test-Path -LiteralPath (Join-Path $ExpectedData 'admin-password.txt'))) { throw 'Initial password was not created.' }
    Invoke-StartupScript $startScript
    $again = Get-Content -LiteralPath $portsFile -Raw | ConvertFrom-Json
    if ($again.pid -ne $ports.pid) { throw 'Repeated startup created a duplicate service.' }
    Invoke-StartupScript $stopScript
    for ($attempt = 0; $attempt -lt 50; $attempt++) {
        if (!(Get-Process -Id $ports.pid -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 100
    }
    if (Get-Process -Id $ports.pid -ErrorAction SilentlyContinue) { throw 'Service is still running after stop.' }
    $trackedProcesses.Remove([int]$ports.pid)
    Invoke-StartupScript $stopScript
    Write-Output "Passed startup/stop: $Root (data: $ExpectedData, without Go: $WithoutGo)"
}

try {
    New-Item -ItemType Directory -Path (Join-Path $packageRoot 'scripts') -Force | Out-Null
    Copy-Item -LiteralPath $builtBinary -Destination (Join-Path $packageRoot 'zcode2api.exe')
    foreach ($name in @('start.ps1', 'stop.ps1')) {
        Copy-Item -LiteralPath (Join-Path $projectRoot "scripts/$name") -Destination (Join-Path $packageRoot "scripts/$name")
    }
    $binaryVersion = & (Join-Path $packageRoot 'zcode2api.exe') --version
    if ($LASTEXITCODE -ne 0 -or $binaryVersion -notmatch '^zcode2api (dev|v\d+\.\d+\.\d+)$') { throw 'Binary version flag failed.' }
    $env:ZCODE2API_WEB_PORT = '0'
    $env:ZCODE2API_GATEWAY_PORT = '0'
    $env:ZCODE2API_HOST = '127.0.0.1'
    $env:ZCODE2API_ADMIN_PASSWORD = $null
    Push-Location -LiteralPath $smokeRoot
    try {
        Invoke-StartupCase -Root $projectRoot -DataSetting (Join-Path $smokeRoot 'source data') -ExpectedData (Join-Path $smokeRoot 'source data')
        Invoke-StartupCase -Root $packageRoot -DataSetting '' -ExpectedData (Join-Path $packageRoot 'data') -WithoutGo
        Invoke-StartupCase -Root $packageRoot -DataSetting 'relative data' -ExpectedData (Join-Path $packageRoot 'relative data') -WithoutGo
    } finally { Pop-Location }
} finally {
    foreach ($serviceId in @($trackedProcesses.Keys)) {
        $service = Get-Process -Id $serviceId -ErrorAction SilentlyContinue
        if ($service -and $service.Path -eq $trackedProcesses[$serviceId]) {
            Stop-Process -Id $serviceId -Force
            Wait-Process -Id $serviceId -Timeout 10 -ErrorAction SilentlyContinue
        }
    }
    foreach ($name in $savedEnvironment.Keys) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
    if (Test-Path -LiteralPath $smokeRoot) {
        $resolvedRoot = (Resolve-Path -LiteralPath $smokeRoot).Path
        if ((Split-Path -Parent $resolvedRoot) -ne $tempBase -or (Split-Path -Leaf $resolvedRoot) -notlike 'zcode2api-startup-*') { throw 'Refusing to remove a directory outside the startup test workspace.' }
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            try { Remove-Item -LiteralPath $resolvedRoot -Recurse -Force; break }
            catch {
                if ($attempt -eq 19) { throw }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
