'use strict';
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
// Use the installed CLI automation package; no npm mutation in this worktree.
const { chromium } = require(process.env.HUB_PLAYWRIGHT_MODULE || path.join(process.env.APPDATA, 'npm', 'node_modules', 'playwright'));
const root = path.resolve(__dirname, '..');
const run = path.join(root, 'artifacts', `20260911-chatgpt-ui-codex1-${Date.now()}`);

async function port() {
  const s = net.createServer();
  await new Promise(resolve => s.listen(0, '127.0.0.1', resolve));
  const n = s.address().port;
  await new Promise(resolve => s.close(resolve));
  return n;
}
(async () => {
  delete process.env.ELECTRON_RUN_AS_NODE;
  fs.mkdirSync(run, { recursive: true });
  const temp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'hub-chatgpt-ui-'));
  const bridge = path.join(temp, 'runtime');
  const codex = path.join(temp, 'codex-home');
  fs.mkdirSync(bridge); fs.mkdirSync(codex);
  fs.writeFileSync(path.join(temp, 'isolation.json'), JSON.stringify({version:1,purpose:'ai-hub-chatgpt-only',port:17861}));
  // Explicit configuration fixture tests the missing connector path; no fake model response.
  fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 17861, mode: 'browser-only', proAvailable: true }));
  fs.writeFileSync(path.join(codex, 'config.toml'), '');
  const data = path.join(temp, 'hub-data');
  fs.mkdirSync(data);
  const workspace = path.join(temp, 'workspace'); fs.mkdirSync(workspace);
  const p = await port();
  let hub, browser;
  const errors = [];
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: p, label: 'chatgpt-ui', windowMode: 'hidden', extraEnv: { CODEX_HOME: codex, AI_HUB_CHATGPT_ROOT: temp, AI_HUB_WORKSPACE_ROOT: workspace } });
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${p}`);
    const page = browser.contexts()[0].pages()[0];
    page.on('pageerror', e => errors.push(e.message));
    await page.waitForFunction(() => !!window.WorkspaceController);
    await page.locator('#btn-new-more').click();
    await page.locator('.new-session-option[data-kind="chatgpt"]').click();
    await page.waitForFunction(() => document.querySelector('#new-session-model')?.options.length === 5);
    const order = await page.locator('.new-session-option').evaluateAll(nodes => nodes.map(n => n.dataset.kind));
    assert.deepEqual(order, ['claude', 'codex', 'chatgpt', 'deepseek', 'kimi', 'gemini', 'powershell']);
    assert.equal(await page.locator('#new-session-model').inputValue(), 'chatgpt-web/high');
    await page.locator('#new-session-model').selectOption('chatgpt-web/pro');
    await page.locator('.new-session-option[data-kind="gemini"]').click();
    await page.locator('.new-session-option[data-kind="chatgpt"]').click();
    await page.waitForFunction(() => document.querySelector('#new-session-model').value === 'chatgpt-web/pro');
    assert(await page.locator('#chatgpt-web-settings').isVisible());
    const tuning = await page.evaluate(() => window.WorkspaceController.buildSessionTuningOpts('chatgpt', 'chatgpt-web/pro'));
    assert.equal(tuning.effort, 'ultra');
    assert.equal(tuning.codexSpeedTier, 'inherit');
    await page.locator('#new-session-submit').click();
    await page.waitForFunction(() => document.querySelector('#new-session-error').textContent.includes('Full MCP'));
    await page.screenshot({ path: path.join(run, '20260911-chatgpt-full-mcp-required-codex1.png') });
    // Live refresh must follow advanced manual mode settings instead of retaining automatic choices.
    fs.writeFileSync(path.join(bridge, 'config.json'), JSON.stringify({ host: '127.0.0.1', port: 17861, mode: 'browser-only', browserInteractionMode: 'manual', zeroRiskProEnabled: true }));
    await page.locator('#chatgpt-web-refresh').click();
    await page.waitForFunction(() => [...document.querySelector('#new-session-model').options].some(o => o.value === 'chatgpt-web/zero-risk'));
    assert.equal(await page.locator('#new-session-model').inputValue(), 'chatgpt-web/pro', 'unavailable choice must not silently downgrade');
    await page.locator('#new-session-model').selectOption('chatgpt-web/zero-risk-pro');
    const manual = await page.evaluate(() => window.WorkspaceController.buildSessionTuningOpts('chatgpt', 'chatgpt-web/zero-risk-pro'));
    assert.equal(manual.effort, 'low');
    assert.deepEqual(errors, []);
    const result = { ok: true, order, tuning, manual, errors, evidence: 'real isolated Hub UI, configuration fixture; no real-model local-tool claim' };
    fs.writeFileSync(path.join(run, '20260911-chatgpt-ui-evidence-codex1.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, run }));
  } finally {
    if (browser) await browser.close();
    if (hub) await gracefulQuit(hub);
  }
})().catch(e => { console.error(e.stack, e.logTail || ''); process.exitCode = 1; });
