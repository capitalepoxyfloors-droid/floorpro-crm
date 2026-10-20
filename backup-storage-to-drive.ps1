# FloorPro CRM - Storage Bucket Backup Script
# Mirrors every file in the Supabase "vehicle-docs" Storage bucket (vehicle docs, product
# TDS/SDS sheets, job photos, sales visit scope photos, job-scope copies carried onto jobs,
# contract documents, etc. -- every photo/doc feature in the app reuses this one bucket) to
# Google Drive.
#
# One-way, additive mirror: a local file is never overwritten or deleted once backed up, so
# a photo removed (accidentally or otherwise) from Supabase stays recoverable here. Runs
# nightly via its own Scheduled Task, independent of code deploys -- crew upload photos any
# day regardless of when the app itself last changed.

$SUPABASE_URL = 'https://cngbsmmdfxmerlqnkate.supabase.co'
# service_role key, kept encrypted on this PC only (tools\supabase-cli\save-service-key.ps1).
# The bucket is private after the security cutover, so the anon key can no longer list or read it.
try { $SUPABASE_KEY = & 'C:\Users\Will Bradford\tools\supabase-cli\get-service-key.ps1' }
catch { Write-Error $_.Exception.Message; exit 1 }
$BUCKET       = 'vehicle-docs'
$destDir      = 'G:\My Drive\FloorPro CRM Backups\Storage'

$headers = @{
    'apikey'        = $SUPABASE_KEY
    'Authorization' = 'Bearer ' + $SUPABASE_KEY
    'Content-Type'  = 'application/json'
}

if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

Write-Output 'FloorPro CRM - Storage Bucket Backup'
Write-Output '======================================'

# Supabase's list endpoint is per-folder only, so walk the tree ourselves. An entry with a
# null id is a "folder" (a path prefix with no object of its own) -- recurse into it.
function Get-AllStorageFiles {
    param([string]$Prefix = '')

    $files = @()
    $url   = "$SUPABASE_URL/storage/v1/object/list/$BUCKET"
    $body  = @{ prefix = $Prefix; limit = 1000; offset = 0; sortBy = @{ column = 'name'; order = 'asc' } } | ConvertTo-Json

    try {
        $entries = Invoke-RestMethod -Uri $url -Headers $headers -Method Post -Body $body -ErrorAction Stop
    } catch {
        Write-Warning "Failed to list prefix '$Prefix': $($_.Exception.Message)"
        return $files
    }

    foreach ($entry in $entries) {
        $path = if ($Prefix) { "$Prefix/$($entry.name)" } else { $entry.name }
        if ($null -eq $entry.id) {
            $files += Get-AllStorageFiles -Prefix $path
        } else {
            $files += $path
        }
    }
    return $files
}

$allFiles = Get-AllStorageFiles
Write-Output ('Found ' + $allFiles.Count + ' file(s) in the bucket.')

$downloaded = 0
$skipped    = 0
$errors     = 0

foreach ($path in $allFiles) {
    $localPath = Join-Path $destDir ($path -replace '/', '\')
    if (Test-Path $localPath) {
        $skipped++
        continue
    }

    $localDir = Split-Path $localPath -Parent
    if (-not (Test-Path $localDir)) {
        New-Item -ItemType Directory -Force -Path $localDir | Out-Null
    }

    $encodedPath = ($path -split '/' | ForEach-Object { [uri]::EscapeDataString($_) }) -join '/'
    $fileUrl = "$SUPABASE_URL/storage/v1/object/$BUCKET/$encodedPath"

    try {
        Invoke-WebRequest -Uri $fileUrl -Headers @{ apikey = $SUPABASE_KEY; Authorization = 'Bearer ' + $SUPABASE_KEY } -OutFile $localPath -ErrorAction Stop
        $downloaded++
    } catch {
        Write-Warning ("Failed to download '" + $path + "': " + $_.Exception.Message)
        $errors++
    }
}

Write-Output ''
Write-Output ("Downloaded: $downloaded new file(s)   Already had: $skipped   Errors: $errors")
Write-Output 'Done.'

if ($errors -gt 0) { exit 1 }
