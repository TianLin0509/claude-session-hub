'use strict';

// One real prompt in an isolated Hub: the agent waits on a 20-second command,
// then writes a short answer. The card must show generation speed well above
// the whole-turn rate, because the sleep is tool time, not model time.
//   HUB_REAL_PROVIDER=claude|codex node tests/e2e-turn-generation-speed-real.js

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');
const { gracefulQuit, launchIsolatedHub, _waitMs } = require('./helpers/hub-launcher.js');

const HUB_ROOT = path.resolve(__dirname, '..');
const PROVIDER = String(process.env.HUB_REAL_PROVIDER || 'claude').toLowerCase();
if (!['claude', 'codex'].includes(PROVIDER)) throw new Error(`unsupported HUB_REAL_PROVIDER=${PROVIDER}`);
const RUN_ID = `${Date.now()}-${process.pid}`;
const TEMP_ROOT = path.join(os.tmpdir(), `hub-gen-speed-${PROVIDER}-${RUN_ID}`);
const WORKSPACE = path.join(TEMP_ROOT, 'workspace');
const CLAUDE_DIR = path.join(TEMP_ROOT, 'claude-config');
const CODEX_HOME = path.join(TEMP_ROOT, 'codex-home');
const ARTIFACT_DIR = path.join(HUB_ROOT, 'artifacts', `20261011-gen-speed-real-claude1`);

function reservePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function prepareClaudeConfig() {
  const sourceDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.copyFileSync(path.join(sourceDir, '.credentials.json'), path.join(CLAUDE_DIR, '.credentials.json'));
  const source = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8'));
  const state = { autoUpdates: false, hasCompletedOnboarding: true, projects: {}, remoteDialogSeen: true,
    lastOnboardingVersion: source.lastOnboardingVersion, installMethod: source.installMethod || 'native' };
  // Same keys as diag-real-card-delivery: without the "seen" flags a first
  // launch opens the auto-mode offer, which swallows the typed prompt.
  for (const key of ['userID', 'anonymousId', 'machineID', 'oauthAccount', 'clientDataCacheSlots',
    'hasAvailableSubscription', 'modelAccessCache', 'orgModelDefaultCache',
    'additionalModelOptionsCache', 'additionalModelCostsCache',
    'hasSeenAutoModeEntryWarning', 'hasResetAutoModeOptInForDefaultOffer',
    'hasSeenAutoDefaultNudge', 'autoPermissionsNotificationCount',
    'skipDangerousModePermissionPrompt', 'unpinFable5LaunchEffort']) {
    if (source[key] !== undefined) state[key] = source[key];
  }
  fs.writeFileSync(path.join(CLAUDE_DIR, '.claude.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(CLAUDE_DIR, 'settings.json'), JSON.stringify({
    hooks: {}, permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }, null, 2));
  const deployed = ensureClaudeHookIntegration({ claudeDir: CLAUDE_DIR,
    sourceScriptsDir: path.join(HUB_ROOT, 'scripts'), logger: { log() {}, warn() {} } });
  if (deployed.errors.length) throw new Error(`Claude hook deployment failed: ${deployed.errors.join('; ')}`);
}

