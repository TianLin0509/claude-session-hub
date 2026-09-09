'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const RUN = `20260909-prompt-receipt-codex1-${Date.now()}`;
const TEMP = path.join(os.tmpdir(), RUN);
const OUT = path.join(ROOT, 'output', RUN);
fs.mkdirSync(OUT, { recursive: true });
const checks = [];
async function waitFor(label, fn, timeout = 45000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const value = await fn();
    if (value) return value;
    await _waitMs(150);
  }
  throw new Error(`Timeout: ${label}`);
}
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function main() {
  const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexHome = path.join(TEMP, 'codex-home');
  const workspace = path.join(TEMP, 'workspace');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  for (const name of ['auth.json', 'config.toml', 'models_cache.json']) {
    if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(codexHome, name));
  }
  let hub, client;
  const composerInputs = [];
  let entryPath = ROOT;
  if (process.env.HUB_RECEIPT_TRACE === '1') {
    entryPath = path.join(OUT, `${RUN}-trace-entry.cjs`);
    fs.writeFileSync(entryPath, `const fs = require('node:fs');
      const { SessionManager } = require(${JSON.stringify(path.join(ROOT, 'core/session-manager.js'))});
      const original = SessionManager.prototype.writeToSession;
      SessionManager.prototype.writeToSession = function(sid, data) {
        fs.appendFileSync(${JSON.stringify(path.join(OUT, `${RUN}-pty-writes.jsonl`))}, JSON.stringify({sid,data,at:Date.now()})+'\\n');
        return original.apply(this, arguments);
      };
      require(${JSON.stringify(path.join(ROOT, 'main-bootstrap.js'))});`, 'utf8');
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP, 'data'), port: await freePort(),
      windowMode: 'hidden', label: RUN, entryPath,
      extraEnv: { CLAUDE_HUB_E2E: '1', CODEX_HOME: codexHome,
        CLAUDE_HUB_HOME_DIR: path.join(TEMP, 'home'), AI_HUB_WORKSPACE_ROOT: path.dirname(workspace),
        DEEPSEEK_API_KEY: '' },
    });
    client = await connectFirstPage(hub, t => t.type === 'page' && /index\.html/.test(t.url));
    await waitFor('renderer', () => client.eval('!!window.__hubE2E && !!window.WorkspaceController'));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const session = await client.eval(`window.WorkspaceController.createSession('codex', {
      cwd: ${JSON.stringify(workspace)}, opts: { model: 'gpt-6-astra', effort: 'high', codexSpeedTier: 'standard', mcpProfile: 'none' }
    }).then(s => ({ id: s.id }))`);
    const sid = session.id;
    await waitFor('session', () => client.eval(`sessions.has(${JSON.stringify(sid)})`));
    await client.eval(`window.__hubE2E.selectSession(${JSON.stringify(sid)}, { forceScrollBottom: true })`);
    await waitFor('Codex ready', async () => {
      const screen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(sid)})`);
      if (/trust.*(?:directory|folder)/i.test(screen)) {
        await client.eval(`ipcRenderer.send('terminal-input', { sessionId: ${JSON.stringify(sid)}, data: '\r' })`);
      }
      return /Context |Ask Codex/.test(screen);
    }, 90000);

    async function send(text) {
      const actualInput = await client.eval(`(() => {
        const box = document.querySelector('.floating-input-box');
        box.focus(); replaceContenteditableText(box, ${JSON.stringify(text)});
        box.dispatchEvent(new Event('input', { bubbles: true }));
        return readContenteditablePlainText(box);
      })()`);
      composerInputs.push({ intended: text, actual: actualInput });
      assert.equal(actualInput, text, 'composer must preserve all submitted newlines');
      await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
      return client.eval(`floatingPromptDeliveries.get(${JSON.stringify(sid)})?.clientSubmissionId`);
    }
    async function state() {
      return client.eval(`({ delivery: floatingPromptDeliveries.get(${JSON.stringify(sid)}),
        warning: document.querySelector('.fi-stuck')?.textContent || '',
        runtime: getSessionRuntimeTruth(sessions.get(${JSON.stringify(sid)})).state })`);
    }
    async function shot(name) {
      const result = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, `${RUN}-${name}.png`), Buffer.from(result.data, 'base64'));
    }
    for (const [name, prompt] of [
      ['short', '只回复 RECEIPT_SHORT_OK，不调用工具。'],
      ['long', `${Array.from({ length: 100 }, (_, i) => `材料第 ${i + 1} 行：用于验证多行中文消息已提交。`).join('\n')}\n只回复 RECEIPT_LONG_OK，不调用工具。`],
    ]) {
      const id = await send(prompt);
      assert.ok(id);
      await waitFor(`${name} real receipt`, async () => (await state()).delivery?.status === 'confirmed', 60000);
      assert.equal((await state()).warning, '');
      const expected = name === 'short' ? 'RECEIPT_SHORT_OK' : 'RECEIPT_LONG_OK';
      await waitFor(`${name} real answer`, () => client.eval(`ipcRenderer.invoke('get-last-assistant-text', ${JSON.stringify(sid)}).then(x => String(x || '').includes(${JSON.stringify(expected)}))`), 150000);
      checks.push({ name: `${name}: real Codex / PTY / transcript receipt / answer`, passed: true });
      await shot(name);
    }
    console.log('REAL_CODEX_RECEIPTS_PASS');

    // Deterministic renderer race tests use deferred IPC responses. They verify
    // the real composer and DOM, separately from the real provider cases above.
    await client.eval(`(() => {
      window.__receiptOriginalInvoke = ipcRenderer.invoke.bind(ipcRenderer);
      window.__receiptPending = [];
      ipcRenderer.invoke = (channel, request) => channel === 'session:send-prompt'
        ? new Promise(resolve => window.__receiptPending.push({ request, resolve }))
        : window.__receiptOriginalInvoke(channel, request);
    })()`);
    const timeoutSend = await send('UI late confirmation');
    await client.eval(`window.__receiptPending[0].resolve({ ok: true, sendStatus: 'stuck' })`);
    await waitFor('warning visible', async () => !!(await state()).warning);
    assert.ok((await state()).warning.includes('暂未确认'));
    await shot('unconfirmed');
    // Optimistic/previous-turn running must not erase a message-level warning.
    await client.eval(`markCodexCardWorking(${JSON.stringify(sid)}, 'floating_input')`);
    assert.ok((await state()).warning);
    await client.eval(`ipcRenderer.emit('session:prompt-receipt', {}, {
      sessionId: ${JSON.stringify(sid)}, clientSubmissionId: ${JSON.stringify(timeoutSend)}, status: 'confirmed'
    })`);
    assert.equal((await state()).warning, '');
    checks.push({ name: 'late receipt clears warning; optimistic running does not', passed: true });
    await shot('late-confirmed');

    const a = await send('UI A');
    const b = await send('UI B');
    assert.notEqual(a, b);
    await client.eval(`(() => {
      ipcRenderer.emit('session:prompt-receipt', {}, { sessionId: ${JSON.stringify(sid)}, clientSubmissionId: ${JSON.stringify(a)}, status: 'confirmed' });
      window.__receiptPending[1].resolve({ ok: true, sendStatus: 'stuck' });
    })()`);
    assert.equal((await state()).delivery.status, 'pending');
    assert.equal((await state()).warning, '');
    await client.eval(`(() => {
      ipcRenderer.emit('session:prompt-receipt', {}, { sessionId: ${JSON.stringify(sid)}, clientSubmissionId: ${JSON.stringify(b)}, status: 'confirmed' });
      window.__receiptPending[2].resolve({ ok: true, sendStatus: 'stuck' });
    })()`);
    assert.equal((await state()).delivery.status, 'confirmed');
    assert.equal((await state()).warning, '');
    checks.push({ name: 'old send cannot mutate B; delayed timeout cannot resurrect warning', passed: true });
    const altered = await send('line1\nline2');
    await client.eval(`(() => {
      ipcRenderer.emit('session:prompt-receipt', {}, { sessionId: ${JSON.stringify(sid)},
        clientSubmissionId: ${JSON.stringify(altered)}, status: 'content-mismatch' });
      window.__receiptPending[3].resolve({ ok: true, sendStatus: 'stuck' });
    })()`);
    assert.equal((await state()).delivery.status, 'content-mismatch');
    assert.ok((await state()).warning.includes('换行或空白不同'));
    assert.equal(await client.eval(`document.querySelector('.fi-stuck-resend').disabled`), true);
    await shot('content-mismatch');
    checks.push({ name: 'content integrity warning remains visible and disables resend', passed: true });
    await client.eval('ipcRenderer.invoke = window.__receiptOriginalInvoke');
    fs.writeFileSync(path.join(OUT, `${RUN}-checks.json`), JSON.stringify({ checks }, null, 2), 'utf8');
    console.log(`PASS ${checks.length} cases; ${OUT}`);
  } catch (error) {
    if (client) {
      const diagnostic = await client.eval(`({ sessionId: activeSessionId,
        screen: window.__hubE2E.terminalLiveScreenText(activeSessionId),
        deliveries: [...floatingPromptDeliveries], warning: document.querySelector('.fi-stuck')?.textContent })`);
      fs.writeFileSync(path.join(OUT, `${RUN}-failure.json`), JSON.stringify(diagnostic, null, 2), 'utf8');
      const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
      fs.writeFileSync(path.join(OUT, `${RUN}-failure.png`), Buffer.from(screenshot.data, 'base64'));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(OUT, `${RUN}-composer-inputs.json`), JSON.stringify(composerInputs, null, 2), 'utf8');
    if (hub) fs.writeFileSync(path.join(OUT, `${RUN}-hub.log`), hub.log().join('\n'), 'utf8');
    if (client) await client.close();
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
