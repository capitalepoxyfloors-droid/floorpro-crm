# FloorPro CRM — Google Drive Backup Script
# Copies the latest built index.html to Google Drive with a timestamp.
# Keeps the 30 most recent backups and deletes older ones.
# Called automatically by the git post-commit hook.

$source  = "C:\Users\Will Bradford\Desktop\floorpro-crm\index.html"
$destDir = "G:\My Drive\FloorPro CRM Backups"
$keep    = 30   # number of backups to retain

if (-not (Test-Path $source)) {
    Write-Warning "Source file not found: $source"
    exit 1
}

if (-not (Test-Path $destDir)) {
    New-Item -ItemType Directory -Force -Path $destDir | Out-Null
}

# Timestamped filename  e.g.  FloorPro CRM - 2026-06-03 14-30-00.html
$stamp   = Get-Date -Format "yyyy-MM-dd HH-mm-ss"
$destFile = Join-Path $destDir "FloorPro CRM - $stamp.html"

Copy-Item -Path $source -Destination $destFile -Force
Write-Output "Backup saved: $destFile"

# Prune old backups — keep only the $keep most recent
$allBackups = Get-ChildItem -Path $destDir -Filter "FloorPro CRM - *.html" |
              Sort-Object LastWriteTime -Descending

if ($allBackups.Count -gt $keep) {
    $toDelete = $allBackups | Select-Object -Skip $keep
    foreach ($f in $toDelete) {
        Remove-Item $f.FullName -Force
        Write-Output "Pruned old backup: $($f.Name)"
    }
}

Write-Output "Done. $([Math]::Min($allBackups.Count, $keep)) backups on Google Drive."
