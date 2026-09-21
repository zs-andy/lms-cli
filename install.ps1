# CLI-only, per-user installation; no administrator rights or desktop setup windows.
param(
  [string]$Version, [string]$InstallDir = (Join-Path $env:LOCALAPPDATA 'lms-cli-runtime'),
  [string]$Archive, [string]$ChecksumFile, [switch]$NoSetup, [switch]$NoPath
)
$ErrorActionPreference = 'Stop'
# Use this PowerShell edition's built-in modules. A parent PowerShell 7 process
# can otherwise leave Windows PowerShell 5.1 with an incompatible PSModulePath.
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Management\Microsoft.PowerShell.Management.psd1') -ErrorAction Stop
Import-Module (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$lmsRoot = [IO.Path]::GetFullPath($InstallDir)
if ($lmsRoot -eq [IO.Path]::GetPathRoot($lmsRoot) -or $lmsRoot -eq [Environment]::GetFolderPath('UserProfile')) { throw 'Unsafe install directory.' }
if ((Test-Path -LiteralPath $lmsRoot) -and ((Get-Item -LiteralPath $lmsRoot).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Install directory must not be a link.' }
$lmsArch = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) { 'X64' { 'x64' } 'Arm64' { 'arm64' } default { throw 'Unsupported CPU architecture.' } }
$lmsTar = Join-Path $env:SystemRoot 'System32\tar.exe'
if (!(Test-Path -LiteralPath $lmsTar)) { throw 'Windows 10/11 tar.exe is required.' }
if (!$Archive -and !$Version) {
  $lmsRelease = Invoke-RestMethod -Uri 'https://api.github.com/repos/zs-andy/lms-cli/releases/latest' -Headers @{ 'User-Agent' = 'lms-cli-installer' } -TimeoutSec 20
  if ($lmsRelease.draft -or $lmsRelease.prerelease) { throw 'No stable release available.' }
  $Version = $lmsRelease.tag_name
}
if ($Version -notmatch '^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$') { throw 'Supply a valid stable release tag vX.Y.Z.' }
if ($Archive -and (!(Test-Path -LiteralPath $Archive) -or !(Test-Path -LiteralPath $ChecksumFile))) { throw 'Offline installation requires an archive and checksum file.' }
$lmsName = "lms-cli-$($Version.Substring(1))-win32-$lmsArch.tar.gz"
$lmsMarker = Join-Path $lmsRoot '.lms-install'
if (Test-Path -LiteralPath $lmsRoot) {
  if (!(Test-Path -LiteralPath $lmsMarker) -or (Get-Content -LiteralPath $lmsMarker -Raw).Trim() -ne 'lms-cli-managed-v1') { throw 'Directory is not managed by lms-cli; refusing to overwrite it.' }
} else {
  [IO.Directory]::CreateDirectory($lmsRoot) | Out-Null
  [IO.File]::WriteAllText($lmsMarker, "lms-cli-managed-v1`n")
}
$lmsLock = "$lmsRoot.lock"
# mkdir without -Force refuses an existing lock; the updater uses the same lock directory.
New-Item -ItemType Directory -Path $lmsLock -ErrorAction Stop | Out-Null
$lmsStage = Join-Path $lmsRoot ('.install-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($lmsStage) | Out-Null
try {
  if (!$Archive) {
    $lmsBase = "https://github.com/zs-andy/lms-cli/releases/download/$Version"
    $Archive = Join-Path $lmsStage 'package.tar.gz'; $ChecksumFile = Join-Path $lmsStage 'SHA256SUMS.txt'
    Invoke-WebRequest -UseBasicParsing -Uri "$lmsBase/SHA256SUMS.txt" -OutFile $ChecksumFile -TimeoutSec 180
    Invoke-WebRequest -UseBasicParsing -Uri "$lmsBase/$lmsName" -OutFile $Archive -TimeoutSec 180
  }
  $lmsMatches = @(Get-Content -LiteralPath $ChecksumFile | Where-Object { $_ -match ('^([a-fA-F0-9]{64}) [ *]' + [Regex]::Escape($lmsName) + '$') })
  if ($lmsMatches.Count -ne 1) { throw 'Missing or ambiguous SHA-256 checksum.' }
  $lmsExpected = $lmsMatches[0].Substring(0, 64).ToLowerInvariant()
  if ((Get-FileHash -LiteralPath $Archive -Algorithm SHA256).Hash.ToLowerInvariant() -ne $lmsExpected) { throw 'Checksum mismatch; existing version unchanged.' }
  $lmsEntries = & $lmsTar -tzf $Archive
  if ($LASTEXITCODE -ne 0) { throw 'Archive listing failed.' }
  foreach ($lmsEntry in $lmsEntries) {
    if ($lmsEntry -match '(^/|\\|(^|/)\.\.(/|$))' -or $lmsEntry -notmatch '^(app/|runtime/|launchers/|bundle\.json$)') { throw 'Unsafe archive paths.' }
  }
  $lmsTypes = & $lmsTar -tvzf $Archive
  if ($LASTEXITCODE -ne 0) { throw 'Archive listing failed.' }
  foreach ($lmsType in $lmsTypes) {
    if ($lmsType -match '^l') {
      if ($lmsType -notmatch ' -> (.+)$' -or $Matches[1] -match '(^/|\\|:|(^|/)\.\.(/|$))') { throw 'Unsafe archive link.' }
    } elseif ($lmsType -notmatch '^[-d]') { throw 'Unsafe archive entry type.' }
  }
  $lmsPayload = Join-Path $lmsStage 'unpack'; [IO.Directory]::CreateDirectory($lmsPayload) | Out-Null
  & $lmsTar -xzf $Archive -C $lmsPayload
  if ($LASTEXITCODE -ne 0) { throw 'Extraction failed.' }
  $lmsDestination = Join-Path $lmsRoot "versions\$Version"
  # Reinstallation reuses this directory; check it rather than only checking the fresh staging copy.
  if (Test-Path -LiteralPath $lmsDestination) { $lmsPayload = $lmsDestination }
  $lmsNode = Join-Path $lmsPayload 'runtime\node.exe'; $lmsCli = Join-Path $lmsPayload 'app\bin\lms.js'
  $lmsOldHome = $env:LMS_HOME; $lmsOldCheck = $env:LMS_UPDATE_CHECK
  try {
    $env:LMS_HOME = Join-Path $lmsStage 'check-home'; $env:LMS_UPDATE_CHECK = '0'
    if ((& $lmsNode $lmsCli --version) -ne $Version.Substring(1)) { throw 'Bundle version mismatch.' }
    $lmsDoctor = (& $lmsNode $lmsCli doctor) | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or !$lmsDoctor.nativeKeyringModuleLoads -or !$lmsDoctor.authorizationRuntimeInstalled) { throw 'Bundled CLI or authorization runtime check failed.' }
  } finally { $env:LMS_HOME = $lmsOldHome; $env:LMS_UPDATE_CHECK = $lmsOldCheck }
  [IO.Directory]::CreateDirectory((Split-Path -Parent $lmsDestination)) | Out-Null
  if (!(Test-Path -LiteralPath $lmsDestination)) { Move-Item -LiteralPath $lmsPayload -Destination $lmsDestination }
  $lmsBin = Join-Path $lmsRoot 'bin'; [IO.Directory]::CreateDirectory($lmsBin) | Out-Null
  Copy-Item -LiteralPath (Join-Path $lmsDestination 'launchers\lms.ps1') -Destination $lmsBin -Force
  Copy-Item -LiteralPath (Join-Path $lmsDestination 'launchers\lms.cmd') -Destination $lmsBin -Force
  $lmsCurrent = Join-Path $lmsRoot 'current'
  if ((Test-Path -LiteralPath $lmsCurrent) -and (Get-Content -LiteralPath $lmsCurrent -Raw).Trim() -ne $Version) { Copy-Item -LiteralPath $lmsCurrent -Destination (Join-Path $lmsRoot 'previous') -Force }
  $lmsPointer = Join-Path $lmsStage 'current'; [IO.File]::WriteAllText($lmsPointer, "$Version`n")
  if (Test-Path -LiteralPath $lmsCurrent) { [IO.File]::Replace($lmsPointer, $lmsCurrent, $null) } else { [IO.File]::Move($lmsPointer, $lmsCurrent) }
  if (!$NoPath) {
    $lmsUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (($lmsUserPath -split ';') -notcontains $lmsBin) {
      [IO.File]::WriteAllText((Join-Path $lmsRoot ('path-backup-' + [Guid]::NewGuid().ToString('N') + '.txt')), [string]$lmsUserPath)
      [Environment]::SetEnvironmentVariable('Path', "$lmsBin;$lmsUserPath", 'User')
    }
    $env:Path = "$lmsBin;$env:Path"
  }
  Write-Host "Installed lms-cli $($Version.Substring(1)). CLI: $lmsBin\lms.cmd"
} finally {
  # Only remove the unique staging directory created above, never the install/data root.
  if (Test-Path -LiteralPath $lmsStage) { Remove-Item -LiteralPath $lmsStage -Recurse -Force }
  Remove-Item -LiteralPath $lmsLock -Force
}
if (!$NoSetup -and [Environment]::UserInteractive -and ![Console]::IsInputRedirected) { & (Join-Path $lmsRoot 'bin\lms.cmd') setup }
else { Write-Host "Next: & '$lmsRoot\bin\lms.cmd' setup" }
