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

# core/data-dir.js reads CLAUDE_HUB_DATA_DIR, falling back to
# ~/.claude-session-hub. So a custom -DataDir is only real if every later step
# - the suggested fallback command, the launch, the desktop shortcut - carries
# it along. Otherwise the installer writes A and the Hub reads B.
$DefaultDataDir = Join-Path $env:USERPROFILE ".claude-session-hub"
$IsCustomDataDir = ($DataDir.TrimEnd('\') -ne $DefaultDataDir.TrimEnd('\'))

# Quoted so paths with spaces can be pasted straight into a shell.
function Get-SetupCommand([string]$extraArgs) {
  $cmd = "powershell -ExecutionPolicy Bypass -File `"$HubDir\setup.ps1`" $extraArgs"
  if ($IsCustomDataDir) { $cmd += " -DataDir `"$DataDir`"" }
  return $cmd
}

# One small node tool with three subcommands, rather than three separate
# snippets that each re-implement reading and writing config.json. The key
# names are a contract with core/hub-config.js, which reads
# providers.claude.{backend,api_key,base_url,model} and the matching
# providers.codex.* keys. Anything written under a different key is silently
# ignored by the Hub - exactly how the old providers.meridian block ended up
# doing nothing. tests/unit-setup-config-contract.test.js runs this very tool
# and asserts the Hub reads it back; keep them in sync.
#
# Read/write rules, learned the hard way (core/hub-config.js's
# readConfigJsonForUpdate carries the same warning, and this script violated it
# anyway until Codex 2's round-2 review caught it):
#   - ENOENT is the ONLY condition that may be treated as "empty config". It
#     means first install.
#   - A parse error, a read error or a non-object root must ABORT with a
#     non-zero exit and leave the file byte-for-byte untouched. Swallowing the
#     error and writing `{}` back silently destroys whatever the user had, and
#     the installer cheerfully prints SETUP COMPLETE on top of it.
#   - Writes go through a validated temp file + atomic rename, with a .backup
#     copy of the previous contents, so an interrupted write cannot truncate a
#     good config either.
$JsConfigTool = @'
const fs = require("fs"), path = require("path");

function readConfig(cfgPath) {
  let raw;
  try {
    raw = fs.readFileSync(cfgPath, "utf8");
  } catch (e) {
    // First install is the only case where "no config" is a valid start.
    if (e.code === "ENOENT") return {};
    throw new Error("cannot read " + cfgPath + " (" + e.message + "). Nothing was written.");
  }
  if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
  if (!raw.trim()) return {};
  let cfg;
  try {
    cfg = JSON.parse(raw);
  } catch (e) {
    throw new Error(cfgPath + " is not valid JSON (" + e.message
      + "). Nothing was written - fix or move that file, then re-run.");
  }
  if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) {
    throw new Error(cfgPath + " does not contain a JSON object. Nothing was written.");
  }
  return cfg;
}

// Every slot we are about to write into must really be a plain object.
// Validating only the root is not enough: JS is not in strict mode here, so
// assigning a property to a string silently does nothing, and properties added
// to an array are dropped by JSON.stringify. Either way write-gateway used to
// print "written" while the Hub ended up with no usable config at all.
//
// undefined / null both mean "never configured" and are initialised - neither
// carries user data, so nothing can be lost. Arrays, strings, numbers and
// booleans are corruption: abort and leave the file alone.
function requireObjectSlot(parent, key, cfgPath, label) {
  const value = parent[key];
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(cfgPath + ": " + label + " must be a JSON object, found "
      + (Array.isArray(value) ? "an array" : typeof value)
      + ". Nothing was written - fix or move that file, then re-run.");
  }
  return value;
}

function writeConfig(cfgPath, cfg) {
  const json = JSON.stringify(cfg, null, 2);
  JSON.parse(json); // never hand out something we cannot read back
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  if (fs.existsSync(cfgPath)) fs.copyFileSync(cfgPath, cfgPath + ".backup");
  const tmp = cfgPath + ".tmp-" + process.pid;
  fs.writeFileSync(tmp, json, "utf8");
  fs.renameSync(tmp, cfgPath);
}

