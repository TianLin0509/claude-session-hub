'use strict';
// Real isolated Electron + PTY; the local CLI fixture emits only its welcome
// screen. No provider credentials or network AI requests are used.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-fresh-welcome-'));
const data = path.join(root, 'data'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
const out = path.resolve('artifacts', '20261005-fresh-cli-welcome-codex1-' + Date.now());
for (const dir of [data, work, bin, out]) fs.mkdirSync(dir, { recursive: true });
const cli = path.join(bin, 'codex-fixture.js');
fs.writeFileSync(cli, `if(process.argv.includes('--version')) { console.log('codex-cli 0.0.0'); }
else { process.stdout.write('What brings you to this corner of the terminal?\\r\\n› \\r\\n  gpt-6.1-sol high · Context 100% left\\r\\n'); setInterval(()=>{},1000); }`);
for (const name of ['codex', 'claude', 'gemini', 'kimi']) fs.writeFileSync(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
const accounts = path.join(bin, 'accounts-fixture.js');
fs.writeFileSync(accounts, `console.log(JSON.stringify({state:'signed_in',accounts:[]}));`);
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ runtime: { agent: 'pty' }, providers: {
  deepseek: { api_key: 'unused-local-fixture' },
  codex: { backend: 'subscription', subscription_profiles: ['default', 'second'].map(id => ({
    id, label: id, home: path.join(root, 'codex-' + id) })) } } }));

(async () => {
  let hub, client;
  const evidence = { boundary: 'Real isolated Electron + synthetic PTY welcome and transcript fixtures; no cloud AI request.', checks: [] };
  let claudeSession;
  try {
    const port = await new Promise(resolve => { const server = net.createServer();
      server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, windowMode: 'background', label: 'fresh-cli-welcome',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', AI_HUB_WORKSPACE_ROOT: root,
        CLAUDE_HUB_ACCOUNT_FIXTURE: accounts,
        CODEX_HOME: path.join(root, 'codex-default'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
        GEMINI_CLI_HOME: path.join(root, 'gemini'), KIMI_CODE_HOME: path.join(root, 'kimi'), KIMI_BIN: path.join(bin, 'kimi.cmd'),
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
    for (const kind of ['claude', 'gemini', 'kimi', 'codex', 'deepseek']) {
      console.log('Checking new ' + kind + ' session');
      const session = await client.eval(`ipcRenderer.invoke('create-session',{kind:${JSON.stringify(kind)},opts:{cwd:${JSON.stringify(work)},mcpProfile:'none'}})`);
      assert.equal(session.freshLaunch, true, kind + ' launch intent');
      if (kind === 'claude') claudeSession = session;
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
      evidence.checks.push(kind + ': new session shows welcome after CLI startup without history retry or a false question');
      // Confirmations and actual post-submission questions retain their behavior.
      const probes = await client.eval(`(()=>{let line='Proceed? [y/N]';try {
        terminalCache.set('probe',{opened:true,terminal:{buffer:{active:{length:1,
          getLine:()=>({translateToString:()=>line})}}}});const fresh={id:'probe',kind:${JSON.stringify(kind)},freshLaunch:true,ccSessionId:${JSON.stringify(kind === 'claude' ? session.ccSessionId : null)}};
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
      // An empty incremental refresh repairs a startup placeholder and preserves real cards.
      const refresh = await client.eval(`(async()=>{document.querySelector('#msg-overlay').innerHTML='<div class="msg-overlay-placeholder">pending</div>';await loadSessionHistoryToOverlay(${JSON.stringify(session.id)},{incremental:true});return !!document.querySelector('.session-welcome');})()`);
      assert.equal(refresh,true,kind + ' incremental welcome');
      evidence.checks.push(kind + ': empty incremental refresh also displays welcome');
      const shot = await client.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, kind + '-welcome.png'), Buffer.from(shot.data, 'base64'));
    }
    // Real disk projection must supersede the welcome, even for a launch that
    // is still marked unused before its first lifecycle event arrives.
    const history = path.join(root, 'claude', 'projects', 'fixture', claudeSession.ccSessionId + '.jsonl');
    fs.mkdirSync(path.dirname(history), { recursive: true });
    await client.eval(`(async()=>{sessions.get(${JSON.stringify(claudeSession.id)}).transcriptPath=${JSON.stringify(history)};await selectSession(${JSON.stringify(claudeSession.id)});await loadSessionHistoryToOverlay(${JSON.stringify(claudeSession.id)});})()`);
    assert(await client.eval('!!document.querySelector("#msg-overlay>.session-welcome")'));
    evidence.checks.push('preallocated Claude transcript path without a file still shows welcome');
    const timestamp = new Date().toISOString();
    fs.writeFileSync(history, [
      {type:'user',uuid:'welcome-test-user',timestamp,sessionId:claudeSession.ccSessionId,message:{role:'user',content:'首个真实记录问题'}},
      {type:'assistant',uuid:'welcome-test-answer',timestamp,sessionId:claudeSession.ccSessionId,message:{id:'answer',role:'assistant',model:'claude',stop_reason:'end_turn',content:[{type:'text',text:'已有回答保持可见，欢迎页应消失'}]}},
    ].map(JSON.stringify).join('\n') + '\n');
    await client.eval(`(async()=>{sessions.get(${JSON.stringify(claudeSession.id)}).transcriptPath=${JSON.stringify(history)};await selectSession(${JSON.stringify(claudeSession.id)});await loadSessionHistoryToOverlay(${JSON.stringify(claudeSession.id)});})()`);
    await until(`document.querySelector('#msg-overlay').innerText.includes('已有回答保持可见')`, 'actual history supersedes welcome');
    assert.equal(await client.eval('!!document.querySelector("#msg-overlay>.session-welcome")'), false);
    await client.eval(`loadSessionHistoryToOverlay(${JSON.stringify(claudeSession.id)},{incremental:true})`);
    assert(await client.eval('document.querySelector("#msg-overlay").innerText.includes("已有回答保持可见")'));
    evidence.checks.push('Claude real transcript projection replaces welcome and survives incremental refresh');
    fs.unlinkSync(history); // Only this test's own transcript fixture.
    const missing = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${JSON.stringify(claudeSession.id)}})`);
    assert.match(missing.error, /ENOENT/);
    evidence.checks.push('a transcript lost after actual history was observed remains a visible error');
    evidence.ok = true; console.log(JSON.stringify({ ok: true, out, checks: evidence.checks }, null, 2));
  } finally {
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2), 'utf8');
    await client?.close(); if (hub) await gracefulQuit(hub);
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
