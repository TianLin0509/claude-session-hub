# ============================================================
# AI Group Chat Hub - One-Click Team Setup (Windows)
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File setup.ps1                  # bring your own CLI accounts
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Token <64-hex>  # team gateway account
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -UseOwnAccount   # switch an existing install back
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
  [switch]$UseOwnAccount,
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

# Run a JS snippet through node. Kept in temp files rather than `node -e` to
# avoid PowerShell quoting/BOM mangling of the payload.
function Invoke-NodeSnippet([string]$name, [string]$source, [string[]]$nodeArgs) {
  $p = Join-Path $env:TEMP $name
  [System.IO.File]::WriteAllText($p, $source, (New-Object System.Text.UTF8Encoding($false)))
  try { return (& node $p @nodeArgs) } finally { Remove-Item $p -ErrorAction SilentlyContinue }
}

# GitHub is the source of truth. Gitee is a mirror that can lag behind, so it is
# only ever a fallback - installing a silently outdated Hub is worse than a
# visible clone failure.
$RepoGitHub = "https://github.com/TianLin0509/claude-session-hub.git"
$RepoGitee  = "https://gitee.com/lt17210720082/claude-session-hub.git"
$ConfigPath = Join-Path $DataDir "config.json"

# The key names here are a contract with core/hub-config.js, which reads
# providers.claude.{backend,api_key,base_url,model} and the matching
# providers.codex.* keys. Anything written under a different key is silently
# ignored by the Hub - exactly how the old providers.meridian block ended up
# doing nothing. tests/unit-setup-config-contract.test.js executes these very
# snippets and asserts the Hub reads them back; keep them in sync.
$JsWriteGateway = @'
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

