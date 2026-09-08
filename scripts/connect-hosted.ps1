param(
  [string]$Workspace,
  [ValidateSet('auto', 'claude', 'codex')]
  [string]$Runtime = 'auto'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
if (-not $Workspace) { $Workspace = $repoRoot }
$remoteUrl = 'https://launcher.104-248-32-222.sslip.io/agent-flow/ingest'
$sshKey = if ($env:AGENT_FLOW_VPS_KEY) { $env:AGENT_FLOW_VPS_KEY } else { 'C:\Users\aday_\.ssh\id_ed25519_vps' }
$remoteTokenFile = '/home/discanary/apps/agent-flow-office/.relay.env'
$knownHosts = Join-Path ([IO.Path]::GetTempPath()) "agent-flow-vps-$PID-known_hosts"

if (-not (Test-Path -LiteralPath $sshKey)) {
  throw "No encuentro la clave SSH del VPS en $sshKey"
}

# Read the token over the already configured SSH trust. It is kept only in
# this PowerShell process environment and is never written or displayed.
$tokenLine = (& ssh -i $sshKey -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o "UserKnownHostsFile=$knownHosts" -o LogLevel=ERROR `
  discanary@104.248.32.222 "grep '^AGENT_FLOW_INGEST_TOKEN=' $remoteTokenFile" 2>$null)
if ($LASTEXITCODE -ne 0 -or -not $tokenLine) {
  throw 'No se pudo obtener el token seguro del relay del VPS.'
}
$token = ($tokenLine -join "`n") -replace '^AGENT_FLOW_INGEST_TOKEN=', ''
if (-not $token) { throw 'El token del relay del VPS está vacío.' }

$env:AGENT_FLOW_REMOTE_URL = $remoteUrl
$env:AGENT_FLOW_INGEST_TOKEN = $token
$env:AGENT_FLOW_RUNTIME = $Runtime
$env:AGENT_FLOW_WORKSPACE = $Workspace
$env:AGENT_FLOW_WATCH_ALL = '1'
$env:AGENT_FLOW_HOST_ID = if ($env:COMPUTERNAME) { $env:COMPUTERNAME } else { 'windows-local' }

Push-Location -LiteralPath $repoRoot
try {
  & pnpm run connect:hosted
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}
finally {
  Pop-Location
  Remove-Item -LiteralPath $knownHosts -Force -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_REMOTE_URL -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_INGEST_TOKEN -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_RUNTIME -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_WORKSPACE -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_WATCH_ALL -ErrorAction SilentlyContinue
  Remove-Item Env:AGENT_FLOW_HOST_ID -ErrorAction SilentlyContinue
}
