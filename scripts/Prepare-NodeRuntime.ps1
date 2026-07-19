[CmdletBinding()]
param(
    [string]$NodeVersion = "22.16.0"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repository = Split-Path -Parent $PSScriptRoot
$runtimeDirectory = Join-Path $repository "runtime\node"
$nodeExecutable = Join-Path $runtimeDirectory "node.exe"
$expectedVersion = "v$NodeVersion"

if (Test-Path -LiteralPath $nodeExecutable) {
    $installedVersion = (& $nodeExecutable --version).Trim()
    if ($installedVersion -eq $expectedVersion) {
        Write-Host "Node.js $installedVersion is already prepared."
        exit 0
    }
}

$archiveName = "node-v$NodeVersion-win-x64.zip"
$baseUrl = "https://nodejs.org/dist/v$NodeVersion"
$temporaryDirectory = Join-Path ([IO.Path]::GetTempPath()) "sillyclient-node-$NodeVersion-$PID"
$archivePath = Join-Path $temporaryDirectory $archiveName
$checksumsPath = Join-Path $temporaryDirectory "SHASUMS256.txt"
$extractDirectory = Join-Path $temporaryDirectory "extract"

try {
    New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
    Invoke-WebRequest -Uri "$baseUrl/$archiveName" -OutFile $archivePath
    Invoke-WebRequest -Uri "$baseUrl/SHASUMS256.txt" -OutFile $checksumsPath

    $escapedName = [Regex]::Escape($archiveName)
    $checksumLine = Get-Content -LiteralPath $checksumsPath |
        Where-Object { $_ -match "^([a-fA-F0-9]{64})\s+$escapedName$" } |
        Select-Object -First 1

    if (-not $checksumLine) {
        throw "Checksum for $archiveName was not found."
    }

    $expectedHash = ([Regex]::Match($checksumLine, "^[a-fA-F0-9]{64}")).Value.ToUpperInvariant()
    $actualHash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash
    if ($actualHash -ne $expectedHash) {
        throw "Node.js archive checksum mismatch."
    }

    Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDirectory -Force
    $sourceDirectory = Join-Path $extractDirectory "node-v$NodeVersion-win-x64"
    if (-not (Test-Path -LiteralPath (Join-Path $sourceDirectory "node.exe"))) {
        throw "The downloaded Node.js archive has an unexpected layout."
    }

    if (Test-Path -LiteralPath $runtimeDirectory) {
        Remove-Item -LiteralPath $runtimeDirectory -Recurse -Force
    }
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    Copy-Item -Path (Join-Path $sourceDirectory "*") -Destination $runtimeDirectory -Recurse -Force

    $preparedVersion = (& $nodeExecutable --version).Trim()
    if ($preparedVersion -ne $expectedVersion) {
        throw "Prepared runtime reported $preparedVersion instead of $expectedVersion."
    }
    Write-Host "Prepared Node.js $preparedVersion in $runtimeDirectory"
} finally {
    if (Test-Path -LiteralPath $temporaryDirectory) {
        Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force
    }
}
