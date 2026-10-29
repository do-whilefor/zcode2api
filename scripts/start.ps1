$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$binaryPath = Join-Path $projectRoot 'bin/zcode2api.exe'
$dataPath = if ($env:ZCODE2API_DATA_DIR) { [IO.Path]::GetFullPath($env:ZCODE2API_DATA_DIR) } else { Join-Path $projectRoot 'data' }
$portsFile = Join-Path $dataPath 'ports.json'
if (Test-Path -LiteralPath $portsFile) {
    $info = Get-Content -LiteralPath $portsFile -Raw | ConvertFrom-Json
    $existing = Get-CimInstance Win32_Process -Filter "ProcessId = $($info.pid)" -ErrorAction SilentlyContinue
    if ($existing -and $existing.ExecutablePath -eq $binaryPath) {
        Write-Output "Already running (Go): PID $($info.pid), gateway $($info.gateway_port)"
        exit 0
    }
}
New-Item -ItemType Directory -Path $dataPath -Force | Out-Null
New-Item -ItemType Directory -Path (Split-Path -Parent $binaryPath) -Force | Out-Null
$goPath = (Get-Command go -ErrorAction Stop).Source
Push-Location -LiteralPath $projectRoot
try {
    & $goPath build -trimpath -o $binaryPath .
    if ($LASTEXITCODE -ne 0) { throw 'Go build failed.' }
} finally { Pop-Location }
$serviceProcess = Start-Process -FilePath $binaryPath -ArgumentList ('--root "' + $projectRoot + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $dataPath 'service.stdout.log') -RedirectStandardError (Join-Path $dataPath 'service.stderr.log')
for ($attempt = 0; $attempt -lt 75; $attempt++) {
    Start-Sleep -Milliseconds 200
    $serviceProcess.Refresh()
    if ($serviceProcess.HasExited) { throw 'Startup failed; see data/service.stderr.log' }
    if (Test-Path -LiteralPath $portsFile) {
        try { $info = Get-Content -LiteralPath $portsFile -Raw | ConvertFrom-Json } catch { continue }
        if ($info.pid -eq $serviceProcess.Id) {
            Write-Output "Web: http://127.0.0.1:$($info.web_port)"
            Write-Output "Gateway: http://127.0.0.1:$($info.gateway_port)/v1"
            exit 0
        }
    }
}
throw 'Startup is still pending; inspect data/service.stdout.log'