const [cmd, cfgPath, ...rest] = process.argv.slice(2);

if (cmd === "read-mode") {
  // Display only: never fatal, but an unreadable config must show up as
  // unknown rather than quietly as "your own account".
  let claude, codex;
  try {
    const cfg = readConfig(cfgPath);
    const providers = requireObjectSlot(cfg, "providers", cfgPath, "providers");
    claude = requireObjectSlot(providers, "claude", cfgPath, "providers.claude");
    codex = requireObjectSlot(providers, "codex", cfgPath, "providers.codex");
  } catch (e) {
    console.log(JSON.stringify({ error: e.message }));
    process.exit(0);
  }
  // core/session-manager.js: backend must be "api" AND a key must exist.
  const one = (v) => ({ api: v.backend === "api" && !!v.api_key, baseUrl: v.base_url || "", model: v.model || "" });
  console.log(JSON.stringify({ claude: one(claude), codex: one(codex) }));
  process.exit(0);
}

const cfg = readConfig(cfgPath);

if (cmd === "write-gateway") {
  const [url, token, claudeModel, codexModel] = rest;
  const base = url.replace(/\/+$/, "");
  // Validate the whole path we are about to write through, before touching
  // anything - otherwise half of it lands and the script still reports success.
  const providers = requireObjectSlot(cfg, "providers", cfgPath, "providers");
  const cl = requireObjectSlot(providers, "claude", cfgPath, "providers.claude");
  const cx = requireObjectSlot(providers, "codex", cfgPath, "providers.codex");
  cfg.providers = providers;
  // Provenance only - the Hub does not read this block.
  providers.meridian = { url: url, enabled: true };
  cl.backend = "api";
  cl.base_url = base;
  cl.api_key = token;
  if (claudeModel) cl.model = claudeModel;
  providers.claude = cl;
  cx.backend = "api";
  cx.base_url = base + "/codex/v1";
  cx.api_key = token;
  if (codexModel) cx.model = codexModel;
  cx.provider = "meridian";
  providers.codex = cx;
  writeConfig(cfgPath, cfg);
  console.log("written: " + cfgPath);
  process.exit(0);
}

if (cmd === "use-own-account") {
  // Keeps base_url / api_key in place so the gateway can be re-enabled later
  // without re-issuing anything - only the backend switch moves.
  const providers = requireObjectSlot(cfg, "providers", cfgPath, "providers");
  const slots = {
    claude: requireObjectSlot(providers, "claude", cfgPath, "providers.claude"),
    codex: requireObjectSlot(providers, "codex", cfgPath, "providers.codex"),
  };
  cfg.providers = providers;
  const changed = [];
  for (const k of ["claude", "codex"]) {
    if (slots[k].backend === "api") { slots[k].backend = "subscription"; changed.push(k); }
  }
  writeConfig(cfgPath, cfg);
  console.log(changed.length ? "switched: " + changed.join(",") : "switched: none");
  process.exit(0);
}

throw new Error("unknown subcommand: " + cmd);
'@

function Invoke-ConfigTool([string[]]$toolArgs) {
  return Invoke-NodeSnippet "hub-config-tool.js" $JsConfigTool $toolArgs
}

function Get-HubAccountMode {
  try {
    $raw = Invoke-ConfigTool @("read-mode", $ConfigPath)
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch { return $null }
}

function Show-AccountMode([object]$mode, [string]$prefix = "    ") {
  if (-not $mode) { Write-Host "$prefix(could not read $ConfigPath)" -ForegroundColor Yellow; return }
  if ($mode.error) {
    Write-Host "$prefixUNKNOWN - $($mode.error)" -ForegroundColor Yellow
    return
  }
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
  $written = Invoke-ConfigTool @("write-gateway", $ConfigPath, $MeridianUrl, $Token, $ClaudeModel, $CodexModel)
  # The tool aborts without touching the file when the existing config.json is
  # unreadable. Never paper over that with a green line.
  if ($LASTEXITCODE -ne 0) { Fail "could not write $ConfigPath - see the error above. Your existing file was left untouched." }
  Ok "Claude ($ClaudeModel) and Codex ($CodexModel) both pointed at the team gateway"
} elseif ($UseOwnAccount) {
  Step "Switching Claude / Codex back to your own account -> $ConfigPath"
  $switched = Invoke-ConfigTool @("use-own-account", $ConfigPath)
  if ($LASTEXITCODE -ne 0) { Fail "could not update $ConfigPath - see the error above. Your existing file was left untouched." }
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
    Warn "  $(Get-SetupCommand '-UseOwnAccount')"
    Warn "(That only flips the backend switch; the gateway url/key stay on disk.)"
  }
}

