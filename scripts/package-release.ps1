$ErrorActionPreference = 'Stop'
$sourceRoot = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $sourceRoot 'manifest.json'
$manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
$version = [string]$manifest.version
if ($version -notmatch '^\d+\.\d+\.\d+$') { throw "Invalid manifest version: $version" }
if ($manifest.name -ne 'ChatGPT-Mini-Map') { throw 'manifest.name must remain ChatGPT-Mini-Map' }
$runtimeFiles = @('manifest.json','README.md','conversation-bridge.js','conversation-model.js','page-dom.js','message-locator.js','navigation.js','content.js','panel.css','popup.html','popup.css','popup.js')
$dist = Join-Path $sourceRoot 'dist'
$stage = Join-Path $dist 'ChatGPT-Mini-Map'
if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
New-Item -ItemType Directory -Path $stage -Force | Out-Null
foreach ($file in $runtimeFiles) {
  $source = Join-Path $sourceRoot $file
  if (-not (Test-Path -LiteralPath $source)) { throw "Missing runtime file: $file" }
  Copy-Item -LiteralPath $source -Destination (Join-Path $stage $file) -Force
}
Copy-Item -LiteralPath (Join-Path $sourceRoot 'icons') -Destination (Join-Path $stage 'icons') -Recurse -Force
if (Get-Command node -ErrorAction SilentlyContinue) {
  foreach ($file in $runtimeFiles | Where-Object { $_ -like '*.js' }) {
    node --check (Join-Path $sourceRoot $file)
    if ($LASTEXITCODE -ne 0) { throw "Syntax check failed: $file" }
  }
}
$zip = Join-Path $dist "ChatGPT-Mini-Map-edge-v$version.zip"
if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
Compress-Archive -LiteralPath $stage -DestinationPath $zip -Force
Write-Output "Created $zip"
Write-Output "Load this folder in Edge: $stage"



