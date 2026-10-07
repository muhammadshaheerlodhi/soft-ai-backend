# Applies the Soft AI migrations to the LOCAL Supabase database and runs the tests.
# Local only: it talks to the Docker container "supabase_db_softai-localdev".
# Start it first:  cd D:\Softoras_AI_Assistant\local-dev ; npx supabase start
# (The ERP migrations were applied one by one from local-dev\erp-migrations,
#  because the ERP repo has duplicate migration numbers 013, 016 and 017.)

$ErrorActionPreference = 'Stop'
$container = 'supabase_db_softai-localdev'
$root = Split-Path -Parent $PSScriptRoot

if (-not (docker ps --format '{{.Names}}' | Where-Object { $_ -eq $container })) {
  throw "Local database container '$container' is not running. Start local Supabase first."
}

foreach ($f in Get-ChildItem "$root\db\migrations" -Filter *.sql | Sort-Object Name) {
  Get-Content $f.FullName -Raw | docker exec -i $container psql -U postgres -d postgres -v ON_ERROR_STOP=1 -1 -q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Migration failed: $($f.Name)" }
  Write-Host "applied  $($f.Name)"
}

# psql prints PASS lines as NOTICEs on stderr; Windows PowerShell treats stderr
# as errors under 'Stop', so relax it while the tests run.
$ErrorActionPreference = 'Continue'
$out = Get-Content "$root\db\tests\100_soft_ai_db_test.sql" -Raw |
  docker exec -i $container psql -U postgres -d postgres -q 2>&1
$testExit = $LASTEXITCODE
$out | ForEach-Object { "$_" -replace '^.*NOTICE:\s*', '' } |
  Where-Object { $_ -match 'PASS|FAIL|ERROR' } | ForEach-Object { Write-Host $_ }

if ($testExit -ne 0) { throw "Tests FAILED (see above)." }
Write-Host "`nDone."
