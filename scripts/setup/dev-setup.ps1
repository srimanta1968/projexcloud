#requires -Version 5.1
<#
.SYNOPSIS
  One-shot developer environment bootstrap for ProjexCloud (Windows / PowerShell).

.DESCRIPTION
  Replaces the old dev container. Brings a clean checkout to a runnable state:
    1. Verifies prerequisites (Node 20+, Docker, corepack/pnpm).
    2. Creates .env from .env.example if missing.
    3. Starts the Postgres container (docker compose up -d postgres).
    4. Installs workspace deps (pnpm install) and builds (pnpm -w build).
    5. Optionally starts the api-gateway and seeds baseline data.

  The api-gateway auto-runs every SDK migration on first boot, so there is no
  manual SQL step. See docs/setup/dev-environment.md for the full guide.

.PARAMETER SkipBuild
  Skip 'pnpm -w build' (faster re-runs once dist/ exists).

.PARAMETER Seed
  After build, start the gateway in the background and run the dev-data seeder.

.EXAMPLE
  ./scripts/setup/dev-setup.ps1
.EXAMPLE
  ./scripts/setup/dev-setup.ps1 -Seed
#>
param(
  [switch]$SkipBuild,
  [switch]$Seed,
  [switch]$Full
)
$ErrorActionPreference = 'Stop'
$RepoRoot = (Resolve-Path "$PSScriptRoot/../..").Path
Set-Location $RepoRoot
function Step($m) { Write-Host "`n=== $m ===" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  OK  $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  !   $m" -ForegroundColor Yellow }
function Set-EnvKey($k, $v) {  # idempotently set KEY=VALUE in repo-root .env
  if (-not (Test-Path "$RepoRoot/.env")) { return }
  $lines = Get-Content "$RepoRoot/.env" | Where-Object { $_ -notmatch "^$k=" }
  ($lines + "$k=$v") | Set-Content "$RepoRoot/.env"
}

Step 'Checking prerequisites'
$node = (node --version) 2>$null
if (-not $node) { throw 'Node.js not found. Install Node 20 LTS: https://nodejs.org' }
$major = [int]($node.TrimStart('v').Split('.')[0])
if ($major -lt 20) { throw "Node $node found; ProjexCloud requires Node 20+." }
Ok "Node $node"
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) {
  throw 'Docker not found. Install Docker Desktop and ensure it is running.'
}
try { docker info *> $null; Ok 'Docker is running' }
catch { throw 'Docker is installed but not running. Start Docker Desktop and re-run.' }
# corepack's pnpm shim write needs admin on Windows (benign EPERM); pnpm still
# resolves, so swallow output and continue.
corepack enable *> $null 2>&1
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  throw 'pnpm not available even after corepack enable. Run: npm i -g pnpm@9'
}
Ok "pnpm $(pnpm --version)"

Step 'Environment file (.env)'
if (-not (Test-Path "$RepoRoot/.env")) {
  Copy-Item "$RepoRoot/.env.example" "$RepoRoot/.env"
  Ok 'Created .env from .env.example'
  # Generate a dev ADMIN_OPS_TOKEN so /admin endpoints + seeding work.
  # (48 hex chars; works on both PowerShell 5.1 and 7.)
  $tok = -join (1..48 | ForEach-Object { '0123456789abcdef'[(Get-Random -Maximum 16)] })
  Add-Content "$RepoRoot/.env" "`nADMIN_OPS_TOKEN=$tok"
  # Kafka off for a lean local stack (gateway uses its in-process emitter).
  Add-Content "$RepoRoot/.env" 'KAFKA_ENABLED=false'
  Ok 'Added dev ADMIN_OPS_TOKEN and KAFKA_ENABLED=false'
} else {
  Warn '.env already exists — leaving it untouched'
}

