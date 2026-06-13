# 发布 Hub 源码热更新包到 VPS 更新通道
# 用法：
#   .\tools\publish-hub-update.ps1                  # 发布当前 package.json 版本（源码增量包，几 MB）
#   .\tools\publish-hub-update.ps1 -Notes "修复xx"   # 附更新说明（公司侧确认框会显示）
#   .\tools\publish-hub-update.ps1 -RequireFull     # 依赖有变更时用：标记低版本必须重新下载完整便携包
#
# 公司侧：远程面板点 "⟳ 检查更新" 即拉取应用并自动重启。
# 通道：https://lthub.xyz:8443/hub-update/{manifest.json, hub-src-<ver>.zip}

param(
    [string]$Notes = "",
    [switch]$RequireFull
)

$ErrorActionPreference = "Stop"
$repo = Split-Path -Parent $PSScriptRoot
$pkg = Get-Content (Join-Path $repo "package.json") -Raw | ConvertFrom-Json
$ver = $pkg.version
$zipName = "hub-src-$ver.zip"
$tmpZip = Join-Path $env:TEMP $zipName

Write-Host "[publish] version $ver, packing source (exclude node_modules/.git/.arena/android-app/dist)..."
if (Test-Path $tmpZip) { Remove-Item $tmpZip -Force }
Push-Location $repo
tar -a -c -f $tmpZip `
    --exclude ".git" --exclude ".git/*" `
    --exclude ".arena" --exclude ".arena/*" `
    --exclude "node_modules" --exclude "node_modules/*" `
    --exclude "android-app" --exclude "android-app/*" `
    --exclude "dist" --exclude "dist/*" `
    .
Pop-Location
if ($LASTEXITCODE -ne 0) { throw "tar pack failed" }

$sha = (Get-FileHash $tmpZip -Algorithm SHA256).Hash.ToLower()
$sizeMB = [Math]::Round((Get-Item $tmpZip).Length / 1MB, 1)
Write-Host "[publish] $zipName = $sizeMB MB, sha256=$($sha.Substring(0,12))..."

$manifest = [ordered]@{
    version = $ver
    zip = $zipName
    sha256 = $sha
    minFullVersion = if ($RequireFull) { $ver } else { "0.0.0" }
    notes = $Notes
    ts = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
}
$manifestPath = Join-Path $env:TEMP "hub-update-manifest.json"
[System.IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [System.Text.UTF8Encoding]::new($false))

Write-Host "[publish] uploading to VPS..."
# -n：防 ssh 吃 stdin（后台/管道运行时会卡死）
ssh -n root@138.128.192.245 "mkdir -p /opt/hub-mobile/pwa/hub-update"
scp $tmpZip "root@138.128.192.245:/opt/hub-mobile/pwa/hub-update/$zipName"
if ($LASTEXITCODE -ne 0) { throw "scp zip failed" }
scp $manifestPath "root@138.128.192.245:/opt/hub-mobile/pwa/hub-update/manifest.json"
if ($LASTEXITCODE -ne 0) { throw "scp manifest failed" }

# 保留最近 3 个版本的 zip，清理更旧的
ssh -n root@138.128.192.245 "cd /opt/hub-mobile/pwa/hub-update && ls -t hub-src-*.zip | tail -n +4 | xargs -r rm -f"

Write-Host "[publish] DONE. v$ver published to https://lthub.xyz:8443/hub-update/manifest.json"
if ($RequireFull) { Write-Host "[publish] RequireFull 已标记：低于 $ver 的安装必须重新下载完整便携包" -ForegroundColor Yellow }
