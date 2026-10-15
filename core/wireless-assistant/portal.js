'use strict';
// 无线 Tab · SuperRAN 助理读协作台用的本机接入：只调用接入包自带的 superran-proposals.py，
// Hub 自己不读、不存协作台凭据（凭据只在接入包的配置文件里，由脚本使用）。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

// 本机 SuperRAN 登记文件（superran-ready.py 维护）：主仓 root、Python、执行配置所在的接入包。
function registryPath(home = os.homedir()) { return path.join(home, '.config', 'superran', 'local-installation.json'); }

function readInstallation({ home = os.homedir(), registry = registryPath(home) } = {}) {
  let value = null;
  try { value = JSON.parse(fs.readFileSync(registry, 'utf8')); } catch { value = null; }
  const executorConfig = value?.executor_config && fs.existsSync(value.executor_config) ? value.executor_config : findKitConfig(home);
  const kitDir = executorConfig ? path.dirname(executorConfig) : null;
  let kit = null;
  try { kit = kitDir ? JSON.parse(fs.readFileSync(path.join(kitDir, 'kit.json'), 'utf8')) : null; } catch { kit = null; }
  return {
    root: value?.root && fs.existsSync(value.root) ? value.root : null,
    python: value?.python && fs.existsSync(value.python) ? value.python : 'python',
    executorConfig, kitDir,
    user: value?.executor_user || kit?.user || null,
    kitExpires: Number(kit?.expires) ? Number(kit.expires) * 1000 : null,
    site: typeof kit?.url === 'string' && /^https:\/\//.test(kit.url) ? kit.url.replace(/\/?$/, '/') : 'https://ai.lt-stockpartner.tech/superran-dev/',
    registry,
  };
}

// 登记文件缺失时，在固定目录 ~/.superran/agent-kit/<成员编号>/ 里找唯一的接入包。
function findKitConfig(home = os.homedir()) {
  const base = path.join(home, '.superran', 'agent-kit');
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(base, d.name)); } catch { return null; }
  const found = dirs.map(d => path.join(d, 'superran-proposals.json')).filter(f => fs.existsSync(f));
  return found.length === 1 ? found[0] : null;
}

// 读协作台全部提案（与网页同一份数据）。超时、脚本报错都如实抛出，由调用方显示原因。
function listProposals(install, { timeoutMs = 60000, run = execFile } = {}) {
  if (!install?.executorConfig) return Promise.reject(new Error('本机没有 SuperRAN 接入包：请在协作台复制任一提示词交给 Agent 领取一次'));
  const script = path.join(install.kitDir, 'superran-proposals.py');
  if (!fs.existsSync(script)) return Promise.reject(new Error('接入包缺少 superran-proposals.py：请重新领取接入包'));
  return new Promise((resolve, reject) => {
    run(install.python, ['-I', script, '--config', install.executorConfig, 'list'], {
      cwd: install.kitDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() || error.message;
        reject(new Error('读取协作台失败：' + detail.slice(0, 300))); return;
      }
      try {
        const value = JSON.parse(stdout);
        if (!Array.isArray(value?.proposals)) throw new Error('返回内容不是提案列表');
        resolve(value);
      } catch (parse) { reject(new Error('协作台返回无法解析：' + parse.message)); }
    });
  });
}

// v2.7.2：把「Agent 执行」的子状态写进协作台（progress renew --note），顺带续接手租约。
// 用接入包里本机会话 claim 时留下的接手凭据；脚本出错如实抛出，调用方只记日志、不影响执行。
function progress(install, id, action, note, { timeoutMs = 60000, run = execFile } = {}) {
  if (!install?.executorConfig) return Promise.reject(new Error('本机没有 SuperRAN 接入包'));
  if (!/^[0-9A-Za-z]{1,32}$/.test(String(id))) return Promise.reject(new Error('提案编号不合法'));
  const script = path.join(install.kitDir, 'superran-proposals.py');
  return new Promise((resolve, reject) => {
    run(install.python, ['-I', script, '--config', install.executorConfig, 'progress', id, '--action', action, '--note', String(note).slice(0, 900)], {
      cwd: install.kitDir, timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8',
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
    }, (error, stdout, stderr) => {
      if (error) { reject(new Error('回写执行状态失败：' + (String(stderr || '').trim().split(/\r?\n/).pop() || error.message).slice(0, 200))); return; }
      resolve(stdout);
    });
  });
}

module.exports = { progress, registryPath, readInstallation, findKitConfig, listProposals };