Step 'Starting Postgres (docker compose)'
$dbPort = (Select-String -Path "$RepoRoot/.env" -Pattern '^DB_PORT=(.*)$').Matches.Groups[1].Value
if (-not $dbPort) { $dbPort = '5432' }
$pgUp = $false
try { $pgUp = (Test-NetConnection -ComputerName localhost -Port ([int]$dbPort) -WarningAction SilentlyContinue).TcpTestSucceeded } catch {}
if ($pgUp) {
  Warn "Postgres already reachable on :$dbPort - using it, skipping 'docker compose up -d postgres'"
} else {
  docker compose up -d postgres
  docker compose ps postgres
  Ok 'Postgres container started (data persists in the postgres_data volume)'
}

Step 'Ensuring required Postgres extensions (pgvector + PostGIS)'
# The gateway aborts on boot if pgvector/PostGIS are missing. Auto-install them;
# this throws (and aborts setup) if it cannot, so we never boot a doomed gateway.
& "$PSScriptRoot/ensure-pg-extensions.ps1" -DbPort ([int]$dbPort)
Ok 'pgvector + PostGIS available'

Step 'Starting infra containers (Redis; + Kafka/ClickHouse with -Full)'
# `pnpm dev` runs every service as a Node process. Redis is needed by the
# gateway cache and identity-projector; Kafka + ClickHouse by the meter-collector.
docker compose up -d redis
Set-EnvKey 'REDIS_ENABLED' 'true'
Ok 'Redis up (REDIS_ENABLED=true)'
if ($Full) {
  docker compose --profile full up -d kafka clickhouse
  Set-EnvKey 'KAFKA_ENABLED' 'true'
  Set-EnvKey 'CLICKHOUSE_ENABLED' 'true'
  Ok 'Kafka + ClickHouse up (KAFKA_ENABLED=true, CLICKHOUSE_ENABLED=true)'
} else {
  # No Kafka/ClickHouse containers: make meter-collector degrade cleanly
  # (in-process buffer + Postgres ledger). Both default-ON in that worker.
  Set-EnvKey 'KAFKA_ENABLED' 'false'
  Set-EnvKey 'CLICKHOUSE_ENABLED' 'false'
  Warn 'Kafka/ClickHouse not started (KAFKA_ENABLED=false, CLICKHOUSE_ENABLED=false).'
  Warn 'meter-collector falls back to the Postgres usage ledger. Re-run with -Full for the OLAP tier.'
}

Step 'Installing workspace dependencies (pnpm install)'
pnpm install
Ok 'Dependencies installed'

if (-not $SkipBuild) {
  Step 'Building the workspace (pnpm -w build)'
  pnpm -w build
  Ok 'Build complete'
} else {
  Warn 'Skipping build (-SkipBuild)'
}

$gwPort = (Select-String -Path "$RepoRoot/.env" -Pattern '^PORT=(.*)$').Matches.Groups[1].Value
if (-not $gwPort) { $gwPort = '3000' }
$gwUrl = "http://localhost:$gwPort"
if ($Seed) {
  Step 'Starting api-gateway (background) + seeding'
  $gw = Start-Process pnpm -ArgumentList '--filter','@projexlight/api-gateway','dev' -PassThru -WindowStyle Hidden
  Ok "api-gateway started (PID $($gw.Id)) on $gwUrl; migrations run on boot"
  node "$RepoRoot/scripts/setup/seed-dev-data.mjs" --gateway $gwUrl
  Warn "Gateway is still running in the background (PID $($gw.Id)). Stop with: Stop-Process -Id $($gw.Id)"
} else {
  Step 'Next steps'
  Write-Host @"
  Start the API gateway (runs migrations on boot):
      pnpm --filter @projexlight/api-gateway dev
  Then in a second terminal, seed baseline data:
      node scripts/setup/seed-dev-data.mjs --gateway $gwUrl
  Health check:
      curl $gwUrl/health
  Admin portals (optional):
      pnpm --filter @projexlight/projexcloud-admin dev   # http://localhost:3100
      pnpm --filter @projexlight/tenant-admin dev        # http://localhost:3200
"@
}
Write-Host "`nDev environment ready." -ForegroundColor Green
