'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { chatgptWebRoute } = require('./chatgpt-web-models');

function readWebConfig(env = process.env) {
  const installedRoot = 'C:\\VibeData\\CodexChatGPTWeb\\runtime';
  const root = env.CODEX_CHATGPT_WEB_HOME || (fs.existsSync(path.join(installedRoot, 'config.json')) ? installedRoot : path.join(os.homedir(), '.codex-chatgpt-web'));
  let config;
  try { config = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8')); }
  catch (error) { throw new Error(`无法读取 Codex Web GPT 配置，请打开原工具完成设置（${error.code || '配置无效'}）`); }
  if (config.host !== '127.0.0.1' || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('Codex Web GPT 本地服务地址无效');
  }
  return config;
}
function availableRoutes(config) {
  const ids = config.browserInteractionMode === 'manual'
    ? ['zero-risk', ...(config.zeroRiskProEnabled ? ['zero-risk-pro'] : [])]
    : config.solAvailable === false ? ['luna', 'think']
      : ['light', 'medium', 'high', ...(config.proAvailable ? ['extra-high', 'pro'] : [])];
  return ids.map(id => chatgptWebRoute('chatgpt-web/' + id));
}
function requireWebTools(model, env = process.env) {
  const config = readWebConfig(env);
  if (!availableRoutes(config).some(route => route.id === model)) {
    throw new Error('所选 ChatGPT 档位在当前账号或交互模式下不可用，请刷新模型列表');
  }
  if (config.mode !== 'full') {
    throw new Error('ChatGPT 本地工具尚未配置：请打开 Codex Web GPT → MCP，完成 Full MCP 并验证运行时');
  }
  return config;
}
async function webStatus(env = process.env) {
  try {
    const config = readWebConfig(env);
    let online = false;
    try {
      const response = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(3000) });
      online = response.ok;
    } catch { /* Explicit offline status is presented below and blocks launch. */ }
    return {
      ok: true, models: availableRoutes(config), online, full: config.mode === 'full',
      interactionMode: config.browserInteractionMode,
      message: !online ? 'Codex Web GPT 服务未连接，请打开原工具'
        : config.mode !== 'full' ? '本地工具待配置：请在原工具 MCP 页面完成 Full MCP 并验证运行时'
          : config.browserInteractionMode === 'manual' ? '手动模式：每轮在原工具中选择模型并发送' : 'Full MCP 已配置；本地工具运行结果以实际会话为准',
    };
  } catch (error) { return { ok: false, models: [], online: false, full: false, message: error.message }; }
}
async function openWebSettings() {
  const { shell } = require('electron');
  const launcher = process.env.CODEX_WEB_GPT_LAUNCHER_PATH || 'C:\\DevTools\\CodexWebGPT\\Start-CodexWebGPT.ps1';
  if (!fs.existsSync(launcher)) throw new Error('未找到 Codex Web GPT 启动器，请设置 CODEX_WEB_GPT_LAUNCHER_PATH');
  // A .ps1 opened via shell.openPath may open an editor. Run the installed wrapper explicitly.
  if (path.extname(launcher).toLowerCase() === '.ps1') {
    await new Promise((resolve, reject) => {
      const child = require('child_process').spawn('powershell.exe', ['-NoProfile', '-File', launcher], { windowsHide: true, stdio: 'ignore' });
      child.once('error', reject);
      child.once('exit', code => code === 0 ? resolve() : reject(new Error(`启动器退出：${code}`)));
    });
  } else {
    const error = await shell.openPath(launcher);
    if (error) throw new Error(error);
  }
  return { ok: true };
}
module.exports = { readWebConfig, availableRoutes, requireWebTools, webStatus, openWebSettings };
