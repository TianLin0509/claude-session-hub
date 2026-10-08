'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { sendToPty } = require('../../core/group-chat-watcher.js');

const BRIDGE_TIMEOUT_MS = 5 * 60 * 1000;
const BRIDGE_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const BRIDGE_MAX_INPUT_BYTES = 1024 * 1024;

function resolveChatgptBridgeRuntime({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const pythonCandidates = [
    env.CHATGPT_BRIDGE_PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
  ].filter(Boolean);
  const bridgeCandidates = [
    env.CHATGPT_BRIDGE_SCRIPT,
    path.join(homeDir, 'tools', 'chatgpt_bridge', 'bridge.py'),
  ].filter(Boolean);
  const pythonPath = pythonCandidates.find(candidate => existsSync(candidate));
  const bridgePath = bridgeCandidates.find(candidate => existsSync(candidate));
  if (!pythonPath) return { error: '未找到 ChatGPT 中转所需的 Python。', code: 'python_missing' };
  if (!bridgePath) return { error: '未找到 ChatGPT 中转工具。', code: 'bridge_missing' };
  return { pythonPath, bridgePath };
}

// 公司文字通道（拉取 / 同步文字到公司）。2026-10-07 起默认走阿里云公司收件箱
// （company-drop 的 company_relay.py：公司网页提交纯文字，本机经受限 SFTP 取走），
// 不再依赖 ChatGPT 网页。命令与 JSON 输出与 bridge.py 一致，可随时切回：
//   AI_HUB_COMPANY_TEXT_BACKEND=chatgpt  强制走 ChatGPT 中转
//   AI_HUB_COMPANY_TEXT_BACKEND=relay    强制走公司收件箱（缺文件时报错，不静默换通道）
// 未设置时：有 company_relay.py 用它，否则用 bridge.py。
// 文件管理器的「发送到 ChatGPT：准备附件」仍用 resolveChatgptBridgeRuntime，不受影响。
function resolveCompanyTextRuntime({
  env = process.env,
  homeDir = os.homedir(),
  existsSync = fs.existsSync,
} = {}) {
  const wanted = String(env.AI_HUB_COMPANY_TEXT_BACKEND || '').trim().toLowerCase();
  const chatgpt = () => {
    const runtime = resolveChatgptBridgeRuntime({ env, homeDir, existsSync });
    return runtime.error ? runtime : { ...runtime, scriptPath: runtime.bridgePath, backend: 'chatgpt' };
  };
  if (wanted === 'chatgpt') return chatgpt();
  const localAppData = env.LOCALAPPDATA || path.join(homeDir, 'AppData', 'Local');
  const pythonPath = [
    env.COMPANY_DROP_PYTHON,
    path.join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
    path.join(localAppData, 'Programs', 'Python', 'Python313', 'python.exe'),
  ].filter(Boolean).find(candidate => existsSync(candidate));
  const scriptPath = [
    env.COMPANY_RELAY_SCRIPT,
    path.join(homeDir, 'company-drop', 'client', 'company_relay.py'),
  ].filter(Boolean).find(candidate => existsSync(candidate));
  if (pythonPath && scriptPath) return { pythonPath, scriptPath, backend: 'relay' };
  if (wanted === 'relay') {
    return {
      error: scriptPath ? '未找到公司收件箱中转所需的 Python。' : '未找到公司收件箱中转工具 company_relay.py。',
      code: scriptPath ? 'python_missing' : 'relay_missing',
    };
  }
  return chatgpt();
}

function parseBridgeOutput(stdout, stderr, exitCode) {
  const lines = String(stdout || '').split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  let envelope = null;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      envelope = JSON.parse(lines[index]);
      break;
    } catch (_) {
      // Keep looking for the final JSON envelope after any diagnostics.
    }
  }
  if (!envelope || typeof envelope !== 'object') {
    return {
      ok: false,
      error: String(stderr || '').trim() || '公司中转工具没有返回有效结果。',
      code: 'invalid_response',
    };
  }
  if (exitCode !== 0 || envelope.ok !== true) {
    const error = envelope.error && typeof envelope.error === 'object' ? envelope.error : {};
    return {
      ok: false,
      error: error.message || String(stderr || '').trim() || `公司中转工具退出码：${exitCode}`,
      code: error.code || 'bridge_failed',
      details: error.details,
    };
  }
  return envelope;
}

function runChatgptBridge(args, {
  input = '',
  spawnImpl = spawn,
  runtimeOptions,
  resolveRuntime = resolveChatgptBridgeRuntime,
  timeoutMs = BRIDGE_TIMEOUT_MS,
  maxOutputBytes = BRIDGE_MAX_OUTPUT_BYTES,
} = {}) {
  const runtime = resolveRuntime(runtimeOptions);
  if (runtime.error) return Promise.resolve({ ok: false, ...runtime });
  const scriptPath = runtime.scriptPath || runtime.bridgePath;
  return new Promise((resolve) => {
    const child = spawnImpl(runtime.pythonPath, [scriptPath, ...args], {
      windowsHide: true,
      cwd: path.dirname(scriptPath),
      env: {
        ...process.env,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let outputBytes = 0;
    let settled = false;
    let timer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(result);
    };
    const append = (target, chunk) => {
      outputBytes += chunk.length;
      if (outputBytes > maxOutputBytes) {
        child.kill();
        finish({ ok: false, error: '公司中转返回内容超过安全上限。', code: 'output_limit' });
        return target;
      }
      return target + chunk.toString('utf8');
    };
    if (child.stdout) child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    if (child.stderr) child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    child.on('error', error => finish({
      ok: false,
      error: `无法启动公司中转工具：${String(error && error.message || error)}`,
      code: 'spawn_failed',
    }));
    child.on('close', code => finish(parseBridgeOutput(stdout, stderr, code)));
    timer = setTimeout(() => {
      child.kill();
      finish({ ok: false, error: '公司中转操作超时。', code: 'timeout' });
    }, timeoutMs);
    if (child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(String(input || ''), 'utf8');
    }
  });
}

function runCompanyText(args, options = {}) {
  return runChatgptBridge(args, { ...options, resolveRuntime: resolveCompanyTextRuntime });
}

function validateText(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: '没有可同步的文字。', code: 'empty_content' };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > BRIDGE_MAX_INPUT_BYTES) {
    return { ok: false, error: '文字超过当前 1 MiB 安全上限。', code: 'content_too_large' };
  }
  return { ok: true, text, bytes };
}

