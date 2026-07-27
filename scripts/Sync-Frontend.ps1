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
    $Source = Join-Path $workspace "SillyClient_Android\web\capacitor-ui\dist"
}
if (-not $Manifest) {
    $workspace = Split-Path -Parent $repository
    $Manifest = Join-Path $workspace "SillyClient_Android\app\src\main\assets\public\sillyclient-build.json"
}

$sourceDirectory = [IO.Path]::GetFullPath($Source)
$manifestFile = [IO.Path]::GetFullPath($Manifest)
$syncScript = Join-Path $PSScriptRoot "sync-frontend.mjs"

& node $syncScript --source $sourceDirectory --manifest $manifestFile
if ($LASTEXITCODE -ne 0) {
    throw "Frontend sync failed."
}
