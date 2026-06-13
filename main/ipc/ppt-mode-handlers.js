// PPT 模式（2026-06-11 道雪）：管理 oneclick PPT 生成服务（python FastAPI :8765）生命周期。
// 渲染层 ppt-mode.js 通过 'ppt-mode-ensure-server' 拿到可用 URL 后用 webview 内嵌。
// 服务脚本默认指向 ppt-assistant/oneclick，可用 env CLAUDE_HUB_PPT_SERVER 覆盖。
const { spawn } = require('child_process');
const http = require('http');

const PPT_PORT = 8765;
const PPT_URL = `http://127.0.0.1:${PPT_PORT}`;
const SERVER_SCRIPT = process.env.CLAUDE_HUB_PPT_SERVER ||
  'C:\\Users\\lintian\\ppt-assistant\\oneclick\\server.py';

let child = null; // 仅记录由 Hub spawn 的进程；外部已起的 server 不归 Hub 管

function ping(timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(`${PPT_URL}/api/templates`, { timeout: timeoutMs }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function ensureServer() {
  if (await ping()) return { url: PPT_URL, spawned: false };
  if (!child) {
    try {
      child = spawn('python', ['-u', SERVER_SCRIPT], { stdio: 'ignore', windowsHide: true });
      child.on('exit', () => { child = null; });
      child.on('error', () => { child = null; });
    } catch (err) {
      return { url: PPT_URL, error: `spawn python 失败: ${err.message}` };
    }
  }
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 1000));
    if (await ping()) return { url: PPT_URL, spawned: true };
  }
  return { url: PPT_URL, error: `PPT server 30s 未就绪, 检查 python 与 ${SERVER_SCRIPT}` };
}

function registerPptModeIpc(ipcMain) {
  ipcMain.handle('ppt-mode-ensure-server', () => ensureServer());
}

// Hub 退出时只回收自己 spawn 的 server，外部启动的不动
function killPptServer() {
  if (child) {
    try { child.kill(); } catch (_) { /* 已退出 */ }
    child = null;
  }
}

module.exports = { registerPptModeIpc, killPptServer };