function normalizeMessageIds(values) {
  if (!Array.isArray(values)) return [];
  return Array.from(new Set(values
    .map(value => String(value || '').trim())
    .filter(value => value && value.length <= 128)))
    .slice(0, 1000);
}

function registerChatgptBridgeIpc(ipcMain, deps = {}) {
  const sessionManager = deps.sessionManager;
  const runner = deps.runBridge || runCompanyText;
  const backendOf = deps.resolveBackend || (() => resolveCompanyTextRuntime().backend);
  const sendPrompt = deps.sendPrompt || sendToPty;
  let pullInFlight = false;
  let pushInFlight = false;

  ipcMain.handle('chatgpt-bridge:status', async () => runner(['status']));
  ipcMain.handle('chatgpt-bridge:open', async () => runner(['open']));

  ipcMain.handle('chatgpt-bridge:pull', async (_event, payload = {}) => {
    if (pullInFlight) return { ok: false, error: '正在拉取，请稍候。', code: 'already_pulling' };
    pullInFlight = true;
    try {
      return await runner(['pull', ...(payload.peek === true ? ['--peek'] : [])]);
    } finally {
      pullInFlight = false;
    }
  });

  ipcMain.handle('chatgpt-bridge:pull-for-input', async () => {
    if (pullInFlight) return { ok: false, error: '正在拉取，请稍候。', code: 'already_pulling' };
    pullInFlight = true;
    try {
      return await runner(['pull', '--peek', '--download-files']);
    } finally {
      pullInFlight = false;
    }
  });

  ipcMain.handle('chatgpt-bridge:ack', async (_event, payload = {}) => {
    const messageIds = normalizeMessageIds(payload.messageIds);
    if (!messageIds.length) return { ok: false, error: '没有可确认的 ChatGPT 消息。', code: 'message_ids_missing' };
    const args = ['ack'];
    for (const messageId of messageIds) args.push('--message-id', messageId);
    return runner(args);
  });

  ipcMain.handle('chatgpt-bridge:push', async (_event, payload = {}) => {
    const checked = validateText(payload.text);
    if (!checked.ok) return checked;
    if (pushInFlight) return { ok: false, error: '正在同步，请稍候。', code: 'already_pushing' };
    pushInFlight = true;
    try {
      // 公司收件箱页面会显示来源说明（如「当前回答」、文件名）；ChatGPT 中转不认识这个参数。
      const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
      const args = ['push', '--stdin'];
      if (label && backendOf() === 'relay') args.push('--label', label);
      return await runner(args, { input: checked.text });
    } finally {
      pushInFlight = false;
    }
  });

  ipcMain.handle('chatgpt-bridge:pull-and-send', async (_event, payload = {}) => {
    const sessionId = typeof payload.sessionId === 'string' ? payload.sessionId : '';
    const session = sessionId && sessionManager && sessionManager.getSession(sessionId);
    if (!session) return { ok: false, error: '请选择一个正在运行的单聊会话。', code: 'session_not_found' };
    if (pullInFlight) return { ok: false, error: '正在拉取，请稍候。', code: 'already_pulling' };
    pullInFlight = true;
    try {
      const pulled = await runner(['pull', '--peek']);
      if (!pulled || pulled.ok !== true) return pulled;
      if (pulled.new !== true || typeof pulled.content !== 'string' || !pulled.content.trim()) {
        return { ok: true, new: false, sent: false };
      }
      const sent = await sendPrompt(sessionId, pulled.content, session.kind);
      const sendOk = sent === true
        || (sent && sent.ok === true && sent.sendStatus !== 'stuck');
      if (!sendOk) {
        return { ok: false, new: true, sent: false, error: '内容已拉取，但当前 AI 未成功接收。', code: 'pty_send_failed' };
      }
      const messageIds = Array.from(new Set([
        ...(Array.isArray(pulled.message_ids) ? pulled.message_ids : []),
        ...(pulled.items || []).map(item => item && item.message_id),
      ].filter(value => typeof value === 'string' && value)));
      const ackArgs = ['ack'];
      for (const messageId of messageIds) ackArgs.push('--message-id', messageId);
      const acknowledged = messageIds.length ? await runner(ackArgs) : { ok: true };
      return {
        ok: true,
        new: true,
        sent: true,
        count: pulled.count,
        acknowledged: acknowledged && acknowledged.ok === true,
        warning: acknowledged && acknowledged.ok === true ? null : '内容已发送，但游标确认失败；下次可能重复拉取。',
      };
    } finally {
      pullInFlight = false;
    }
  });
}

module.exports = {
  BRIDGE_MAX_INPUT_BYTES,
  BRIDGE_MAX_OUTPUT_BYTES,
  BRIDGE_TIMEOUT_MS,
  parseBridgeOutput,
  registerChatgptBridgeIpc,
  resolveChatgptBridgeRuntime,
  resolveCompanyTextRuntime,
  runChatgptBridge,
  runCompanyText,
  normalizeMessageIds,
  validateText,
};
