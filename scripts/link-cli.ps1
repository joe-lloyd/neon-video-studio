# Put `neon-cli` on PATH (Windows): writes neon-cli.cmd that runs this checkout's CLI with Node.
#   powershell -ExecutionPolicy Bypass -File scripts\link-cli.ps1 [-BinDir <dir>]   (default %USERPROFILE%\bin)
param([string]$BinDir = (Join-Path $env:USERPROFILE 'bin'))
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null
$shim = Join-Path $BinDir 'neon-cli.cmd'
Set-Content -Path $shim -Encoding Oem -Value "@echo off`r`nnode `"$repo\apps\cli\src\main.ts`" %*"
Write-Host "Wrote $shim -> $repo\apps\cli\src\main.ts"
if (-not (($env:Path -split ';') -contains $BinDir)) {
  Write-Host "Add it to PATH for new terminals:"
  Write-Host "  [Environment]::SetEnvironmentVariable('Path', '$BinDir;' + [Environment]::GetEnvironmentVariable('Path', 'User'), 'User')"
}
