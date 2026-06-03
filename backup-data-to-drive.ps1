# FloorPro CRM - Supabase Data Backup Script
# Fetches every table from Supabase and saves a timestamped JSON snapshot
# to Google Drive. Keeps the 30 most recent data backups.
#
# Tables backed up:
#   leads           - lead pipeline
#   jobs            - jobs board
#   materials       - materials price list
#   crew            - crew members
#   pto_blocks      - approved PTO days
#   scheduled_slots - all crew schedule slots
#   settings        - KV store: job_records (daily logs + costing), slot_job_map,
#                     pto_requests, material_requests, sales_visits, todos,
#                     custom_job_types, holidays, PINs, and more

$SUPABASE_URL = 'https://cngbsmmdfxmerlqnkate.supabase.co'
$SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNuZ2JzbW1kZnhtZXJscW5rYXRlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg3NzcxNTEsImV4cCI6MjA5NDM1MzE1MX0.WYzlfn8OHPYsWCY-P7bXjvl_v78wozwjk2ajEBxa-7I'
$destDir = 'G:\My Drive\FloorPro CRM Backups'
$keep    = 30

$headers = @{
    'apikey'        = $SUPABASE_KEY
    'Authorization' = 'Bearer ' + $SUPABASE_KEY
    'Content-Type'  = 'application/json'
    'Accept'        = 'application/json'
}

Write-Output 'FloorPro CRM - Supabase Data Backup'
Write-Output '======================================'

$tables    = @('leads','jobs','materials','crew','pto_blocks','scheduled_slots','settings')
$totalRows = 0
$errors    = @()

$backup = [ordered]@{
    backup_date = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
    backup_type = 'supabase_full'
    version     = '1.0'
    tables      = [ordered]@{}
}

foreach ($table in $tables) {
    $url = $SUPABASE_URL + '/rest/v1/' + $table + '?select=*&limit=10000'
    try {
        $response = Invoke-RestMethod -Uri $url -Headers $headers -Method Get -ErrorAction Stop
        if ($response -is [Array]) { $rows = $response } else { $rows = @($response) }
        $backup.tables[$table] = $rows
        $totalRows += $rows.Count
        Write-Output ('  OK  ' + $table + ' : ' + $rows.Count + ' rows')
    } catch {
        $msg = 'Failed to fetch ' + $table + ': ' + $_.Exception.Message
        Write-Warning ('  ERR ' + $msg)
        $errors += $msg
        $backup.tables[$table] = @()
    }
}

if ($errors.Count -gt 0) { $backup['errors'] = $errors }

# Save JSON to Google Drive
if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

$stamp    = Get-Date -Format 'yyyy-MM-dd HH-mm-ss'
$destFile = Join-Path $destDir ('FloorPro Data - ' + $stamp + '.json')

$backup | ConvertTo-Json -Depth 50 | Out-File -FilePath $destFile -Encoding utf8 -Force

$sizeKB = [Math]::Round((Get-Item $destFile).Length / 1KB, 1)
Write-Output ''
Write-Output ('Saved: ' + $destFile)
Write-Output ('Size: ' + $sizeKB + ' KB    Rows: ' + $totalRows + '    Tables: ' + $tables.Count)

# Prune - keep only the $keep most recent data backups
$allData = Get-ChildItem -Path $destDir -Filter 'FloorPro Data - *.json' |
           Sort-Object LastWriteTime -Descending
if ($allData.Count -gt $keep) {
    $allData | Select-Object -Skip $keep | ForEach-Object {
        Remove-Item $_.FullName -Force
        Write-Output ('Pruned: ' + $_.Name)
    }
}

if ($errors.Count -gt 0) {
    Write-Warning ('Completed with ' + $errors.Count + ' error(s) - see above.')
    exit 1
}
Write-Output 'Done.'