# Flip Claude/Codex back to their own subscription login. Deliberately keeps
# base_url / api_key in place so the gateway can be re-enabled later without
# re-issuing anything - only the backend switch moves.
$JsUseOwnAccount = @'
const fs = require("fs"), path = require("path");
const cfgPath = process.argv[2];
let cfg = {};
try {
  let raw = fs.readFileSync(cfgPath, "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  cfg = JSON.parse(raw);
} catch (e) {}
cfg.providers = cfg.providers || {};
const changed = [];
for (const k of ["claude", "codex"]) {
  const p = cfg.providers[k];
  if (p && p.backend === "api") { p.backend = "subscription"; changed.push(k); }
}
fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
console.log(changed.length ? "switched: " + changed.join(",") : "switched: none");
'@

# Report what the Hub will ACTUALLY do, read back from config.json. Every
# "your account / the gateway" line printed below comes from here rather than
# from which flags were passed, so the summary cannot drift from reality.
$JsReadMode = @'
const fs = require("fs");
let cfg = {};
try {
  let raw = fs.readFileSync(process.argv[2], "utf8");
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  cfg = JSON.parse(raw);
} catch (e) {}
const providers = cfg.providers || {};
const one = (k) => {
  const v = providers[k] || {};
  // core/session-manager.js: backend must be "api" AND a key must exist.
  const api = v.backend === "api" && !!v.api_key;
  return { api, baseUrl: v.base_url || "", model: v.model || "" };
};
console.log(JSON.stringify({ claude: one("claude"), codex: one("codex") }));
'@

function Get-HubAccountMode {
  try {
    $raw = Invoke-NodeSnippet "hub-read-mode.js" $JsReadMode @($ConfigPath)
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

function Show-AccountMode([object]$mode, [string]$prefix = "    ") {
  if (-not $mode) { Write-Host "$prefix(could not read $ConfigPath)"; return }
  foreach ($cli in @(@('Claude', $mode.claude), @('Codex', $mode.codex))) {
    $name = $cli[0]; $m = $cli[1]
    if ($m.api) { Write-Host "$prefix$name  -> team gateway $($m.baseUrl)" }
    else        { Write-Host "$prefix$name  -> your own account (sign in inside the Hub)" }
  }
}

# ---------- 0. account mode ----------
Step "Choosing account mode"
$UseGateway = $false
if ($Token) {
  if ($UseOwnAccount) {
    Fail "-Token and -UseOwnAccount are opposites. Pass -Token to use the team gateway, or -UseOwnAccount to switch back to your own login."
  }
  if ($Token -notmatch '^[0-9a-fA-F]{64}$') {
    Fail "Token must be exactly 64 hex characters (got length $($Token.Length)). Check for missing/extra characters, or drop -Token to use your own accounts."
  }
  $UseGateway = $true
  Ok "team gateway mode (token format looks good)"
} elseif ($UseOwnAccount) {
  Ok "own-account mode (-UseOwnAccount): Claude / Codex will be switched back to their own login"
} else {
  Ok "no -Token: existing account settings are left as they are (shown at the end)"
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

# ---------- 3. get Hub source (existing clone > local copy > git clone) ----------
function Test-HubRepo([string]$p) {
  return ($p -and (Test-Path "$p\package.json") -and (Test-Path "$p\main.js") -and (Test-Path "$p\core"))
}
function Test-DirHasContent([string]$p) {
  if (-not (Test-Path $p)) { return $false }
  return (@(Get-ChildItem -LiteralPath $p -Force -ErrorAction SilentlyContinue).Count -gt 0)
}

$selfDir = $PSScriptRoot
if (-not $selfDir) { $selfDir = Split-Path -Parent $MyInvocation.MyCommand.Path }

# Two different things look like "the script is sitting inside the source":
#   - with .git  = a real clone. Re-running the installer there means UPDATE,
#     so it must fall through to the git-pull branch. Treating it as a local
#     copy would silently pin everyone to whatever they first installed.
#   - without .git = an extracted zip. Offline copy is the only option.
$selfIsRepo  = Test-HubRepo $selfDir
$selfIsClone = $selfIsRepo -and (Test-Path (Join-Path $selfDir ".git"))
if ($selfIsClone -and -not $PSBoundParameters.ContainsKey('HubDir')) { $HubDir = $selfDir }
if (-not $LocalSource -and $selfIsRepo -and -not $selfIsClone) { $LocalSource = $selfDir }

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
  Warn "this folder is not a git clone, so re-running setup.ps1 here cannot update it. To get new versions, either re-download the zip, or clone with git once: git clone $RepoGitHub"
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
  $before = (git rev-parse HEAD 2>$null)
  git pull origin master
  if ($LASTEXITCODE -ne 0) {
    Pop-Location
    Fail "git pull failed in $HubDir. Nothing was deleted. If you have local edits there, commit or stash them first (git status); otherwise check the network and re-run."
  }
  $after = (git rev-parse HEAD 2>$null)
  Pop-Location
  if ($before -eq $after) { Ok "already up to date ($after)" }
  else { Ok "updated $before -> $after" }
} else {
  Step "Getting Hub source -> $HubDir (git clone)"
  # Never delete something the user already had. Only a directory THIS run
  # created may be cleaned up between mirror attempts.
  if (Test-DirHasContent $HubDir) {
    Fail "$HubDir already exists and is not empty, but contains no .git clone. Nothing was deleted. Move or rename that folder, pass a different -HubDir, or - if it is an extracted source zip - run setup.ps1 from inside it."
  }
  $hubDirPreExisted = Test-Path $HubDir
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
    # Only remove a directory this run brought into existence; a pre-existing
    # empty folder is still the user's.
    if (-not $hubDirPreExisted -and (Test-Path $HubDir)) {
      Remove-Item -Recurse -Force $HubDir -ErrorAction SilentlyContinue
    }
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

# ---------- 6. account configuration ----------
if ($UseGateway) {
  Step "Writing gateway config -> $ConfigPath"
  Invoke-NodeSnippet "hub-merge-config.js" $JsWriteGateway `
    @($ConfigPath, $MeridianUrl, $Token, $ClaudeModel, $CodexModel) | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "failed to write config.json" }
  Ok "Claude ($ClaudeModel) and Codex ($CodexModel) both pointed at the team gateway"
} elseif ($UseOwnAccount) {
  Step "Switching Claude / Codex back to your own account -> $ConfigPath"
  $switched = Invoke-NodeSnippet "hub-own-account.js" $JsUseOwnAccount @($ConfigPath)
  if ($LASTEXITCODE -ne 0) { Fail "failed to update config.json" }
  Ok "$switched (gateway url/key kept on disk, so -Token can re-enable it later)"
} else {
  Step "Leaving account configuration untouched"
  Ok "no -Token given; nothing was changed in config.json"
}

# ---------- 7. gateway probe (warn-only) ----------
# Deliberately never fatal: a gateway that is down or unreachable from this
# network must not stop a perfectly good Hub install. But it must also not
# leave the user believing they are on their own account when config.json says
# otherwise - hence the explicit -UseOwnAccount instruction on failure.
if ($UseGateway -and -not $SkipHealthCheck) {
  Step "Probing gateway + token (informational)"
  $gatewayOk = $false
  $reachable = $false
  try {
    $h = Invoke-WebRequest -UseBasicParsing -Uri "$MeridianUrl/healthz" -TimeoutSec 20
    Ok "endpoint reachable (healthz $($h.StatusCode))"
    $reachable = $true
  } catch {
    Warn "cannot reach $MeridianUrl ($($_.Exception.Message))"
  }
  if ($reachable) {
    try {
      $body = "{`"model`":`"$ClaudeModel`",`"max_tokens`":1,`"messages`":[{`"role`":`"user`",`"content`":`"ping`"}]}"
      $r = Invoke-WebRequest -UseBasicParsing -Method POST -Uri "$MeridianUrl/v1/messages" `
        -Headers @{ "Authorization" = "Bearer $Token"; "anthropic-version" = "2023-06-01" } `
        -ContentType "application/json" -Body $body -TimeoutSec 120
      Ok "token accepted, Claude responded (HTTP $($r.StatusCode))"
      $gatewayOk = $true
    } catch {
      $code = ""
      try { $code = [int]$_.Exception.Response.StatusCode } catch {}
      if ($code -eq 401 -or $code -eq 403) {
        Warn "token REJECTED (HTTP $code) - ask your admin to verify/reissue it."
      } else {
        Warn "token check inconclusive (HTTP $code $($_.Exception.Message))."
      }
    }
  }
  if (-not $gatewayOk) {
    Warn "The Hub is installed and config.json still points Claude / Codex at the gateway."
    Warn "To use your own Claude / Codex login instead, run:"
    Warn "  powershell -ExecutionPolicy Bypass -File `"$HubDir\setup.ps1`" -UseOwnAccount"
    Warn "(That only flips the backend switch; the gateway url/key stay on disk.)"
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
Write-Host "   Accounts (read back from $ConfigPath):"
Show-AccountMode (Get-HubAccountMode) "     "
Write-Host "   Launch  -> double-click 'AI Hub' on Desktop, or:"
Write-Host "     & `"$HubDir\node_modules\electron\dist\electron.exe`" `"$HubDir`""
Write-Host "   Try it  -> click 'New session' -> 'Claude Code' -> type anything"
Write-Host "   Guide   -> $HubDir\docs\team-onboarding.md (first 5 minutes)"
Write-Host "============================================================" -ForegroundColor Green

if (-not $NoLaunch) {
  Step "Launching Hub"
  Start-Process -FilePath "$HubDir\node_modules\electron\dist\electron.exe" -ArgumentList "`"$HubDir`"" -WorkingDirectory $HubDir
  Ok "Hub window should appear in a few seconds"
}
