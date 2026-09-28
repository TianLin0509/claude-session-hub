# ============================================================
# AI Group Chat Hub - One-Click Team Setup (Windows)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1                  # bring your own CLI accounts
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <64-hex>  # team gateway account
#
# What it does (fully unattended, no GUI clicking needed):
#   1. Install Git + Node.js LTS via winget (skipped if present)
#   2. Clone (or update) this repo to %USERPROFILE%\claude-session-hub
#   3. npm install
#   4. Install Claude Code CLI globally (skipped if present)
#   5. Write gateway config for Claude + Codex (only when -Token is given)
#   6. Probe the gateway (warn-only: a dead gateway never blocks the install)
#   7. Create a desktop shortcut + launch the Hub
#
# The Token is optional. Without it the Hub still installs completely and you
# sign in to your own Claude / Codex account inside the Hub on first use.
#
# Exit code 0 = Hub installed. Non-zero = read the last FAIL line.
# ============================================================
param(
  [string]$Token = "",
  [string]$MeridianUrl = "https://meridian.lthub.xyz:8443",
  [string]$ClaudeModel = "claude-sonnet-4-5",
  [string]$CodexModel = "gpt-5.5",
  [string]$HubDir = "$env:USERPROFILE\claude-session-hub",
  [string]$DataDir = "$env:USERPROFILE\.claude-session-hub",
  [string]$LocalSource = "",
  [switch]$NoLaunch,
  [switch]$SkipHealthCheck
)

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Step([string]$msg) { Write-Host ""; Write-Host "==> $msg" -ForegroundColor Cyan }
function Ok([string]$msg)   { Write-Host "    OK: $msg" -ForegroundColor Green }
function Warn([string]$msg) { Write-Host "    WARN: $msg" -ForegroundColor Yellow }
function Fail([string]$msg) { Write-Host "    FAIL: $msg" -ForegroundColor Red; exit 1 }

function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" +
              [Environment]::GetEnvironmentVariable("Path", "User")
}

# GitHub is the source of truth. Gitee is a mirror that can lag behind, so it is
# only ever a fallback - installing a silently outdated Hub is worse than a
# visible clone failure.
$RepoGitHub = "https://github.com/TianLin0509/claude-session-hub.git"
$RepoGitee  = "https://gitee.com/lt17210720082/claude-session-hub.git"

# ---------- 0. account mode ----------
Step "Choosing account mode"
$UseGateway = $false
if ($Token) {
  if ($Token -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Token must be exactly 64 hex characters (got length $($Token.Length)). Check for missing/extra characters, or drop -Token to use your own accounts."
  }
  $UseGateway = $true
  Ok "team gateway mode (token format looks good)"
} else {
  Ok "own-account mode (no -Token): the Hub installs fully, you sign in to Claude / Codex on first use"
}

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

# ---------- 3. get Hub source (local copy > existing clone > git clone) ----------
function Test-HubRepo([string]$p) {
  return ($p -and (Test-Path "$p\package.json") -and (Test-Path "$p\main.js") -and (Test-Path "$p\core"))
}

# Where is this script? If it sits inside an already-downloaded Hub repo
# (e.g. an extracted GitHub/Gitee zip), use that as the source - no network.
$selfDir = $PSScriptRoot
if (-not $selfDir) { $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $LocalSource -and (Test-HubRepo $selfDir)) { $LocalSource = $selfDir }

