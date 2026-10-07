# Rebuilds the LOCAL test database from scratch-safe steps. Local only.
#   1. ERP migrations, one by one (the ERP repo has duplicate numbers 013/016/017,
#      which the Supabase CLI refuses, so we apply them ourselves in name order)
#   2. Soft AI migrations 100+
#   3. Local-only login for the restricted backend role
# Usage:
#   powershell -ExecutionPolicy Bypass -File db\local\setup-local-db.ps1 -ErpMigrations D:\Softoras_AI_Assistant\local-dev\erp-migrations
# Skip step 1 on a database that already has the ERP tables: add -SkipErp

param(
  [string]$ErpMigrations = "D:\Softoras_AI_Assistant\local-dev\erp-migrations",
  [switch]$SkipErp
)

$ErrorActionPreference = 'Stop'
$container = 'supabase_db_softai-localdev'
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

if (-not (docker ps --format '{{.Names}}' | Where-Object { $_ -eq $container })) {
  throw "Local database container '$container' is not running. Run: cd D:\Softoras_AI_Assistant\local-dev; npx supabase start"
}

function Apply([string]$file) {
  Get-Content $file -Raw | docker exec -i $container psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Failed: $file" }
  Write-Host "applied  $(Split-Path -Leaf $file)"
}

if (-not $SkipErp) {
  Get-ChildItem $ErpMigrations -Filter *.sql | Sort-Object Name | ForEach-Object { Apply $_.FullName }
}
Get-ChildItem "$root\db\migrations" -Filter *.sql | Sort-Object Name | ForEach-Object { Apply $_.FullName }
Apply "$root\db\local\enable-local-service-login.sql"
Write-Host "`nLocal database ready."