# ---------- 8. desktop shortcut + launch ----------
$ElectronExe = "$HubDir\node_modules\electron\dist\electron.exe"

# A .lnk cannot carry an environment variable, so a custom data dir needs a
# tiny launcher in between. The default install keeps pointing straight at
# electron.exe: no stray console window, and ~/.claude-session-hub is exactly
# what the Hub falls back to anyway.
#
# The launcher is PowerShell, not a .cmd, because it has to carry file paths
# verbatim. A .cmd is interpreted in the console's code page, and the first
# version of this wrote it as ASCII outright - a data directory named
# `data-中文资料` came back as `data-????`, so double-clicking the desktop
# icon opened the Hub against a directory that does not exist. A UTF-8 .ps1
# with a BOM is decoded correctly regardless of code page, and the .lnk fields
# that point at it are Unicode to begin with.
$LauncherPath = Join-Path $HubDir "launch-hub.ps1"
# Single-quoted PowerShell literals: only ' needs escaping, and no $ or
# backtick in a path can be interpreted.
function Quote-PsLiteral([string]$s) { return "'" + $s.Replace("'", "''") + "'" }

if ($IsCustomDataDir) {
  Step "Writing launcher for custom data dir -> $LauncherPath"
  $launcher = @(
    '# Generated by setup.ps1 - starts the Hub against the data directory this',
    '# machine was installed with. Changing the path here changes where the Hub',
    '# keeps its sessions and config.',
    "`$env:CLAUDE_HUB_DATA_DIR = $(Quote-PsLiteral $DataDir)",
    "Start-Process -FilePath $(Quote-PsLiteral $ElectronExe) -ArgumentList $(Quote-PsLiteral $HubDir) -WorkingDirectory $(Quote-PsLiteral $HubDir)"
  ) -join "`r`n"
  # UTF8Encoding($true) = with BOM, so PowerShell decodes it as UTF-8 on any
  # locale instead of guessing the ANSI code page.
  [System.IO.File]::WriteAllText($LauncherPath, $launcher + "`r`n", (New-Object System.Text.UTF8Encoding($true)))
  Ok "launcher written (data dir $DataDir)"
}

# WScript.Shell cannot be used here. Its IWshShortcut::Save goes through ANSI,
# so on a machine whose user name contains non-ANSI characters it fails outright
# with `Unable to save shortcut "...\?? ??\Desktop\AI Hub.lnk"` - the path is
# already mangled in the error message. That hits any teammate whose Windows
# account is named in Chinese, and it only warns, so the install still claims
# success while leaving no desktop icon. IShellLinkW + IPersistFile::Save are
# Unicode all the way.
$ShellLinkSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

[ComImport, Guid("00021401-0000-0000-C000-000000000046")]
internal class ShellLinkCoClass { }

[ComImport, Guid("000214F9-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IShellLinkW {
  void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cch, IntPtr pfd, int fFlags);
  void GetIDList(out IntPtr ppidl);
  void SetIDList(IntPtr pidl);
  void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cch);
  void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
  void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cch);
  void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
  void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cch);
  void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
  void GetHotkey(out short pwHotkey);
  void SetHotkey(short wHotkey);
  void GetShowCmd(out int piShowCmd);
  void SetShowCmd(int iShowCmd);
  void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cch, out int piIcon);
  void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
  void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
  void Resolve(IntPtr hwnd, int fFlags);
  void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
}

