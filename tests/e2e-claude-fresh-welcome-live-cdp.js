'use strict';
// Real Claude PTY startup, followed by one small Haiku request through the UI.
// Credentials are copied into a temporary profile and removed after the test.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-welcome-live-'));
  const home = path.join(root, 'claude'), cwd = path.join(root, 'work'), data = path.join(root, 'data');
  const out = path.resolve('artifacts', '20261006-claude-welcome-live-codex1-' + Date.now());
  for (const dir of [home, cwd, data, out]) fs.mkdirSync(dir, { recursive: true });
  const sourceAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const copiedAuth = path.join(home, '.credentials.json'), beforeAuth = hash(sourceAuth);
  const report = { passed: false, checks: [], out, boundary: 'Real isolated Hub, real Claude PTY and one Haiku response.' };
  let hub, client, sid;
  const until = async (expression, label, timeout = 90000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await client.eval(`Boolean(${expression})`)) return;
      await _waitMs(150);
    }
    throw Error('timeout: ' + label);
  };
  const click = async selector => {
    const position = await client.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...position, button: 'left', clickCount: 1 });
  };
  const capture = async name => {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  try {
    fs.copyFileSync(sourceAuth, copiedAuth);
    fs.writeFileSync(path.join(home, '.claude.json'), j({ hasCompletedOnboarding: true, theme: 'light', skipDangerousModePermissionPrompt: true,
      projects: { [cwd]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true } } }));
    const hooks = require('../core/claude-hook-integration').ensureClaudeHookIntegration({
      claudeDir: home, sourceScriptsDir: path.resolve(__dirname, '../scripts'),
      logger: { log() {}, warn() {} },
    });
    assert.deepEqual(hooks.errors, [], 'isolated Claude lifecycle hooks installed');
    fs.writeFileSync(path.join(data, 'config.json'), j({ runtime: { agent: 'pty' } }));
    const port = await new Promise((resolve, reject) => {
      const server = net.createServer(); server.on('error', reject);
      server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
    });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'real Claude welcome', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_CONFIG_DIR: home,
      AI_HUB_WORKSPACE_ROOT: root, CODEX_HOME: path.join(root, 'codex'),
    } });
    client = await connectFirstPage(hub);
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__hubE2E', 'renderer ready');
    const session = await client.eval(`ipcRenderer.invoke('create-session',${j({ kind: 'claude', opts: {
      cwd, model: 'claude-haiku-4-5-20251001', effort: 'low', mcpProfile: 'none', permissionMode: 'default', autonomous: false,
    } })})`);
    sid = session.id; assert(sid); assert.equal(session.freshLaunch, true); assert(session.ccSessionId);
    await until(`activeSessionId===${j(sid)} && !!document.querySelector('#msg-overlay>.session-welcome')`, 'fresh Claude welcome');
    await until(`(()=>{const text=window.__hubE2E.terminalBufferText(${j(sid)});return text.includes('❯') && /Haiku|shortcuts|manual mode on/.test(text);})()`, 'real Claude startup');
    await _waitMs(1500);
    assert.equal(await client.eval('currentView'), 'card');
    assert(await client.eval('!!document.querySelector("#msg-overlay>.session-welcome")'));
    assert(!await client.eval('/移走|删除|加载历史失败/.test(document.querySelector("#msg-overlay").innerText)'));
    report.checks.push('real Claude allocates native ID but still displays welcome after startup');
    console.log('PASS: real Claude startup retains welcome');
    await capture('01-new-claude-welcome');
    await click('#btn-backstage');
    await click('#btn-backstage');
    await until('!!document.querySelector("#msg-overlay>.session-welcome")', 'return from CLI');
    report.checks.push('CLI/card round trip retains the new-session welcome');
    console.log('PASS: welcome survives CLI round trip; sending first prompt');
    await click('.floating-input-box');
    await client.send('Input.insertText', { text: '不要调用工具。请只回复 WELCOME_LIVE_OK。' });
    await click('.floating-input-send');
    await until('[...document.querySelectorAll("#msg-overlay .turn-card.assistant")].some(e=>e.innerText.includes("WELCOME_LIVE_OK"))', 'real first reply', 120000);
    assert.equal(await client.eval('!!document.querySelector("#msg-overlay>.session-welcome")'), false);
    const parsed = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)}})`);
    assert.equal(parsed.error, null);
    assert(parsed.turns.some(turn => turn.role === 'assistant' && j(turn).includes('WELCOME_LIVE_OK')));
    assert.equal(await client.eval(`require('../core/session-history-state').isFreshSession(sessions.get(${j(sid)}))`), false,
      'after a real prompt the renderer must no longer classify this as an unused session');
    report.checks.push('first real Haiku reply replaces welcome and is read from its native transcript');
    await capture('02-first-real-reply');
    report.passed = true;
  } catch (error) {
    report.error = error.stack; process.exitCode = 1;
    if (client) { try { report.screen = await client.eval('document.body.innerText.slice(-2500)'); await capture('failure'); } catch (captureError) { report.captureError = captureError.message; } }
  } finally {
    try { if (hub) await gracefulQuit(hub); } catch (error) { report.cleanupError = error.message; report.passed = false; process.exitCode = 1; }
    await client?.close();
    if (fs.existsSync(copiedAuth)) fs.unlinkSync(copiedAuth);
    assert.equal(hash(sourceAuth), beforeAuth, 'source credentials unchanged');
    fs.writeFileSync(path.join(out, 'evidence.json'), j(report), 'utf8');
    console.log(j(report));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
