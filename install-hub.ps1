param(
  [string]$Token = "",
  [string]$HubDir,
  [string]$DataDir,
  [string]$MeridianUrl,
  [switch]$NoLaunch,
  [switch]$SkipHealthCheck
)

# GUI wrapper around setup.ps1: double-click install-hub.bat ->
# a token input box pops up -> the full unattended install runs.
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ErrorActionPreference = "Stop"

# 1. Locate setup.ps1 (next to this file in a clone, otherwise download it).
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$setup = Join-Path $here "setup.ps1"
if (-not (Test-Path $setup)) {
  $setup = Join-Path $env:TEMP "hub-setup.ps1"
  Write-Host "正在下载安装脚本 setup.ps1 ..."
  Invoke-WebRequest -UseBasicParsing `
    -Uri "https://raw.githubusercontent.com/TianLin0509/claude-session-hub/master/setup.ps1" `
    -OutFile $setup
}

# 2. Get the token: from -Token if passed, else a GUI input box.
if (-not $Token) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $Token = [Microsoft.VisualBasic.Interaction]::InputBox(
    "请粘贴团队管理员发你的 64 位 Token（类似 f63f5fb3...357d）：",
    "AI Hub - 团队一键安装",
    "")
}
$Token = ("$Token").Trim()
if (-not $Token) {
  Write-Host "未输入 Token，已取消安装。"
  Read-Host "按回车关闭"
  exit 1
}

# 3. Run the real installer. Forward optional params BY NAME (hashtable splat -
# array splat would pass them positionally and break -HubDir/-DataDir).
$fwd = @{}
foreach ($k in 'HubDir', 'DataDir', 'MeridianUrl') {
  if ($PSBoundParameters.ContainsKey($k)) { $fwd[$k] = $PSBoundParameters[$k] }
}
if ($NoLaunch) { $fwd['NoLaunch'] = $true }
if ($SkipHealthCheck) { $fwd['SkipHealthCheck'] = $true }
& $setup -Token $Token @fwd
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "==> 安装结束：成功。可以双击桌面 'AI Hub' 图标使用了。" -ForegroundColor Green
} else {
  Write-Host "==> 安装结束：失败。请把上面红色 FAIL 那一行发给团队管理员。" -ForegroundColor Red
}
Read-Host "按回车关闭本窗口"
exit $code
