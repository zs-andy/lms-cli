$ErrorActionPreference = 'Stop'
$env:LMS_INSTALL_ROOT = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$lmsVersion = (Get-Content -LiteralPath (Join-Path $env:LMS_INSTALL_ROOT 'current') -Raw).Trim()
if ($lmsVersion -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Invalid lms installation pointer. Re-run the installer.' }
$lmsDirectory = Join-Path $env:LMS_INSTALL_ROOT "versions\$lmsVersion"
& (Join-Path $lmsDirectory 'runtime\node.exe') (Join-Path $lmsDirectory 'app\bin\lms.js') @args
exit $LASTEXITCODE