async function waitFor(label, fn, timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try { const value = await fn(); if (value) return value; } catch (error) { lastError = error; }
    await _waitMs(200);
  }
  throw new Error(`timeout ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

async function main() {
  fs.mkdirSync(WORKSPACE, { recursive: true });
  fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
  if (PROVIDER === 'claude') prepareClaudeConfig();
  else {
    // The isolated Hub only launches a Codex account inside its own root.
    const source = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
    fs.mkdirSync(CODEX_HOME, { recursive: true });
    for (const name of ['auth.json', 'config.toml', 'models_cache.json'])
      if (fs.existsSync(path.join(source, name))) fs.copyFileSync(path.join(source, name), path.join(CODEX_HOME, name));
  }
  const port = await reservePort();
  const result = { provider: PROVIDER, runId: RUN_ID };
  let hub = null, client = null;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(TEMP_ROOT, 'hub-data'), port, label: `gen-speed-${PROVIDER}`,
      windowMode: 'hidden', extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_DISABLE_LEAGUE_BACKGROUND: '1',
        HUB_SESSION_SEARCH_PREWARM: '0', CLAUDE_HUB_HOME_DIR: path.join(TEMP_ROOT, 'fake-home'),
        AI_HUB_WORKSPACE_ROOT: path.join(TEMP_ROOT, 'workspaces'),
        ...(PROVIDER === 'claude' ? { CLAUDE_CONFIG_DIR: CLAUDE_DIR } : { CODEX_HOME }) } });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 920, deviceScaleFactor: 1, mobile: false });
    await waitFor('Hub APIs', () => client.eval('!!(window.__hubE2E && window.WorkspaceController?.createSession)'));
    const opts = PROVIDER === 'claude'
      ? { model: process.env.HUB_DIAG_CLAUDE_MODEL || 'haiku', effort: 'low', mcpProfile: 'none', fastMode: false }
      : { model: process.env.HUB_DIAG_CODEX_MODEL || 'gpt-6-luna', effort: 'low', mcpProfile: 'none', codexSpeedTier: 'inherit' };
    const created = await client.eval(`window.WorkspaceController.createSession(${JSON.stringify(PROVIDER)}, {
      cwd:${JSON.stringify(WORKSPACE)}, opts:${JSON.stringify(opts)} }).then(s => ({ id:s.id }))`);
    const sid = JSON.stringify(created.id);
    result.sessionId = created.id;
    await waitFor('renderer session', () => client.eval(`sessions.has(${sid})`), 20000);
    await client.eval(`window.__hubE2E.selectSession(${sid}, { forceScrollBottom:true })`);
    const screen = () => client.eval(`window.__hubE2E.terminalLiveScreenText(${sid}).toLowerCase()`);
    if (PROVIDER === 'claude') {
      await waitFor('Claude prompt', async () => {
        const text = await screen();
        if (text.includes('allow external claude.md file imports?'))
          await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${sid}, data:'\\r' })`);
        return text.includes('shift+tab');
      }, 90000);
      // settings.json already starts in bypass mode; Shift+Tab would cycle past it.
      await waitFor('bypass mode', async () => (await screen()).includes('bypass permissions on'), 20000);
      await _waitMs(1500);
    } else {
      await waitFor('Codex prompt', async () => (await screen()).includes('context '), 90000);
    }
    await client.eval(`window.__hubE2E.selectSession(${sid}, { forceScrollBottom:true });
      window.__hubE2E.cardQuestionNavigator.setViewMode('card')`);
    const prompt = '这是一次测速验证。先只用 shell 运行一次命令 `powershell -NoProfile -Command "Start-Sleep -Seconds 20; \'done\'"`，'
      + '等它结束后，不再调用任何工具，直接用中文写大约 400 字介绍 OFDM 的原理。';
    if (PROVIDER === 'claude') {
      // Same driver as diag-real-card-delivery: this test owns speed display,
      // not the closed-loop submit feature, so it writes the PTY directly.
      await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${sid}, data:${JSON.stringify(prompt)} })`);
      await _waitMs(900);
      await client.eval(`ipcRenderer.send('terminal-input', { sessionId:${sid}, data:'\\r' })`);
      result.promptSubmit = { ok: true, sendStatus: 'direct-test-driver' };
    } else {
      result.promptSubmit = await client.eval(`ipcRenderer.invoke('session:send-prompt', { sessionId:${sid}, text:${JSON.stringify(prompt)} })`);
      assert.equal(result.promptSubmit?.ok, true, JSON.stringify(result.promptSubmit));
    }
    result.card = await waitFor('speed on completed card', () => client.eval(`(() => {
      const card = [...document.querySelectorAll('#msg-overlay > .turn-card:not(.user)')].at(-1);
      const speed = card?.querySelector('.turn-speed');
      const bar = document.querySelector('.session-turn-speed');
      return speed && /生成/.test(speed.textContent) ? { text: speed.textContent, title: speed.title,
        bar: bar?.hidden ? '' : bar?.textContent || '' } : null;
    })()`), 240000);
    const [, generation, whole] = result.card.text.match(/生成 ≈([\d.]+) · 整轮 ([\d.]+)/) || [];
    result.generation = Number(generation); result.whole = Number(whole);
    assert(result.generation > result.whole * 1.3, `20 秒工具时间应被扣除：${result.card.text}`);
    assert.match(result.card.title, /其中工具、子代理和等待约 (2\d|[3-9]\d)(\.\d)? 秒|其中工具、子代理和等待约 \d+ 分/);
    assert.match(result.card.bar, /上轮生成 ≈/);
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    result.desktopShot = path.join(ARTIFACT_DIR, `${PROVIDER}-desktop-${RUN_ID}.png`);
    fs.writeFileSync(result.desktopShot, Buffer.from(shot.data, 'base64'));
    await client.eval(`document.querySelector('[data-display-mode="phone"]')?.click()`);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await _waitMs(400);
    result.phone = await client.eval(`(() => { const e = [...document.querySelectorAll('.turn-speed')].at(-1);
      const r = e.getBoundingClientRect(); return { text: e.innerText, x: r.x, right: r.right, viewport: innerWidth }; })()`);
    assert(result.phone.x >= 0 && result.phone.right <= result.phone.viewport, JSON.stringify(result.phone));
    const phone = await client.send('Page.captureScreenshot', { format: 'png' });
    result.phoneShot = path.join(ARTIFACT_DIR, `${PROVIDER}-phone-${RUN_ID}.png`);
    fs.writeFileSync(result.phoneShot, Buffer.from(phone.data, 'base64'));
    result.ok = true;
  } catch (error) {
    result.error = error.message;
    if (client) {
      result.screen = await client.eval(`window.__hubE2E.terminalLiveScreenText(${JSON.stringify(result.sessionId || '')})`).catch(() => '');
      const shot = await client.send('Page.captureScreenshot', { format: 'png' }).catch(() => null);
      if (shot) fs.writeFileSync(path.join(ARTIFACT_DIR, `${PROVIDER}-failure-${RUN_ID}.png`), Buffer.from(shot.data, 'base64'));
    }
    throw error;
  } finally {
    fs.writeFileSync(path.join(ARTIFACT_DIR, `${PROVIDER}-result-${RUN_ID}.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
    await client?.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});
  }
}

main().catch(error => { console.error(error.stack); process.exitCode = 1; });
