$ErrorActionPreference = 'SilentlyContinue'
$lockPath = Join-Path ([IO.Path]::GetTempPath()) 'agent-flow-hosted-bridge.lock'
if (-not (Test-Path -LiteralPath $lockPath)) {
  Write-Host 'El puente no está conectado.'
  exit 0
}
$pidText = (Get-Content -LiteralPath $lockPath -Raw).Trim()
if ($pidText -match '^\d+$') {
  Stop-Process -Id ([int]$pidText) -ErrorAction SilentlyContinue
}
Remove-Item -LiteralPath $lockPath -Force -ErrorAction SilentlyContinue
Write-Host 'Puente desconectado.'

