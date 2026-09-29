param([string]$Version)
$ErrorActionPreference='Stop'
if(-not $Version){$Version=(Get-Content (Join-Path $PSScriptRoot '..\package.json') -Raw | ConvertFrom-Json).version}
# Short root with a space: the installer adds its own staging folders, and the whole
# unpacked tree must stay under the classic 260-character Windows path limit.
$root=Join-Path ([IO.Path]::GetTempPath()) ('hub pa '+([guid]::NewGuid().ToString('N').Substring(0,8)))
New-Item -ItemType Directory -Path $root | Out-Null
$archive=(Resolve-Path (Join-Path $PSScriptRoot "..\dist\AIHubCommunity-$Version-win-x64.zip")).Path
$checksum=Join-Path $root 'SHA256SUMS.txt'
[IO.File]::WriteAllText($checksum,((Get-FileHash -LiteralPath $archive).Hash+'  '+[IO.Path]::GetFileName($archive)))
$receipt=Join-Path $root 'result.json'
& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot '..\scripts\install-release.ps1') -Version $Version -PackagePath $archive -ChecksumPath $checksum -Destination (Join-Path $root 'installed') -NoLaunch -NoShortcut -ResultPath $receipt
if($LASTEXITCODE -ne 0){throw 'Portable installer failed'}
$result=Get-Content -LiteralPath $receipt -Raw -Encoding UTF8 | ConvertFrom-Json
if(-not $result.ok){throw 'Portable receipt not successful'}
& node.exe (Join-Path $PSScriptRoot 'e2e-community-cdp.js') --executable $result.executable
if($LASTEXITCODE -ne 0){throw 'Installed ZIP user journey failed'}
Write-Host 'PASS: actual ZIP installed in spaced path and its executable completed isolated UI user journeys.'
