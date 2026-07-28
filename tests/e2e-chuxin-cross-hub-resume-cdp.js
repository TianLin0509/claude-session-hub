'use strict';
// 无模型调用的真实 E2E：用已有 Codex SID 验证全局投研 Session 的跨 Hub 互斥、恢复、结果与 Prompt 回放。

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
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) delete process.env[key];

const HUB = path.resolve(__dirname, '..');
const CHUXIN = process.env.CHUXIN_DIR || 'C:\\Users\\lintian\\chuxin-research';
const CODEX_SID = process.env.CHUXIN_E2E_CODEX_SID || '019f9c85-941d-7833-84ba-e7732306eb57';
const ROLLOUT = process.env.CHUXIN_E2E_ROLLOUT || `C:\\Users\\lintian\\.codex\\sessions\\2026\\07\\26\\rollout-2026-07-26T11-43-47-${CODEX_SID}.jsonl`;
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const OUTPUT = path.join(HUB, 'output', 'playwright', `chuxin-cross-hub-${STAMP}`);

function canListen(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}
async function freePort(start) {
  for (let port = start; port < start + 100; port += 1) if (await canListen(port)) return port;
  throw new Error(`no free port from ${start}`);
}
function requestJson(method, url, body = null, headers = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body == null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const req = http.request({
      method, hostname: target.hostname, port: target.port, path: target.pathname,
      headers: { Accept: 'application/json', ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}), ...headers },
    }, (res) => {
      let buf = '';
      res.on('data', (chunk) => { buf += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(buf || '{}');
          if (res.statusCode >= 400) reject(new Error(JSON.stringify(parsed)));
          else resolve(parsed);
        } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}
async function waitHealth(base) {
  for (let i = 0; i < 100; i += 1) {
    try { if ((await requestJson('GET', `${base}/health`)).status === 'ok') return; } catch {}
    await _waitMs(250);
  }
  throw new Error('API health timeout');
}
async function waitEval(client, expression, label, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch {}
    await _waitMs(300);
  }
  throw new Error(`timeout waiting ${label}`);
}
async function openPanel(client) {
  // The button is static HTML; wait for chuxin.js to build its skeleton and
  // bind the click handler before clicking it.
  await waitEval(client, 'document.getElementById("btn-chuxin") && document.querySelector(".cx-status")', 'initialized entry');
  await client.eval('document.getElementById("btn-chuxin").click()');
  try {
    await waitEval(client, 'document.querySelector(".cx-status.online") && document.querySelectorAll(".cx-agent").length >= 3', 'online panel', 30000);
  } catch (error) {
    const debug = await client.eval(`(async()=>({
      status: document.querySelector('.cx-status')?.outerHTML,
      agents: document.querySelectorAll('.cx-agent').length,
      provider: document.querySelector('.cx-provider')?.textContent,
      ipc: await require('electron').ipcRenderer.invoke('chuxin:status')
    }))()`);
    throw new Error(`${error.message}: ${JSON.stringify(debug)}`);
  }
}
async function selectResearch(client, id) {
  await waitEval(client, `document.querySelector('.cx-session-select option[value="${id}"]')`, 'global option');
  await client.eval(`(id => { const s=document.querySelector('.cx-session-select'); s.value=id; s.dispatchEvent(new Event('change',{bubbles:true})); })(${JSON.stringify(id)})`);
}
async function screenshot(client, name) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUTPUT, name), Buffer.from(shot.data, 'base64'));
}
function cleanup(root) {
  const resolved = path.resolve(root);
  if (!resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)) return;
  if (!path.basename(resolved).startsWith('chuxin-cross-hub-e2e-')) return;
  fs.rmSync(resolved, { recursive: true, force: true });
}

