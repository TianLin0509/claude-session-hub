// tests/helpers/hub-launcher.js
//
// 安全启动隔离 Hub 实例 + CDP 控制 + 优雅关闭。
//
// 铁律（feedback_e2e_pid_whitelist.md / feedback_hub_isolation_env_pitfall.md）：
//   - PID 白名单：spawn 时拿 child.pid，关闭只针对这个 PID + 通过 CDP Browser.close
//   - 严禁 Get-Process electron / 时间窗口 PID 推断
//   - 严禁 Start-Process（不继承 env）；用 child_process.spawn 直接传 env
//   - 隔离数据目录：CLAUDE_HUB_DATA_DIR 必须设
//
// 用法：
//   const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
//   const hub = await launchIsolatedHub({ dataDir, port });
//   // ...do CDP work via hub.cdpUrl...
//   await gracefulQuit(hub);

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const HUB_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_EXE = path.join(HUB_ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

function _waitMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function _httpGetJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve(null); } });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function _waitForCDP(port, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ver = await _httpGetJson(`http://127.0.0.1:${port}/json/version`);
    if (ver && ver.webSocketDebuggerUrl) return ver;
    await _waitMs(300);
  }
  return null;
}

async function launchIsolatedHub({ dataDir, port, label = 'hub', extraEnv = {} } = {}) {
  if (!dataDir) throw new Error('dataDir required');
  if (!port) throw new Error('port required');

  fs.mkdirSync(dataDir, { recursive: true });

  const env = {
    ...process.env,
    CLAUDE_HUB_DATA_DIR: dataDir,
    ...extraEnv,
  };

  const args = [HUB_ROOT, `--remote-debugging-port=${port}`];
  // 关键：spawn 立即拿 PID，detached:false 让 child 跟随 parent 退出
  const child = spawn(ELECTRON_EXE, args, {
    env,
    cwd: HUB_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });

  const pid = child.pid;
  if (!pid) throw new Error(`[${label}] spawn failed, no PID`);

  const logLines = [];
  child.stdout.on('data', d => {
    const s = d.toString();
    logLines.push(...s.split(/\r?\n/).filter(Boolean));
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  });
  child.stderr.on('data', d => {
    const s = d.toString();
    logLines.push(...s.split(/\r?\n/).filter(Boolean));
    if (logLines.length > 500) logLines.splice(0, logLines.length - 500);
  });

  let exited = false;
  let exitCode = null;
  child.on('exit', (code) => { exited = true; exitCode = code; });

  // 等 CDP ready (最长 30s)
  const ver = await _waitForCDP(port, 30000);
  if (exited) {
    const err = new Error(`[${label}] hub exited before CDP ready (code=${exitCode})`);
    err.logTail = logLines.slice(-30).join('\n');
    throw err;
  }
  if (!ver) {
    // CDP 没 ready；force kill ONLY this PID
    try { process.kill(pid); } catch {}
    const err = new Error(`[${label}] CDP not ready within 30s`);
    err.logTail = logLines.slice(-30).join('\n');
    throw err;
  }

  return {
    pid,
    port,
    label,
    dataDir,
    cdpUrl: ver.webSocketDebuggerUrl,
    cdpHttpBase: `http://127.0.0.1:${port}`,
    child,
    log: () => logLines.slice(),
    isAlive: () => !exited,
    exitCode: () => exitCode,
  };
}

// 通过 CDP 优雅关闭 — 不依赖 process.kill，避免 PID 误杀。
//   先尝试 Browser.close（Chromium/Electron 全关）；timeoutMs 内没退出再 SIGTERM。
async function gracefulQuit(hub, { timeoutMs = 8000 } = {}) {
  if (!hub) return;
  if (hub.child && hub.child.exitCode != null) return;  // 已退出
  // CDP Browser.close
  try {
    const targets = await _httpGetJson(`${hub.cdpHttpBase}/json/list`);
    if (Array.isArray(targets) && targets.length > 0) {
      // 走 page target 的 webSocket 发 Browser.close —— 但 ws 协议得用 ws lib，
      // 这里复用 puppeteer-core 的可能在没装的环境失败。简单做法：直接用 PUT API
      //   POST /json/close/<id> — 适用于 page，能让 page 关掉。
      //   主进程会因为 window-all-closed 触发 app.quit() → before-quit → 持久化 flush
      for (const t of targets) {
        if (t.type === 'page' || t.type === 'browser') {
          await _httpGetJson(`${hub.cdpHttpBase}/json/close/${t.id}`).catch(() => null);
        }
      }
    }
  } catch { /* ignore */ }

  // 等待自然退出
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hub.child.exitCode != null) return;
    await _waitMs(200);
  }

  // 兜底：仅 kill 自己的 PID
  if (hub.child.exitCode == null) {
    try { hub.child.kill('SIGTERM'); } catch {}
    await _waitMs(2000);
    if (hub.child.exitCode == null) {
      try { hub.child.kill('SIGKILL'); } catch {}
      await _waitMs(1000);
    }
  }
}

// 列出 CDP 上所有 page targets（用于挑选 main window 来 attach）
async function listCdpTargets(hub) {
  return await _httpGetJson(`${hub.cdpHttpBase}/json/list`) || [];
}

module.exports = {
  launchIsolatedHub,
  gracefulQuit,
  listCdpTargets,
  _waitMs,  // 给 e2e 用
};