[ComImport, Guid("0000010b-0000-0000-C000-000000000046"),
 InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
internal interface IPersistFile {
  void GetClassID(out Guid pClassID);
  [PreserveSig] int IsDirty();
  void Load([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, int dwMode);
  void Save([MarshalAs(UnmanagedType.LPWStr)] string pszFileName, [MarshalAs(UnmanagedType.Bool)] bool fRemember);
  void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string pszFileName);
  void GetCurFile([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder ppszFileName);
}

public static class HubShortcut {
  public static void Create(string lnkPath, string target, string args, string workDir, int showCmd) {
    IShellLinkW link = (IShellLinkW)new ShellLinkCoClass();
    link.SetPath(target);
    if (!String.IsNullOrEmpty(args)) link.SetArguments(args);
    if (!String.IsNullOrEmpty(workDir)) link.SetWorkingDirectory(workDir);
    link.SetShowCmd(showCmd);
    ((IPersistFile)link).Save(lnkPath, true);
  }
}
'@

Step "Creating desktop shortcut"
try {
  if (-not ("HubShortcut" -as [type])) { Add-Type -TypeDefinition $ShellLinkSource -ErrorAction Stop }
  $lnkPath = Join-Path $env:USERPROFILE "Desktop\AI Hub.lnk"
  if ($IsCustomDataDir) {
    # -WindowStyle Hidden keeps the console out of sight; SW_SHOWMINNOACTIVE (7)
    # avoids a flash even before PowerShell gets that far.
    [HubShortcut]::Create($lnkPath, (Get-Command powershell.exe).Source,
      "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$LauncherPath`"", $HubDir, 7)
  } else {
    [HubShortcut]::Create($lnkPath, $ElectronExe, "`"$HubDir`"", $HubDir, 1)
  }
  if (-not (Test-Path $lnkPath)) { throw "shortcut file was not created at $lnkPath" }
  Ok "Desktop\AI Hub.lnk"
} catch {
  Warn "shortcut creation failed ($($_.Exception.Message)) - not fatal"
  if ($IsCustomDataDir) {
    Warn "start the Hub with: powershell -NoProfile -ExecutionPolicy Bypass -File `"$LauncherPath`""
  } else {
    Warn "start the Hub with: & `"$ElectronExe`" `"$HubDir`""
  }
}

$installedVersion = "unknown"
try { $installedVersion = (Get-Content "$HubDir\package.json" -Raw | ConvertFrom-Json).version } catch {}

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " SETUP COMPLETE" -ForegroundColor Green
Write-Host "   Version -> v$installedVersion (the Hub window title shows this too)"
Write-Host "   Data    -> $DataDir"
Write-Host "   Accounts (read back from $ConfigPath):"
Show-AccountMode (Get-HubAccountMode) "     "
Write-Host "   Launch  -> double-click 'AI Hub' on Desktop, or:"
if ($IsCustomDataDir) {
  # Must set the variable too, otherwise this command silently starts the Hub
  # against the default directory instead of the one just configured.
  Write-Host "     `$env:CLAUDE_HUB_DATA_DIR = `"$DataDir`"; & `"$ElectronExe`" `"$HubDir`""
  Write-Host "     (the desktop icon runs $LauncherPath, which does the same)"
} else {
  Write-Host "     & `"$ElectronExe`" `"$HubDir`""
}
Write-Host "   Switch  -> $(Get-SetupCommand '-UseOwnAccount')"
Write-Host "   Try it  -> click 'New session' -> 'Claude Code' -> type anything"
Write-Host "   Guide   -> $HubDir\docs\team-onboarding.md (first 5 minutes)"
Write-Host "============================================================" -ForegroundColor Green

if (-not $NoLaunch) {
  Step "Launching Hub"
  # Set it explicitly rather than trusting whatever the caller happened to
  # have: this install has a data directory and the Hub must use that one.
  $env:CLAUDE_HUB_DATA_DIR = $DataDir
  Start-Process -FilePath $ElectronExe -ArgumentList "`"$HubDir`"" -WorkingDirectory $HubDir
  Ok "Hub window should appear in a few seconds (data dir $DataDir)"
}