if ($LocalSource) {
  Step "Getting Hub source -> using local copy (offline, no git clone)"
  if (-not (Test-HubRepo $LocalSource)) {
    Fail "LocalSource '$LocalSource' is not the Hub repo (missing package.json / main.js / core)."
  }
  $srcFull = (Resolve-Path $LocalSource).Path
  if (-not $PSBoundParameters.ContainsKey('HubDir')) { $HubDir = $srcFull }  # install in place
  $dstFull = $HubDir
  try { $dstFull = (Resolve-Path $HubDir -ErrorAction Stop).Path } catch {}
  if ($srcFull -ne $dstFull) {
    Write-Host "    copying source $srcFull -> $HubDir (excluding node_modules/.git) ..."
    robocopy $srcFull $HubDir /E /XD node_modules .git /XF "*.log" /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { Fail "copy from LocalSource failed (robocopy exit $LASTEXITCODE)." }
  }
  Ok "using local source ($HubDir)"
} elseif (Test-Path "$HubDir\.git") {
  Step "Getting Hub source -> updating existing clone at $HubDir"
  Push-Location $HubDir
  # An older install may point at the Gitee mirror, which can be weeks behind.
  # Re-point it at GitHub before pulling, otherwise "update" silently keeps the
  # stale code.
  $originUrl = (git remote get-url origin 2>$null)
  if ($LASTEXITCODE -eq 0 -and $originUrl -and $originUrl -match 'gitee\.com') {
    Write-Host "    origin points at the Gitee mirror; re-pointing at GitHub (source of truth)..."
    git remote set-url origin $RepoGitHub
  }
  git pull origin master
  if ($LASTEXITCODE -ne 0) { Pop-Location; Fail "git pull failed. Check network then re-run." }
  Pop-Location
  Ok "updated existing clone"
} else {
  Step "Getting Hub source -> $HubDir (git clone)"
  # GitHub first: it is the branch the maintainer actually pushes to. Gitee is
  # a fallback for networks that cannot reach GitHub at all, and it may be old.
  $mirrors = @($RepoGitHub, $RepoGitee)
  $cloned = $false
  foreach ($m in $mirrors) {
    Write-Host "    trying $m ..."
    git clone $m $HubDir
    if ($LASTEXITCODE -eq 0) {
      $cloned = $true
      Ok "cloned from $m"
      if ($m -eq $RepoGitee) {
        Warn "cloned from the Gitee mirror - it can lag behind GitHub. Check the version in the Hub window title and tell your admin if it looks old."
      }
      break
    }
    Write-Host "    (that mirror failed, trying next)" -ForegroundColor Yellow
    if (Test-Path $HubDir) { Remove-Item -Recurse -Force $HubDir -ErrorAction SilentlyContinue }
  }
  if (-not $cloned) {
    Fail "git clone failed from all mirrors (GitHub + Gitee). If your network blocks git, download the repo zip manually and run setup.ps1 from inside the extracted folder (offline mode)."
  }
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

# ---------- 6. write gateway config (only in gateway mode) ----------
# The key names below are a contract with core/hub-config.js: it reads
# providers.claude.{backend,api_key,base_url,model} and the matching
# providers.codex.* keys. Anything written under a different key is silently
# ignored by the Hub, which is exactly how the old providers.meridian block
# ended up doing nothing. tests/unit-setup-config-contract.test.js runs this
# very snippet and asserts the Hub reads it back - keep them in sync.
if ($UseGateway) {
  Step "Writing gateway config -> $DataDir\config.json"
  # Write the merge logic to a temp .js file (avoids node -e quoting/BOM mangling).
  $mergeJs = @'
const fs = require("fs"), path = require("path");
const [cfgPath, url, token, claudeModel, codexModel] = process.argv.slice(2);
let cfg = {};
try {
  let raw = fs.readFileSync(cfgPath, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  cfg = JSON.parse(raw);
} catch (e) {}
const base = url.replace(/\/+$/, "");
cfg.providers = cfg.providers || {};
// Provenance only - the Hub does not read this block.
cfg.providers.meridian = { url: url, enabled: true };
const cl = cfg.providers.claude || {};
cl.backend = "api";
cl.base_url = base;
cl.api_key = token;
if (claudeModel) cl.model = claudeModel;
cfg.providers.claude = cl;
const cx = cfg.providers.codex || {};
cx.backend = "api";
cx.base_url = base + "/codex/v1";
cx.api_key = token;
if (codexModel) cx.model = codexModel;
cx.provider = "meridian";
cfg.providers.codex = cx;
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log("written: " + cfgPath);
'@
  $mergeJsPath = Join-Path $env:TEMP "hub-merge-config.js"
  [System.IO.File]::WriteAllText($mergeJsPath, $mergeJs, (New-Object System.Text.UTF8Encoding($false)))
  node $mergeJsPath "$DataDir\config.json" $MeridianUrl $Token $ClaudeModel $CodexModel
  if ($LASTEXITCODE -ne 0) { Fail "failed to write config.json" }
  Remove-Item $mergeJsPath -ErrorAction SilentlyContinue
  Ok "Claude ($ClaudeModel) and Codex ($CodexModel) both pointed at the team gateway"
} else {
  Step "Skipping gateway config (own-account mode)"
  Ok "config.json left untouched - sign in to your own accounts inside the Hub"
}

# ---------- 7. gateway probe (warn-only) ----------
# Deliberately never fatal: a gateway that is down or unreachable from this
# network must not stop a perfectly good Hub install. The user can always fall
# back to their own account, and re-running this script later re-applies config.
if ($UseGateway -and -not $SkipHealthCheck) {
  Step "Probing gateway + token (informational)"
  $reachable = $false
  try {
    $h = Invoke-WebRequest -UseBasicParsing -Uri "$MeridianUrl/healthz" -TimeoutSec 20
    Ok "endpoint reachable (healthz $($h.StatusCode))"
    $reachable = $true
  } catch {
    Warn "cannot reach $MeridianUrl ($($_.Exception.Message))."
    Warn "Install continues. If the gateway stays down, sign in to your own Claude / Codex account in the Hub instead."
  }
  if ($reachable) {
    try {
      $body = "{`"model`":`"$ClaudeModel`",`"max_tokens`":1,`"messages`":[{`"role`":`"user`",`"content`":`"ping`"}]}"
      $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$MeridianUrl/v1/messages" `
        -Headers @{ "Authorization" = "Bearer $Token"; "anthropic-version" = "2023-06-01" } `
        -ContentType "application/json" -Body $body -TimeoutSec 120
      Ok "token accepted, Claude responded (HTTP $($r.StatusCode))"
    } catch {
      $code = ""
      try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      if ($code -eq 401 -or $code -eq 403) {
        Warn "token REJECTED (HTTP $code) - ask your admin to verify/reissue it. Install continues; the Hub will not be able to use the gateway until the token works."
      } else {
        Warn "token check inconclusive (HTTP $code $($_.Exception.Message)). Install continues."
      }
    }
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
  Warn "shortcut creation failed ($($_.Exception.Message)) - not fatal"
}

$installedVersion = "unknown"
try { $installedVersion = (Get-Content "$HubDir\package.json" -Raw | ConvertFrom-Json).version } catch {}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " SETUP COMPLETE" -ForegroundColor Green
Write-Host "   Version -> v$installedVersion (the Hub window title shows this too)"
if ($UseGateway) {
  Write-Host "   Claude  -> team gateway ($ClaudeModel)"
  Write-Host "   Codex   -> team gateway ($CodexModel)"
  Write-Host "   If the gateway probe warned above, sign in to your own account instead."
} else {
  Write-Host "   Claude  -> your own account (sign in on first use inside the Hub)"
  Write-Host "   Codex   -> your own account (sign in on first use inside the Hub)"
}
Write-Host "   Launch  -> double-click 'AI Hub' on Desktop, or:"
Write-Host "     & `"$HubDir\node_modules\electron\dist\electron.exe`" `"$HubDir`""
Write-Host "   Try it  -> click '+ New' -> 'Claude Code' -> type anything"
Write-Host "   Guide   -> $HubDir\docs\team-onboarding.md (first 5 minutes)"
Write-Host "============================================================" -ForegroundColor Green

if (-not $NoLaunch) {
  Step "Launching Hub"
  Start-Process -FilePath "$HubDir\node_modules\electron\dist\electron.exe" -ArgumentList "`"$HubDir`"" -WorkingDirectory $HubDir
  Ok "Hub window should appear in a few seconds"
}
