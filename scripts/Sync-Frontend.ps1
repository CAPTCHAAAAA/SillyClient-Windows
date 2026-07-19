[CmdletBinding()]
param(
    [string]$Source
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
if (-not $Source) {
    $workspace = Split-Path -Parent $repository
    $Source = Join-Path $workspace "SillyClient_Android\App\web\capacitor-ui\dist"
}

$sourceDirectory = [IO.Path]::GetFullPath($Source)
$destination = Join-Path $repository "frontend-dist"

if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory "index.html"))) {
    throw "Frontend build not found at $sourceDirectory. Build capacitor-ui first."
}

if (Test-Path -LiteralPath $destination) {
    Remove-Item -LiteralPath $destination -Recurse -Force
}
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item -Path (Join-Path $sourceDirectory "*") -Destination $destination -Recurse -Force
Write-Host "Synced $sourceDirectory -> $destination"
