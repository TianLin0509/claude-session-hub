'use strict';
// Real Claude model commands through the composer, isolated credentials and data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { ensureClaudeHookIntegration } = require('../core/claude-hook-integration');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-cli-model-switch-'));
  const home = path.join(root, 'claude'), cwd = path.join(root, 'workspace');
  const out = path.resolve('artifacts/cli-model-switch/' + Date.now());
  for (const dir of [home, cwd, out]) fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(os.homedir(), '.claude', '.credentials.json'), path.join(home, '.credentials.json'));
  fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'dark', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, projects: {} }));
  const hooks = ensureClaudeHookIntegration({ claudeDir: home, sourceScriptsDir: path.resolve('scripts'), logger: {} });
  assert.equal(hooks.errors.length, 0);
  const report = { root, out, checks: [], passed: false }; let hub, c;
  const until = async (expr, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await c.eval(expr)) return; await sleep(200); }
    throw Error('timeout: ' + label);
  };
  const shot = async name => { const r = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); };
  try {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, extraEnv: { CLAUDE_CONFIG_DIR: home, CODEX_HOME: path.join(root, 'codex'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home') } });
    c = await connectFirstPage(hub); await until('typeof sessions!=="undefined"', 'renderer');
    const s = await c.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:{cwd:${j(cwd)},model:'claude-haiku-4-5-20251001',mcpProfile:'none'}})`);
    report.sessionId = s.id;
    await until(`!!document.querySelector('.session-item[data-session-id="${s.id}"]')`, 'sidebar');
    await c.eval(`document.querySelector('.session-item[data-session-id="${s.id}"]').click()`);
    const screen = `(()=>{const t=terminalCache.get(${j(s.id)})?.terminal;if(!t)return '';const b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n');})()`;
    await until(`${screen}.includes('❯')`, 'Claude ready'); await sleep(2000);
    for (const family of ['sonnet']) {
      await c.eval(`document.querySelector('.composer-model').click()`);
      await until(`!!document.querySelector('.model-picker-item[data-model-id*="${family}"]')`, family + ' option');
      const id = await c.eval(`document.querySelector('.model-picker-item[data-model-id*="${family}"]').dataset.modelId`);
      await c.eval(`document.querySelector('.model-picker-item[data-model-id*="${family}"]').click()`);
      await until(`sessions.get(${j(s.id)}).currentModel?.id===${j(id)}&&!sessions.get(${j(s.id)})._modelSwitchPending`, family + ' confirmed');
      assert.match(await c.eval(screen), /Set model to|Model changed|model switched|now using/i);
      report.checks.push('real UI model change confirmed: ' + id); console.log(report.checks.at(-1));
      await shot(family); await sleep(1000);
    }
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"]');const i=b.querySelector('.floating-input-box');i.textContent='只回复 MODEL_OK';i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click();})()`);
    await until(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(s.id)},opts:{limit:4,fromTail:true}}).then(r=>(r.turns||[]).some(t=>t.role==='assistant'&&String(t.text||'').includes('MODEL_OK')))`, 'Sonnet reply', 120000);
    report.checks.push('real Sonnet prompt after model switch'); await shot('reply'); report.passed = true;
  } catch (error) { report.error = error.stack; if (c) await shot('failure').catch(() => {}); throw error; }
  finally {
    try { if (c) await c.close(); if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); } }
    finally { fs.rmSync(path.join(home, '.credentials.json'), { force: true }); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
