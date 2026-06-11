# ============================================================
# AI Group Chat Hub - One-Click Team Setup (Windows)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <64-char-hex>
#
# What it does (fully unattended, no GUI clicking needed):
#   1. Install Git + Node.js LTS via winget (skipped if present)
#   2. Clone (or update) this repo to %USERPROFILE%\claude-session-hub
#   3. npm install
#   4. Install Claude Code CLI globally (skipped if present)
#   5. Write Meridian config (Claude + Codex both routed through team VPS)
#   6. Verify the token against the live Meridian endpoint
#   7. Create a desktop shortcut + launch the Hub
#
# Exit code 0 = everything works. Non-zero = read the last FAIL line.
# ============================================================
param(
  [string]$Token = "",
  [string]$MeridianUrl = "https://meridian.lthub.xyz:8443",
  [string]$HubDir = "$env:USERPROFILE\claude-session-hub",
  [string]$DataDir = "$env:USERPROFILE\.claude-session-hub",
  [switch]$NoLaunch,
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Fail([string]$msg) { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

# ---------- 0. validate token ----------
Step "Validating token"
if (-not $Token) {
  Write-Host @"
    Missing -Token. Ask your team admin for a 64-char hex token, then run:
      powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <token>
"@
  exit 1
}
if ($Token -notmatch '^[0-9a-fA-F]{64}$') {
  Fail "Token must be exactly 64 hex characters (got length $($Token.Length)). Check for missing/extra characters."
}
Ok "token format looks good"

# ---------- 1. git ----------
Step "Checking Git"
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  Write-Host "    Installing Git via winget (a UAC prompt may appear - click Yes)..."
  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Fail "Git still not found after install. Install manually from https://git-scm.com then re-run."
  }
}
Ok "$(git --version)"

# ---------- 2. node ----------
Step "Checking Node.js"
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "    Installing Node.js LTS via winget (a UAC prompt may appear - click Yes)..."
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
  if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Fail "Node.js still not found after install. Install manually from https://nodejs.org then re-run."
  }
}
$nodeMajor = [int]((node --version) -replace '^v(\d+).*', '$1')
if ($nodeMajor -lt 18) { Fail "Node.js >= 18 required, found $(node --version). Upgrade Node and re-run." }
Ok "node $(node --version)"

# ---------- 3. clone or update repo ----------
Step "Getting Hub source -> $HubDir"
if (Test-Path "$HubDir\.git") {
  Push-Location $HubDir
  git pull origin master
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "git pull failed. Fix network access to github.com then re-run." }
  Pop-Location
  Ok "updated existing clone"
} else {
  git clone https://github.com/TianLin0509/claude-session-hub.git $HubDir
  if ($LASTEXITCODE -ne 0) { Fail "git clone failed. Fix network access to github.com then re-run." }
  Ok "cloned fresh copy"
}

# ---------- 4. npm install ----------
Step "Installing Hub dependencies (npm install, 2-15 min on first run)"
Push-Location $HubDir
npm install --no-audit --no-fund
$npmExit = $LASTEXITCODE
Pop-Location
if ($npmExit -ne 0) {
  Write-Host "    Hint: if the error mentions EBUSY, close any running Hub window, then:"
  Write-Host "      Get-Process electron -ErrorAction SilentlyContinue | Stop-Process -Force"
  Fail "npm install failed (exit $npmExit). Fix the error above and re-run."
}
if (-not (Test-Path "$HubDir\node_modules\electron\dist\electron.exe")) {
  Fail "electron.exe missing after npm install - node_modules is broken. Re-run this script."
}
Ok "dependencies installed"

# ---------- 5. claude CLI ----------
Step "Checking Claude Code CLI"
if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
  npm install -g @anthropic-ai/claude-code
  Refresh-Path
  if (-not (Get-Command claude -ErrorAction SilentlyContinue)) {
    Fail "claude CLI still not found after npm install -g. Check 'npm config get prefix' is on PATH."
  }
}
Ok "claude CLI present"

