'use strict';
// Real isolated Electron/xterm and pointer clicks; synthetic terminal output,
// with no provider request or production session mutation.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-pty-latest-'));
const data = path.join(root, 'data'), work = path.join(root, 'work');
const out = path.resolve('artifacts', '20261005-pty-jump-latest-codex1-' + Date.now());
for (const dir of [data, work, out]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ providers: { codex: {
  subscription_profiles: ['default', 'second'].map(id => ({ id, label: id, home: path.join(root, 'codex-' + id) }))
} } }));
(async () => {
  let hub, client;
  const evidence = { checks: [], boundary: '隔离实际Electron/xterm，模拟输出与CLI滚动协议，无真实AI请求' };
  try {
    const port = await new Promise(resolve => { const s = net.createServer();
      s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'pty-jump-latest', extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_AGENT_RUNTIME: 'pty', AI_HUB_WORKSPACE_ROOT: root,
      CODEX_HOME: path.join(root, 'codex-default'), CLAUDE_CONFIG_DIR: path.join(root, 'claude') } });
    client = await connectFirstPage(hub);
    async function until(expr) { const end = Date.now() + 20000;
      while (!await client.eval(`Boolean(${expr})`)) { if (Date.now() > end) throw Error('timeout: ' + expr); await _waitMs(100); } }
    async function click(selector) {
      const p = await client.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});const r=e.getBoundingClientRect();
        const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('not clickable');return{x,y};})()`);
      for (const type of ['mousePressed', 'mouseReleased'])
        await client.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    }
    await until('!!window.__hubE2E');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    for (const kind of ['claude', 'codex']) {
      const sid = 'latest-' + kind;
      await client.eval(`(async()=>{window.__hubE2E.addFakeSession({id:${JSON.stringify(sid)},kind:${JSON.stringify(kind)},cwd:${JSON.stringify(work)},status:'idle'});
        await window.__hubE2E.selectSession(${JSON.stringify(sid)});})()`);
      await click('#btn-backstage'); await until(`currentView==='pty'`);
      await client.eval(`new Promise(resolve=>terminalCache.get(${JSON.stringify(sid)}).terminal.write(
        Array.from({length:180},(_,i)=>'输出记录 '+i+'\\r\\n').join(''),resolve))`);
      await until(`terminalCache.get(${JSON.stringify(sid)}).terminal.buffer.active.baseY>100`);
      await client.eval(`terminalCache.get(${JSON.stringify(sid)}).terminal.scrollToBottom()`);
      await until(`document.querySelector('.pty-jump-latest').hidden`);
      const point = await client.eval(`(()=>{const r=document.querySelector('.xterm-screen').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await client.send('Input.dispatchMouseEvent', { type: 'mouseWheel', ...point, deltaX: 0, deltaY: -450 });
      await until(`!document.querySelector('.pty-jump-latest').hidden`);
      await client.eval(`document.querySelector('.floating-input-box').textContent='保留这个草稿'`);
      await click('.pty-jump-latest');
      await until(`(()=>{const b=terminalCache.get(${JSON.stringify(sid)}).terminal.buffer.active;return b.viewportY===b.baseY})()`);
      assert(await client.eval(`document.querySelector('.floating-input-box').textContent==='保留这个草稿'`));
      assert(await client.eval(`terminalCache.get(${JSON.stringify(sid)})._codexFollowBottom===true`));
      await until(`document.querySelector('.pty-jump-latest').hidden`);
      await _waitMs(300);
      assert(await client.eval(`terminalCache.get(${JSON.stringify(sid)})._codexFollowBottom===true`), 'follow intent survives the prior wheel gesture');
      await client.eval(`new Promise(resolve=>terminalCache.get(${JSON.stringify(sid)}).terminal.write('后续新输出\\r\\n',resolve))`);
      await until(`(()=>{const b=terminalCache.get(${JSON.stringify(sid)}).terminal.buffer.active;return b.viewportY===b.baseY})()`);
      await click('#btn-backstage');
      assert.equal(await client.eval(`getComputedStyle(document.querySelector('.pty-jump-latest')).display`), 'none');
      assert.equal(await client.eval(`document.querySelectorAll('.pty-jump-latest').length`), 1);
      await click('#btn-backstage');
      evidence.checks.push(kind + '：真实滚轮上翻出现按钮，点击置底、恢复跟随并保留草稿，卡片视图隐藏');
    }
    // A full-screen Codex CLI controls its own history. Verify the actual
    // xterm input event uses the existing Ctrl+End protocol, not an Enter.
    await client.eval(`(async()=>{const t=terminalCache.get('latest-codex').terminal;window.__latestKeys=[];
      t.onData(data=>window.__latestKeys.push(data));await new Promise(r=>t.write('\\x1b[?1049h\\x1b[?1000hCLI 全屏历史',r));})()`);
    await until(`!document.querySelector('.pty-jump-latest').hidden`);
    await click('.pty-jump-latest');
    assert.deepEqual(await client.eval('window.__latestKeys'), ['\x1b[1;5F']);
    evidence.checks.push('Codex全屏：点击发出Ctrl+End历史跳转，未发送Enter或草稿');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'pty-latest.png'), Buffer.from(shot.data, 'base64'));
    evidence.ok = true; evidence.version = require('../package.json').version;
    console.log(JSON.stringify({ ...evidence, out }, null, 2));
  } finally { fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    await client?.close(); if (hub) await gracefulQuit(hub); }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
