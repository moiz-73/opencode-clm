# opencode-clm installer (Windows / PowerShell)
# Usage:
#   iwr https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/install.ps1 | iex
#   - or from a clone:  .\install.ps1
$ErrorActionPreference = "Stop"

$destDir = Join-Path $HOME ".config\opencode\plugins"
$dest    = Join-Path $destDir "clm-context.ts"
$rawUrl  = "https://raw.githubusercontent.com/f2025408135-cyber/opencode-clm/main/clm-context.ts"

# Prefer the copy next to this script (clone); fall back to GitHub raw (iex).
$src = if ($PSScriptRoot) { Join-Path $PSScriptRoot "clm-context.ts" } else { $null }
if ($src -and (Test-Path $src)) {
    $content = [IO.File]::ReadAllText($src)
    Write-Host "Using local clm-context.ts"
} else {
    Write-Host "Downloading $rawUrl"
    $wc = New-Object System.Net.WebClient
    $wc.Encoding = [Text.Encoding]::UTF8
    $content = $wc.DownloadString($rawUrl)
}

New-Item -ItemType Directory -Force -Path $destDir | Out-Null
if (Test-Path $dest) {
    Copy-Item $dest "$dest.bak" -Force
    Write-Host "Backed up existing plugin -> clm-context.ts.bak"
}
# UTF-8 without BOM so bun/binary plugin loaders read it cleanly
[IO.File]::WriteAllText($dest, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host "Installed -> $dest"

# Default config (only if the user has none yet)
$cfg = Join-Path $HOME ".config\opencode\clm.jsonc"
if (-not (Test-Path $cfg)) {
    $defaultCfg = @"
{
  // Context budget in approximate tokens (~1 token per 4 visible characters).
  "budget": 100000,
  // "fit" = reject an edit only if it would exceed the budget (default).
  // "shrink" = reject an edit unless it makes context smaller than before.
  "gate": "fit"
}
"@
    [IO.File]::WriteAllText($cfg, $defaultCfg, (New-Object Text.UTF8Encoding($false)))
    Write-Host "Wrote default config -> $cfg"
}

Write-Host ""
Write-Host "Done. Now restart OpenCode (or run 'opencode reload')."
Write-Host "Verify: ask the model to run clm_status, or check the log for 'clm-context'."
