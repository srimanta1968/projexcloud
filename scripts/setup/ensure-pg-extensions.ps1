#requires -Version 5.1
<#
.SYNOPSIS
  Ensure the Postgres container behind the app has pgvector + PostGIS.
.DESCRIPTION
  ProjexCloud's api-gateway runs every SDK migration on boot and aborts if
  pgvector (sdk-agent-runtime) or PostGIS (sdk-geo) is unavailable. This script
  detects the running Postgres container publishing $DbPort, installs whichever
  extension is missing via the pgdg apt repo (version-matched), and THROWS if it
  cannot — so the caller stops before a doomed boot.
.PARAMETER Container
  Container name. Auto-detected from $DbPort when omitted.
.PARAMETER DbPort
  Host port the app connects to (default 5432).
.EXAMPLE
  ./scripts/setup/ensure-pg-extensions.ps1 -DbPort 5432
#>
param(
  [string]$Container = '',
  [int]$DbPort = 5432,
  [string]$DbUser = 'postgres'
)
$ErrorActionPreference = 'Stop'
function Note($m) { Write-Host "  [pg-ext] $m" }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { throw 'docker not found.' }

if (-not $Container) {
  $rows = docker ps --format '{{.Names}}|{{.Ports}}'
  foreach ($r in $rows) {
    $parts = $r -split '\|', 2
    if ($parts.Length -eq 2 -and $parts[1] -match (":$DbPort->")) { $Container = $parts[0]; break }
  }
}
if (-not $Container) { throw "No running Postgres container found publishing :$DbPort. Start Postgres first or pass -Container." }
Note "target container: $Container (port $DbPort)"

function PsqlC($sql) { (docker exec $Container psql -U $DbUser -d postgres -tAc $sql 2>$null) -join '' }

$verNum = (PsqlC 'SHOW server_version_num;').Trim()
if (-not $verNum) { throw "Could not query Postgres in '$Container' (ready? correct -DbUser?)." }
$pgMajor = [int]$verNum / 10000 -as [int]
$pgMajor = [math]::Floor([int]$verNum / 10000)
Note "Postgres major version: $pgMajor"

$pkgs = @{ 'vector' = "postgresql-$pgMajor-pgvector"; 'postgis' = "postgresql-$pgMajor-postgis-3" }
$installedAny = $false
foreach ($ext in @('vector','postgis')) {
  $have = (PsqlC "SELECT 1 FROM pg_available_extensions WHERE name='$ext';").Trim()
  if ($have) { Note "$ext: already available"; continue }
  $pkg = $pkgs[$ext]
  Note "$ext: NOT available - installing $pkg ..."
  docker exec $Container sh -c 'command -v apt-get >/dev/null' 2>$null
  if ($LASTEXITCODE -ne 0) { throw "'$Container' has no apt-get (non-Debian image). Use a Postgres image that bundles $ext." }
  docker exec $Container sh -c "apt-get update -qq && apt-get install -y -qq $pkg" 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed to install $pkg in '$Container' (network? wrong PG major?)." }
  $have2 = (PsqlC "SELECT 1 FROM pg_available_extensions WHERE name='$ext';").Trim()
  if (-not $have2) { throw "$pkg installed but '$ext' still not available." }
  Note "$ext: installed"
  $installedAny = $true
}
if ($installedAny) { Note 'extensions added - no restart needed (CREATE EXTENSION runs in migrations).' }
Note 'all required extensions present: vector postgis'
