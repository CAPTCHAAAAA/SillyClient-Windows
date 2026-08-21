[CmdletBinding()]
param(
    [string]$Source,
    [string]$Manifest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
if (-not $Source) {
    $workspace = Split-Path -Parent $repository
    $Source = Join-Path $repository "web\capacitor-ui\dist"
}

$sourceDirectory = [IO.Path]::GetFullPath($Source)
$manifestFile = if ($Manifest) { [IO.Path]::GetFullPath($Manifest) } else { "" }
$syncScript = Join-Path $PSScriptRoot "sync-frontend.mjs"

$syncArgs = @("--source", $sourceDirectory)
if ($manifestFile) {
    $syncArgs += @("--manifest", $manifestFile)
}
& node $syncScript @syncArgs
if ($LASTEXITCODE -ne 0) {
    throw "Frontend sync failed."
}
