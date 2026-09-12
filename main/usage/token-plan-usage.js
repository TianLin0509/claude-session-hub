'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

function parseTokenPlanUsage(text, observedAt) {
  let raw;
  try { raw = JSON.parse(text); } catch { throw new Error('百炼返回的用量数据无法解析'); }
  const ratio = raw?.per1WeekPercentage;
  if (typeof ratio !== 'number' || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new Error('百炼未返回有效的周额度，请在控制台核实套餐');
  }
  const reset = raw.per1WeekResetTime;
  return { usage7d: { pct: ratio * 100,
    resetsAt: Number.isFinite(reset) && reset > 0 && reset < 8.64e15 ? reset : null },
  observedAt, source: 'bailian-cli', profileLabel: '百炼中国站 · 当前 CLI 账号' };
}

// Only the official read-only usage command is executable here. No model/MCP calls.
function createTokenPlanUsageService({
  configDir = process.env.BAILIAN_CONFIG_DIR || path.join(os.homedir(), '.bailian'),
  cliPath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs'),
  nodePath = process.execPath, env = process.env, now = Date.now, execute = execFile,
} = {}) {
  let scope = null, value = null, error = null, lastAttempt = -Infinity, blocked = false, flight = null;
  function currentScope() {
    let content;
    try { content = fs.readFileSync(path.join(configDir, 'config.json')); }
    catch (e) { content = Buffer.from(e.code || 'unreadable'); }
    return crypto.createHash('sha256').update(configDir).update(content).digest('hex');
  }
  function syncScope() {
    const next = currentScope();
    if (next !== scope) {
      scope = next; value = null; error = null; blocked = false; lastAttempt = -Infinity;
    }
    return scope;
  }
  function snapshot() {
    syncScope();
    return { ...value, scopeKey: scope, error, unavailable: !value,
      needsLogin: blocked, observedAt: value?.observedAt || 0 };
  }
  function refresh(force = false) {
    const requestedScope = syncScope();
    if (flight) return flight;
    if ((!force && blocked) || now() - lastAttempt < (force ? 30000 : 300000)) {
      return error ? Promise.reject(new Error(error)) : Promise.resolve(snapshot());
    }
    lastAttempt = now();
    flight = new Promise((resolve, reject) => {
      execute(nodePath, [cliPath, 'usage', 'token-plan', '--output', 'json',
        '--console-region', 'cn-beijing', '--console-site', 'domestic', '--timeout', '15'], {
        windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024,
        env: { ...env, ELECTRON_RUN_AS_NODE: '1', BAILIAN_CONFIG_DIR: configDir },
      }, (failure, stdout) => {
        if (syncScope() !== requestedScope) { reject(new Error('百炼账号配置已切换，请重新刷新')); return; }
        try {
          if (failure) {
            blocked = failure.code === 3;
            // Never expose raw stderr/command errors, which can contain credentials.
            throw new Error(blocked ? '需登录百炼：bl auth login --console'
              : !fs.existsSync(cliPath) ? '未找到百炼 CLI，请安装 bailian-cli'
                : failure.killed ? '百炼用量查询超时，保留上次数据' : '百炼用量查询失败，保留上次数据');
          }
          value = { ...parseTokenPlanUsage(stdout, now()), scopeKey: scope };
          error = null; blocked = false;
          resolve(snapshot());
        } catch (e) { error = e.message; reject(e); }
      });
    }).finally(() => { flight = null; });
    return flight;
  }
  return { snapshot, refresh };
}

module.exports = { parseTokenPlanUsage, createTokenPlanUsageService };
