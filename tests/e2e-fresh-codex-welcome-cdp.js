'use strict';
// Real isolated Electron + PTY; the local CLI fixture emits only its welcome
// screen. No provider credentials or network AI requests are used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fresh-welcome-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
const out = path.resolve('artifacts', '20261005-fresh-codex-welcome-codex1-' + Date.now());
for (const dir of [data, work, bin, out]) fs.mkdirSync(dir, { recursive: true });
const cli = path.join(bin, 'codex-fixture.js');
fs.writeFileSync(cli, `if(process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); }
else { process.stdout.write('What brings you to this corner of the terminal?\\r\\n› \\r\\n  gpt-6.1-sol high · Context 100% left\\r\\n'); setInterval(()=>{},1000); }`);
fs.writeFileSync(path.join(bin, 'codex.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ runtime: { agent: 'pty' }, providers: {
  codex: { backend: 'subscription', subscription_profiles: ['default', 'second'].map(id => ({
    id, label: id, home: path.join(root, 'codex-' + id) })) } } }));

(async () => {
  let hub, client;
  const evidence = { boundary: 'Real isolated Electron + synthetic PTY welcome; no cloud AI request.', checks: [] };
  try {
    const port = await new Promise(resolve => { const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'background', label: 'fresh-codex-welcome',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', AI_HUB_WORKSPACE_ROOT: root,
        CODEX_HOME: path.join(root, 'codex-default'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        PATH: bin + path.delimiter + process.env.PATH } });
    client = await connectFirstPage(hub);
    async function until(expression, label) {
      const end = Date.now() + 30000;
      while (!await client.eval(`Boolean(${expression})`)) {
        if (Date.now() > end) throw Error('timeout: ' + label);
        await _waitMs(100);
      }
    }
    async function click(selector) {
      const p = await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed', 'mouseReleased'])
        await client.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    }
    await until('!!window.__hubE2E', 'renderer ready');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    const session = await client.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${JSON.stringify(work)},model:'gpt-6.1-sol',effort:'high',mcpProfile:'none'}})`);
    assert(session.id);
    await until(`!!document.querySelector('.session-welcome') && activeSessionId===${JSON.stringify(session.id)}`, 'new welcome');
    await until(`window.__hubE2E.terminalBufferText(${JSON.stringify(session.id)}).includes('What brings')`, 'PTY startup output');
    await _waitMs(2500);
    assert.equal(await client.eval('currentView'), 'card');
    assert.equal(await client.eval('document.querySelectorAll("#msg-overlay>.turn-card").length'), 0);
    assert.equal(await client.eval('document.querySelectorAll("[data-conversation-filter]").length'), 0);
    const snapshot = await client.eval(`({text:document.querySelector('#msg-overlay').innerText,
      status:document.querySelector('.composer-status')?.innerText||'',
      question:detectComposerLiveQuestion(sessions.get(${JSON.stringify(session.id)}),{state:'idle'})})`);
    assert(snapshot.text.includes('今天，想完成什么？'));
    assert(!/绑定|同步暂未完成|rollout not found/.test(snapshot.text));
    assert.equal(snapshot.question, null); assert(!snapshot.status.includes('等你回答'));
    evidence.checks.push('new Codex session shows welcome after CLI startup without history retry or a false question');
    // Confirmations and actual post-submission questions retain their behavior.
    const probes = await client.eval(`(()=>{let line='Proceed? [y/N]';try {
      terminalCache.set('probe',{opened:true,terminal:{buffer:{active:{length:1,
        getLine:()=>({translateToString:()=>line})}}}});const fresh={id:'probe',kind:'codex'};
      const confirm=detectComposerLiveQuestion(fresh,{state:'idle'});
      line='你想采用哪个方案？';
      const question=detectComposerLiveQuestion({...fresh,lastRunStartedAt:Date.now()},{state:'completed'});
      return {confirm,question};}finally{terminalCache.delete('probe');}})()`);
    assert.equal(probes.confirm?.reason, 'confirm'); assert.equal(probes.question?.reason, 'question');
    evidence.checks.push('startup confirmations and questions after real prompt submission still appear');
    await click('[data-welcome-prompt]');
    assert(await client.eval(`document.querySelector('.floating-input-box').textContent.includes('梳理当前项目')`));
    assert.equal(await client.eval('document.querySelectorAll("#msg-overlay>.turn-card").length'), 0);
    evidence.checks.push('welcome shortcut fills a draft without submitting or creating a reply');
    await click('#btn-backstage'); assert.equal(await client.eval('currentView'), 'pty');
    await click('#btn-backstage'); await until('!!document.querySelector(".session-welcome")', 'cached welcome');
    assert(await client.eval(`document.querySelector('.floating-input-box').textContent.includes('梳理当前项目')`));
    evidence.checks.push('backstage round trip preserves both welcome and draft');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'welcome.png'), Buffer.from(shot.data, 'base64'));
    evidence.ok = true; console.log(JSON.stringify({ ok: true, out, checks: evidence.checks }, null, 2));
  } finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    await client?.close(); if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