# ---------- 6. write config (Meridian + Codex linkage) ----------
Step "Writing Meridian config -> $DataDir\config.json"
# Write the merge logic to a temp .js file (avoids node -e quoting/BOM mangling).
$mergeJs = @'
const fs = require("fs"), path = require("path");
const [cfgPath, url, token] = process.argv.slice(2);
let cfg = {};
try {
  let raw = fs.readFileSync(cfgPath, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  cfg = JSON.parse(raw);
} catch (e) {}
cfg.providers = cfg.providers || {};
cfg.providers.meridian = { url: url, token: token, enabled: true };
const cx = cfg.providers.codex || {};
cx.backend = "api";
cx.base_url = url.replace(/\/+$/, "") + "/codex/v1";
cx.api_key = token;
cx.model = "gpt-5.5";
cx.provider = "meridian";
cfg.providers.codex = cx;
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log("written: " + cfgPath);
'@
$mergeJsPath = Join-Path $env:TEMP "hub-merge-config.js"
[System.IO.File]::WriteAllText($mergeJsPath, $mergeJs, (New-Object System.Text.UTF8Encoding($false)))
node $mergeJsPath "$DataDir\config.json" $MeridianUrl $Token
if ($LASTEXITCODE -ne 0) { Fail "failed to write config.json" }
Remove-Item $mergeJsPath -ErrorAction SilentlyContinue
Ok "Meridian enabled for Claude, Codex auto-linked (model gpt-5.5)"

# ---------- 7. live verification ----------
if (-not $SkipHealthCheck) {
  Step "Verifying Meridian endpoint + token (live)"
  try {
    $h = Invoke-WebRequest -UseBasicParsing -Uri "$MeridianUrl/healthz" -TimeoutSec 20
    Ok "endpoint reachable (healthz $($h.StatusCode))"
  } catch {
    Fail "cannot reach $MeridianUrl - check your network/firewall, or re-run with -SkipHealthCheck. ($($_.Exception.Message))"
  }
  try {
    $body = '{"model":"claude-sonnet-4-5","max_tokens":1,"messages":[{"role":"user","content":"ping"}]}'
    $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$MeridianUrl/v1/messages" `
      -Headers @{ "Authorization" = "Bearer $Token"; "anthropic-version" = "2023-06-01" } `
      -ContentType "application/json" -Body $body -TimeoutSec 120
    Ok "token accepted, Claude responded (HTTP $($r.StatusCode))"
  } catch {
    $code = ""
    try { $code = [int]$_.Exception.Response.StatusCode } catch {}
    if ($code -eq 401 -or $code -eq 403) {
      Fail "token REJECTED (HTTP $code). Ask your team admin to verify/reissue your token."
    }
    Fail "token check failed (HTTP $code $($_.Exception.Message)). Ask your team admin."
  }
}

# ---------- 8. desktop shortcut + launch ----------
Step "Creating desktop shortcut"
try {
  $ws = New-Object -ComObject WScript.Shell
  $lnk = $ws.CreateShortcut("$env:USERPROFILE\Desktop\AI Hub.lnk")
  $lnk.TargetPath = "$HubDir\node_modules\electron\dist\electron.exe"
  $lnk.Arguments = "`"$HubDir`""
  $lnk.WorkingDirectory = $HubDir
  $lnk.Save()
  Ok "Desktop\AI Hub.lnk"
} catch {
  Write-Host "    WARN: shortcut creation failed ($($_.Exception.Message)) - not fatal" -ForegroundColor Yellow
}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " SETUP COMPLETE" -ForegroundColor Green
Write-Host "   Claude  -> team Max subscription via Meridian VPS"
Write-Host "   Codex   -> team ChatGPT Pro via Meridian VPS (gpt-5.5)"
Write-Host "   Launch  -> double-click 'AI Hub' on Desktop, or:"
Write-Host "     & `"$HubDir\node_modules\electron\dist\electron.exe`" `"$HubDir`""
Write-Host "   Try it  -> click '+ New' -> 'Claude Code' -> type anything"
Write-Host "============================================================" -ForegroundColor Green

if (-not $NoLaunch) {
  Step "Launching Hub"
  Start-Process -FilePath "$HubDir\node_modules\electron\dist\electron.exe" -ArgumentList "`"$HubDir`"" -WorkingDirectory $HubDir
  Ok "Hub window should appear in a few seconds"
}
