param(
  [Parameter(ValueFromRemainingArguments = $true)]
  [string[]]$NextArgs
)

$ErrorActionPreference = "Stop"

$sourceRoot = Split-Path -Parent $PSScriptRoot
$runtimeName = if ($env:VIDEO_ANALYSIS_RUNTIME_NAME) {
  $env:VIDEO_ANALYSIS_RUNTIME_NAME
} else {
  "video-analysis-next-runtime-$PID"
}
$runtimeRoot = Join-Path $env:LOCALAPPDATA $runtimeName
$localAppDataRoot = [System.IO.Path]::GetFullPath($env:LOCALAPPDATA)
$resolvedRuntime = [System.IO.Path]::GetFullPath($runtimeRoot)

if (-not $resolvedRuntime.StartsWith($localAppDataRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to prepare runtime outside LocalAppData: $resolvedRuntime"
}

if (Test-Path -LiteralPath $runtimeRoot) {
  Remove-Item -LiteralPath $runtimeRoot -Recurse -Force
}

New-Item -ItemType Directory -Path $runtimeRoot -Force | Out-Null

$directories = @("app", "components", "hooks", "lib", "public", "types")
foreach ($directory in $directories) {
  Copy-Item `
    -LiteralPath (Join-Path $sourceRoot $directory) `
    -Destination (Join-Path $runtimeRoot $directory) `
    -Recurse `
    -Force
}

$files = @(
  "next-env.d.ts",
  "next.config.mjs",
  "package.json",
  "package-lock.json",
  "tsconfig.json"
)
foreach ($file in $files) {
  Copy-Item `
    -LiteralPath (Join-Path $sourceRoot $file) `
    -Destination (Join-Path $runtimeRoot $file) `
    -Force
}

$sourceNodeModules = Join-Path $sourceRoot "node_modules"
$runtimeNodeModules = Join-Path $runtimeRoot "node_modules"
New-Item `
  -ItemType Junction `
  -Path $runtimeNodeModules `
  -Target $sourceNodeModules | Out-Null

$npm = "C:\Program Files\nodejs\npm.cmd"
if (-not (Test-Path -LiteralPath $npm)) {
  $npm = "npm.cmd"
}

Write-Host "Starting from local runtime: $runtimeRoot"
Push-Location $runtimeRoot
try {
  & node (Join-Path $PSScriptRoot "dev-runtime.mjs") $sourceRoot $runtimeRoot @NextArgs
  exit $LASTEXITCODE
}
finally {
  Pop-Location
}
