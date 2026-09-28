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
# The token is optional - without it the Hub still installs completely and the
# user signs in to their own Claude / Codex account on first use. An empty box
# therefore must not abort the install, only ask for confirmation.
if (-not $Token) {
  Add-Type -AssemblyName Microsoft.VisualBasic
  $Token = [Microsoft.VisualBasic.Interaction]::InputBox(
    "请粘贴团队管理员发你的 64 位 Token（类似 f63f5fb3...357d）。`r`n`r`n没有 Token 也能装：直接留空点确定，装好后在 Hub 里登录你自己的 Claude / Codex 账号。",
    "AI Hub - 一键安装",
    "")
}
$Token = ("$Token").Trim()
if (-not $Token) {
  Add-Type -AssemblyName System.Windows.Forms | Out-Null
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "没有填 Token。`r`n`r`n点「是」：继续安装，装好后用你自己的 Claude / Codex 账号登录。`r`n点「否」：取消安装。",
    "AI Hub - 没有 Token",
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question)
  if ($answer -ne [System.Windows.Forms.DialogResult]::Yes) {
    Write-Host "已取消安装。"
    Read-Host "按回车关闭"
    exit 1
  }
  Write-Host "未提供 Token：按「自己账号」模式继续安装。"
}

# 3. Run the real installer. Forward optional params BY NAME (hashtable splat -
# array splat would pass them positionally and break -HubDir/-DataDir).
$fwd = @{}
foreach ($k in 'HubDir', 'DataDir', 'MeridianUrl') {
  if ($PSBoundParameters.ContainsKey($k)) { $fwd[$k] = $PSBoundParameters[$k] }
}
if ($NoLaunch) { $fwd['NoLaunch'] = $true }
if ($SkipHealthCheck) { $fwd['SkipHealthCheck'] = $true }
if ($Token) { $fwd['Token'] = $Token }
& $setup @fwd
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
  Write-Host "==> 安装结束：成功。可以双击桌面 'AI Hub' 图标使用了。" -ForegroundColor Green
} else {
  Write-Host "==> 安装结束：失败。请把上面红色 FAIL 那一行发给团队管理员。" -ForegroundColor Red
}
Read-Host "按回车关闭本窗口"
exit $code
