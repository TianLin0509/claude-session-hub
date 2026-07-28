'use strict';
// 真实隔离 E2E：初心投研页内原生 PTY、精简 Prompt、工具型回答、全局 Session 跨 Hub 恢复。
// 只关闭本脚本 spawn 的 PID；不读取或改动生产 Hub 数据目录。

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[key];
}

const HUB_ROOT = path.resolve(__dirname, '..');
const CHUXIN_ROOT = process.env.CHUXIN_DIR || 'C:\\Users\\lintian\\chuxin-research';
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT_ROOT = path.join(HUB_ROOT, 'output', 'playwright', `chuxin-native-${STAMP}`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function freePort(start) {
  for (let port = start; port < start + 100; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error(`no free port from ${start}`);
}

function getJson(url, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(buf)); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
  });
}

async function waitHealth(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const payload = await getJson(`${base}/health`);
    if (payload && payload.status === 'ok') return payload;
    await _waitMs(300);
  }
  throw new Error(`Chuxin API not healthy: ${base}`);
}

async function waitEval(client, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      if (await client.eval(`Boolean(${expression})`)) return;
    } catch (error) { lastError = error; }
    await _waitMs(300);
  }
  throw new Error(`timeout waiting ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function screenshot(client, filePath) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(filePath, Buffer.from(shot.data, 'base64'));
}

function safeRemove(dir) {
  const resolved = path.resolve(dir);
  const tempRoot = path.resolve(os.tmpdir());
  if (!resolved.startsWith(tempRoot + path.sep)) return;
  if (!path.basename(resolved).startsWith('chuxin-native-pty-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

async function openResearchPanel(client) {
  await waitEval(client, 'document.getElementById("btn-chuxin")', 'Chuxin entry');
  await client.eval(`(() => {
    const errors = [];
    window.__cxE2EErrors = errors;
    window.addEventListener('error', e => errors.push(String(e.error || e.message || 'error')));
    window.addEventListener('unhandledrejection', e => errors.push(String(e.reason || 'unhandled')));
    document.getElementById('btn-chuxin').click();
  })()`);
  await waitEval(client, 'document.querySelector(".cx-status.online")', 'online panel', 30000);
  await waitEval(client, 'document.querySelectorAll(".cx-agent").length === 3 && document.querySelectorAll(".cx-hero-card").length >= 2', 'agents and heroes', 30000);
}

(async () => {
  fs.mkdirSync(OUTPUT_ROOT, { recursive: true });
  const tempRoot = path.join(os.tmpdir(), `chuxin-native-pty-e2e-${process.pid}-${STAMP}`);
  const vaultDir = path.join(tempRoot, 'vault');
  const globalSessions = path.join(tempRoot, 'global-sessions');
  const apiPort = await freePort(23040);
  const hubPortA = await freePort(23140);
  const hubPortB = await freePort(hubPortA + 1);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  const apiLog = [];
  let api = null;
  let hubA = null;
  let hubB = null;
  let clientA = null;
  let clientB = null;
  try {
    fs.mkdirSync(vaultDir, { recursive: true });
    api = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--app-dir', CHUXIN_ROOT,
      '--host', '127.0.0.1', '--port', String(apiPort)], {
      cwd: CHUXIN_ROOT,
      windowsHide: true,
      env: { ...process.env, CHUXIN_VAULT_DIR: vaultDir, PYTHONUNBUFFERED: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [api.stdout, api.stderr]) {
      stream.on('data', (data) => {
        apiLog.push(...data.toString().split(/\r?\n/).filter(Boolean));
        if (apiLog.length > 300) apiLog.splice(0, apiLog.length - 300);
      });
    }
    await waitHealth(apiBase);

    const commonEnv = {
      CHUXIN_DIR: CHUXIN_ROOT,
      CHUXIN_API_BASE: apiBase,
      CHUXIN_WEB_BASE: apiBase,
      CHUXIN_GLOBAL_SESSION_DIR: globalSessions,
      CLAUDE_HUB_E2E: '1',
    };
    hubA = await launchIsolatedHub({
      dataDir: path.join(tempRoot, 'hub-a'),
      port: hubPortA,
      label: 'chuxin-native-a',
      extraEnv: commonEnv,
    });
    clientA = await connectFirstPage(hubA, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await clientA.send('Runtime.enable');
    await clientA.send('Page.enable');
    await clientA.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await clientA.eval(`(() => {
      localStorage.removeItem('chuxin.hub.selected-heroes');
      localStorage.removeItem('chuxin.hub.research-session');
      localStorage.removeItem('chuxin.hub.agent-models');
      localStorage.setItem('chuxin.hub.answer-provider', 'codex-cli');
    })()`);
    await openResearchPanel(clientA);

    const defaults = await clientA.eval(`(() => Object.fromEntries(
      [...document.querySelectorAll('.cx-agent')].map(card => [card.dataset.provider, card.querySelector('select').value])
    ))()`);
    assert.deepStrictEqual(defaults, {
      'codex-cli': 'gpt-5.6-sol',
      'claude-cli': 'claude-opus-4-8[1m]',
      'kimi-cli': 'kimi-code/k3',
    });

    const question = '请用巴菲特方法判断澜起科技（688008）当前估值是否留有安全边际。必须先用 research MCP 核验最新收盘价、最近财务数据和来源时间；任何工具失败都要明确写出。结论尽量简洁。';
    await clientA.eval(`(question => {
      for (const card of document.querySelectorAll('.cx-hero-card')) {
        const target = card.textContent.includes('巴菲特');
        if (card.classList.contains('selected') !== target) card.click();
      }
      const box = document.querySelector('.cx-ask-box');
      box.value = question;
      box.dispatchEvent(new Event('input', { bubbles: true }));
    })(${JSON.stringify(question)})`);
    await waitEval(clientA, 'document.querySelector(".cx-dev-exact pre") && document.querySelector(".cx-dev-exact pre").textContent.includes("688008")', 'live prompt preview', 30000);
    const previewPrompt = await clientA.eval('document.querySelector(".cx-dev-exact pre").textContent');
    assert(previewPrompt.includes('自主选择工具、参数、顺序、重试与停止条件'));
    assert(Buffer.byteLength(previewPrompt, 'utf8') < 8000, `prompt too long: ${Buffer.byteLength(previewPrompt, 'utf8')}`);

    await clientA.eval('document.querySelector(".cx-btn.primary").click()');
    await waitEval(clientA, 'document.querySelector(".cx-native-terminal .xterm") && document.querySelector(".cx-native-terminal .floating-input-box")', 'embedded interactive PTY', 90000);
    const liveSessions = await clientA.eval(`(async () => await require('electron').ipcRenderer.invoke('get-sessions'))()`);
    const researchSession = liveSessions.find((row) => row.purpose === 'chuxin-research');
    assert(researchSession && researchSession.hiddenFromSidebar === true);
    const sidebarText = await clientA.eval('document.getElementById("session-list").innerText');
    assert(!sidebarText.includes(researchSession.title));
    await screenshot(clientA, path.join(OUTPUT_ROOT, '01-native-pty-running.png'));

    await waitEval(clientA, 'document.querySelectorAll(".cx-dialogue").length > 0 && !document.querySelector(".cx-btn.primary").disabled', 'friendly answer cards', 600000);
    const actualPrompt = await clientA.eval(`(() => {
      document.getElementById('cx-open-developer').click();
      return document.querySelector('.cx-dev-exact pre').textContent;
    })()`);
    assert.strictEqual(actualPrompt, previewPrompt, 'preview and executed prompt diverged');
    const answerText = await clientA.eval('document.querySelector(".cx-results").innerText');
    assert(answerText.includes('澜起科技') || answerText.includes('688008'));
    await screenshot(clientA, path.join(OUTPUT_ROOT, '02-friendly-result-and-prompt.png'));
    const buffer = await clientA.eval(`(async sid => await require('electron').ipcRenderer.invoke('debug:get-session-buffer', sid))(${JSON.stringify(researchSession.id)})`);
    // Codex TUI intentionally does not echo the injected AgentTask verbatim. The
    // Developer tab above is the exact-input assertion; PTY only proves that the
    // same native session exposed live research/tool activity.
    assert(buffer.length > 200, 'native PTY buffer is unexpectedly empty');
    assert(/research|mcp|stock|财务|行情|分析/i.test(buffer), 'native PTY did not expose research activity');

    const registryFiles = fs.readdirSync(path.join(globalSessions, 'sessions')).filter((name) => name.endsWith('.json'));
    assert.strictEqual(registryFiles.length, 1);
    const record = JSON.parse(fs.readFileSync(path.join(globalSessions, 'sessions', registryFiles[0]), 'utf8'));
    assert(record.nativeSession && record.nativeSession.codexSid, 'native Codex SID not persisted');
    assert.strictEqual(record.model, 'gpt-5.6-sol');

    await clientA.close();
    clientA = null;
    await gracefulQuit(hubA);
    hubA = null;
    await waitEvalLeaseReleased(globalSessions, record.researchSessionId);

    hubB = await launchIsolatedHub({
      dataDir: path.join(tempRoot, 'hub-b'),
      port: hubPortB,
      label: 'chuxin-native-b',
      extraEnv: commonEnv,
    });
    clientB = await connectFirstPage(hubB, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await clientB.send('Runtime.enable');
    await clientB.send('Page.enable');
    await clientB.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await openResearchPanel(clientB);
    await waitEval(clientB, `document.querySelector('.cx-session-select option[value="${record.researchSessionId}"]')`, 'global session in second Hub');
    await clientB.eval(`(id => {
      const select = document.querySelector('.cx-session-select');
      select.value = id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })(${JSON.stringify(record.researchSessionId)})`);
    await waitEval(clientB, 'document.querySelector(".cx-native-terminal .xterm") && document.querySelector(".cx-native-terminal .floating-input-box")', 'resumed native PTY in second Hub', 90000);
    const resumed = await clientB.eval(`(async () => (await require('electron').ipcRenderer.invoke('get-sessions')).find(row => row.purpose === 'chuxin-research'))()`);
    assert(resumed && resumed.codexSid === record.nativeSession.codexSid);
    await screenshot(clientB, path.join(OUTPUT_ROOT, '03-cross-hub-resumed.png'));
    const errors = await clientB.eval('window.__cxE2EErrors || []');
    assert.deepStrictEqual(errors, []);

    console.log(JSON.stringify({
      ok: true,
      provider: record.provider,
      model: record.model,
      researchSessionId: record.researchSessionId,
      nativeSid: record.nativeSession.codexSid,
      promptBytes: Buffer.byteLength(actualPrompt, 'utf8'),
      answerChars: answerText.length,
      outputRoot: OUTPUT_ROOT,
      screenshots: ['01-native-pty-running.png', '02-friendly-result-and-prompt.png', '03-cross-hub-resumed.png'],
    }, null, 2));
  } catch (error) {
    error.message += `\nAPI log tail:\n${apiLog.slice(-30).join('\n')}\nHub A tail:\n${hubA ? hubA.log().slice(-30).join('\n') : ''}\nHub B tail:\n${hubB ? hubB.log().slice(-30).join('\n') : ''}`;
    throw error;
  } finally {
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
    if (hubA) await gracefulQuit(hubA).catch(() => {});
    if (hubB) await gracefulQuit(hubB).catch(() => {});
    if (api && api.exitCode == null) api.kill('SIGTERM');
    await _waitMs(1000);
    safeRemove(tempRoot);
  }
})().catch((error) => {
  console.error(error.stack || error.message);
  process.exitCode = 1;
});

async function waitEvalLeaseReleased(globalRoot, researchSessionId, timeoutMs = 15000) {
  const file = path.join(globalRoot, 'leases', `${researchSessionId}.lock`);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!fs.existsSync(file)) return;
    await _waitMs(200);
  }
  throw new Error(`global ownership lease not released: ${file}`);
}