(async () => {
  assert(fs.existsSync(ROLLOUT), `missing rollout: ${ROLLOUT}`);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const root = path.join(os.tmpdir(), `chuxin-cross-hub-e2e-${process.pid}-${STAMP}`);
  const vault = path.join(root, 'vault');
  const registry = path.join(root, 'global');
  const workspace = `hub-cross-${Date.now().toString(36)}abc123xyz`;
  const researchId = `research-cross-${Date.now().toString(36)}`;
  const apiPort = await freePort(23240);
  const portA = await freePort(23340);
  const portB = await freePort(portA + 1);
  const apiBase = `http://127.0.0.1:${apiPort}`;
  let api = null; let hubA = null; let hubB = null; let a = null; let b = null;
  try {
    fs.mkdirSync(vault, { recursive: true });
    api = spawn('python', ['-m', 'uvicorn', 'app.main:app', '--app-dir', CHUXIN, '--host', '127.0.0.1', '--port', String(apiPort)], {
      cwd: CHUXIN, windowsHide: true, env: { ...process.env, CHUXIN_VAULT_DIR: vault }, stdio: 'ignore',
    });
    await waitHealth(apiBase);
    const headers = { 'X-Chuxin-Workspace': workspace };
    const task = await requestJson('POST', `${apiBase}/api/spirits/agent-tasks`, {
      question: '跨 Hub 恢复验收：展示同一份 Prompt 与友好回答。', mandate: 'value_speculation',
      spirit_ids: ['buffett.mature.v1'], context: { type: 'free', data: {} }, research_mode: 'question_only',
      answer_provider: 'codex-cli', model: 'gpt-5.6-sol', research_session_id: researchId,
    }, headers);
    const runId = task.job.run_id;
    await requestJson('POST', `${apiBase}/api/spirits/agent-tasks/${runId}/complete`, {
      markdown: '<!-- hero:buffett.mature.v1 -->\n我会先看企业质量与价格之间是否留有容错空间。\n<!-- /hero -->\n<!-- synthesis -->\n这是跨 Hub 恢复验收，不构成投资建议。\n<!-- /synthesis -->',
      provider: 'codex-cli', model: 'gpt-5.6-sol', hub_session_id: 'seed', research_session_id: researchId,
      native_session: { codexSid: CODEX_SID, transcriptPath: ROLLOUT }, duration_ms: 0,
    }, headers);
    fs.mkdirSync(path.join(registry, 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(registry, 'leases'), { recursive: true });
    fs.writeFileSync(path.join(registry, 'sessions', `${researchId}.json`), JSON.stringify({
      schemaVersion: 1, createdAt: Date.now(), updatedAt: Date.now(), researchSessionId: researchId,
      title: '投研 · Codex · 跨 Hub 恢复验收', kind: 'codex', provider: 'codex-cli', model: 'gpt-5.6-sol',
      cwd: CHUXIN, workspace, status: 'restorable', lastRunId: runId, promptPolicyVersion: '2.0.0',
      nativeSession: { codexSid: CODEX_SID, transcriptPath: ROLLOUT },
    }, null, 2), 'utf8');
    const common = { CHUXIN_DIR: CHUXIN, CHUXIN_API_BASE: apiBase, CHUXIN_WEB_BASE: apiBase, CHUXIN_GLOBAL_SESSION_DIR: registry, CLAUDE_HUB_E2E: '1' };

    hubA = await launchIsolatedHub({ dataDir: path.join(root, 'hub-a'), port: portA, label: 'cross-a', extraEnv: common });
    a = await connectFirstPage(hubA, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await a.send('Page.enable');
    await a.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await openPanel(a);
    await selectResearch(a, researchId);
    await waitEval(a, 'document.querySelector(".cx-native-terminal .floating-input-box") && document.querySelectorAll(".cx-dialogue").length === 1', 'Hub A PTY and restored card', 90000);
    const aSession = await a.eval(`(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).find(x=>x.purpose==='chuxin-research'))()`);
    assert(aSession && aSession.codexSid === CODEX_SID && aSession.hiddenFromSidebar);
    await screenshot(a, '01-hub-a-owner-and-restored-result.png');

    hubB = await launchIsolatedHub({ dataDir: path.join(root, 'hub-b'), port: portB, label: 'cross-b', extraEnv: common });
    b = await connectFirstPage(hubB, (target) => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await b.send('Page.enable');
    await b.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await openPanel(b);
    await waitEval(b, `document.querySelector('.cx-session-select option[value="${researchId}"]').textContent.includes('另一 Hub 运行中')`, 'busy marker');
    await selectResearch(b, researchId);
    await _waitMs(1000);
    const whileBusy = await b.eval(`(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).filter(x=>x.purpose==='chuxin-research').length)()`);
    assert.strictEqual(whileBusy, 0, 'Hub B must not duplicate Hub A PTY');
    await screenshot(b, '02-hub-b-busy-no-duplicate.png');

    await a.close(); a = null;
    await gracefulQuit(hubA); hubA = null;
    const leaseFile = path.join(registry, 'leases', `${researchId}.lock`);
    for (let i = 0; i < 80 && fs.existsSync(leaseFile); i += 1) await _waitMs(200);
    assert(!fs.existsSync(leaseFile), 'Hub A did not release global ownership');
    // Keep B on “new session” while refreshing the global registry. Otherwise
    // the selected record is allowed to auto-resume immediately and the
    // short-lived “可恢复” label legitimately races with this assertion.
    await b.eval(`(() => {
      const select = document.querySelector('.cx-session-select');
      select.value = '__new__';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await b.eval('document.querySelector(".cx-session-row .cx-btn").click()');
    await waitEval(b, `document.querySelector('.cx-session-select option[value="${researchId}"]').textContent.includes('可恢复')`, 'restorable after A close');
    await selectResearch(b, researchId);
    await waitEval(b, 'document.querySelector(".cx-native-terminal .floating-input-box") && document.querySelectorAll(".cx-dialogue").length === 1', 'Hub B resumed PTY and result', 90000);
    const bSession = await b.eval(`(async()=> (await require('electron').ipcRenderer.invoke('get-sessions')).find(x=>x.purpose==='chuxin-research'))()`);
    assert(bSession && bSession.codexSid === CODEX_SID && bSession.hiddenFromSidebar);
    const promptText = await b.eval(`(() => { document.getElementById('cx-open-developer').click(); return document.querySelector('.cx-dev-exact pre').textContent; })()`);
    assert(promptText.includes('跨 Hub 恢复验收'));
    await screenshot(b, '03-hub-b-resumed-same-sid-and-prompt.png');
    console.log(JSON.stringify({ ok: true, researchId, runId, codexSid: CODEX_SID, sameSid: aSession.codexSid === bSession.codexSid, output: OUTPUT }, null, 2));
  } finally {
    if (a) await a.close().catch(() => {});
    if (b) await b.close().catch(() => {});
    if (hubA) await gracefulQuit(hubA).catch(() => {});
    if (hubB) await gracefulQuit(hubB).catch(() => {});
    if (api && api.exitCode == null) api.kill('SIGTERM');
    await _waitMs(800);
    cleanup(root);
  }
})().catch((error) => { console.error(error.stack || error.message); process.exitCode = 1; });
