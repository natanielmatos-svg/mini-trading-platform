param([ValidateRange(1024,65535)][int]$Port = 3000)
$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$serverPath = Join-Path $projectRoot 'server.js'
$nodePath = (Get-Command node -ErrorAction Stop).Source
if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  throw "El puerto $Port ya tiene un servidor. No se ha detenido ni sustituido ese proceso."
}
$logDir = Join-Path $projectRoot 'datos\logs'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$runStamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$previousEnv = @{}
foreach ($name in @('NODE_ENV','DEMO','PORT','HOST')) { $previousEnv[$name] = [Environment]::GetEnvironmentVariable($name,'Process') }
try {
  $env:NODE_ENV = 'production'
  $env:DEMO = '0'
  $env:PORT = "$Port"
  $env:HOST = '127.0.0.1'
  $platformProcess = Start-Process -FilePath $nodePath -ArgumentList @('"' + $serverPath + '"') -WorkingDirectory $projectRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir "$runStamp.out.log") -RedirectStandardError (Join-Path $logDir "$runStamp.err.log")
} finally {
  foreach ($name in $previousEnv.Keys) { [Environment]::SetEnvironmentVariable($name,$previousEnv[$name],'Process') }
}
for ($attempt=0; $attempt -lt 20; $attempt++) {
  if ($platformProcess.HasExited) { throw "El servidor se detuvo. Revisa los registros de $logDir." }
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/healthz" -TimeoutSec 2
    if ($health.ok -and !$health.demo) {
      [PSCustomObject]@{ url="http://localhost:$Port"; pid=$platformProcess.Id; mode='production'; scope='solo este equipo'; logs=$logDir } | ConvertTo-Json
      exit 0
    }
  } catch { }
  Start-Sleep -Milliseconds 500
}
throw "El proceso arrancó, pero no confirmó su estado. Revisa los registros de $logDir."
