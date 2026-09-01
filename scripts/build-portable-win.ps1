[CmdletBinding()]
param(
  [string]$OutputDirectory = "portable-win"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ($env:OS -ne "Windows_NT") {
  throw "This builder must run on Windows so npm selects Windows production dependencies and PyInstaller creates searcher.exe."
}

$projectRoot = Split-Path -Parent $PSScriptRoot
$package = Get-Content (Join-Path $projectRoot "package.json") -Raw | ConvertFrom-Json
$releaseName = "El-Exportador-$($package.version)-windows"
$outputRoot = Join-Path $projectRoot $OutputDirectory
$zipPath = Join-Path $outputRoot "$releaseName.zip"
$tempRoot = [System.IO.Path]::GetFullPath($env:TEMP)
$stageRoot = Join-Path $tempRoot "ee-$($package.version)-$PID"
$releaseRoot = Join-Path $stageRoot $releaseName
$appRoot = Join-Path $releaseRoot "app"

if (Test-Path -LiteralPath $zipPath) {
  throw "Refusing to overwrite existing package: $zipPath. Move or rename it, then run the build again."
}

$python = Get-Command python -ErrorAction SilentlyContinue
if (-not $python) {
  throw "Python is required to freeze src\ytmusic\searcher.py. Install Python 3 and PyInstaller, then retry."
}
try {
  & $python.Source -m PyInstaller --version | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "PyInstaller exited with $LASTEXITCODE" }
} catch {
  throw "PyInstaller is required but unavailable. In the project environment run: python -m pip install -r requirements.txt pyinstaller. Then retry. Details: $($_.Exception.Message)"
}

try {
  New-Item -ItemType Directory -Path $appRoot -Force | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $releaseRoot "artifacts") -Force | Out-Null

  # The package lock makes this a fresh, production-only dependency tree; no repository node_modules or dist is reused.
Copy-Item (Join-Path $projectRoot "package.json") $appRoot
Copy-Item (Join-Path $projectRoot "package-lock.json") $appRoot
Push-Location $appRoot
try {
  & npm ci --omit=dev
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
} finally {
  Pop-Location
}

# tsx runs this explicit runtime TypeScript allowlist directly; type-only modules are erased at runtime.
$runtimeSources = @(
  "src\web\server.ts",
  "src\web\guidedBrowserAuth.ts",
  "src\ytmusic\client.ts",
  "src\parser.ts",
  "src\services\session.service.ts"
)
Write-Host "Runtime source allowlist: $($runtimeSources -join ', ')"
foreach ($source in $runtimeSources) {
  $from = Join-Path $projectRoot $source
  if (-not (Test-Path -LiteralPath $from -PathType Leaf)) { throw "Required runtime source is missing: $source" }
  $to = Join-Path $appRoot $source
  $toParent = Split-Path -Parent $to
  New-Item -ItemType Directory -Path $toParent -Force | Out-Null
  Copy-Item -LiteralPath $from -Destination $to -Force
}

$publicSource = Join-Path $projectRoot "public"
if (-not (Test-Path -LiteralPath $publicSource)) { throw "Required public assets directory is missing: public" }
Copy-Item -LiteralPath $publicSource -Destination (Join-Path $appRoot "public") -Recurse -Force

$pyInstallerDist = Join-Path $stageRoot "pyinstaller-dist"
& $python.Source -m PyInstaller --noconfirm --clean --onefile --collect-data ytmusicapi --collect-data certifi --name searcher --distpath $pyInstallerDist --workpath (Join-Path $stageRoot "pyinstaller-work") --specpath (Join-Path $stageRoot "pyinstaller-spec") (Join-Path $projectRoot "src\ytmusic\searcher.py")
if ($LASTEXITCODE -ne 0) { throw "PyInstaller failed with exit code $LASTEXITCODE. Install the Python requirements and retry." }
$searcher = Join-Path $pyInstallerDist "searcher.exe"
if (-not (Test-Path -LiteralPath $searcher)) { throw "PyInstaller completed but searcher.exe was not produced: $searcher" }
Copy-Item -LiteralPath $searcher -Destination (Join-Path $releaseRoot "artifacts\searcher.exe")

Copy-Item (Join-Path $PSScriptRoot "start.cmd.template") (Join-Path $releaseRoot "start.cmd")

# npm ci populates node_modules from the lockfile in an otherwise empty staging directory. Exclude it
# here because dependency source may legitimately use names such as "credentials"; assert every
# application-controlled staged path contains no local state or prohibited source artifacts.
$forbiddenPathNames = @("NO.m3u", "test", "tests", "backup", "backups", ".config", "log", "logs", "profile", "profiles", "token", "tokens", "credential", "credentials")
$forbiddenStagedPaths = Get-ChildItem -LiteralPath $releaseRoot -Recurse -Force | Where-Object {
  $relativePath = $_.FullName.Substring($releaseRoot.Length).TrimStart('\', '/')
  if ($relativePath -like "app\node_modules\*") { return $false }
  ($relativePath -split '[\\/]') | Where-Object { $forbiddenPathNames -icontains $_ }
}
if ($forbiddenStagedPaths) {
  $paths = $forbiddenStagedPaths | ForEach-Object { $_.FullName.Substring($releaseRoot.Length).TrimStart('\', '/') }
  throw "Forbidden path(s) found in staged package: $($paths -join ', ')"
}

  Compress-Archive -Path $releaseRoot -DestinationPath $zipPath -CompressionLevel Optimal
  Write-Host "Portable ZIP created: $zipPath"
} finally {
  # Only remove the PID/version-specific directory created under TEMP; never touch the final ZIP.
  if ((Test-Path -LiteralPath $stageRoot) -and ((Split-Path -Parent $stageRoot) -eq $tempRoot)) {
    Remove-Item -LiteralPath $stageRoot -Recurse -Force
  }
}
