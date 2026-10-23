'use strict';

// Isolated GUI fixture: verify the handoff panel never covers native choices.
// No provider, credentials or production sessions are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-attention-'));
  const out = path.resolve('artifacts', 'pty-attention-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const value = server.address().port; server.close(() => resolve(value));
    });
  });
  let hub, client;
  try {
    hub = await launchIsolatedHub({
      dataDir: path.join(root, 'data'), port, label: 'pty-attention',
      extraEnv: {
        CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'),
        AI_HUB_WORKSPACE_ROOT: path.join(root, 'workspaces'), DEEPSEEK_API_KEY: '',
      },
    });
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/i.test(target.url || ''));
    await client.send('Runtime.enable');
    for (let attempt = 0; attempt < 150; attempt++) {
      if (await client.eval('!!(window.__hubE2E && window.LaunchCenter)')) break;
      await _waitMs(100);
    }
    const result = await client.eval(`(() => {
      const id = 'pty-attention-fixture';
      sessions.set(id, { id, kind:'codex', agentRuntime:'pty', title:'原生问答显示验证',
        status:'idle', cwd:${JSON.stringify(root)}, createdAt:Date.now(), lastMessageTime:Date.now() });
      activeSessionId=id; activeMeetingId=null; currentView='pty';
      showTerminal(id,{focus:false});
      observeSessionRuntime(id,{state:'waiting',source:'codex-question',confidence:'authoritative',
        reason:'question',evidence:'请在 Codex 终端回答问题',observedAt:Date.now()});
      updateFloatingBarState();
      const controls=document.querySelector('.floating-input-bar[data-session-id="'+id+'"] .pty-attention-controls');
      if(!controls)throw new Error('PTY attention controls missing');
      const visible=el=>!el.hidden && getComputedStyle(el).display!=='none';
      const terminal=visible(controls);
      _cardHistoryHydratedSid=id; applyViewMode('card');
      const card=visible(controls);
      const secondary=document.createElement('div'); secondary.className='split-secondary';
      const clone=controls.cloneNode(true); secondary.append(clone);
      document.getElementById('terminal-panel').append(secondary);
      const secondaryTerminal=visible(clone);
      secondary.classList.add('card-view-active');
      const secondaryCard=visible(clone); secondary.remove();
      applyViewMode('pty');
      return {terminal,card,secondaryTerminal,secondaryCard,
        state:getSessionRuntimeTruth(sessions.get(id)).state};
    })()`);
    assert.deepEqual(result, {terminal:false,card:true,secondaryTerminal:false,secondaryCard:true,state:'waiting'});
    await client.send('Emulation.setDeviceMetricsOverride', {width:1440,height:960,deviceScaleFactor:1,mobile:false});
    await client.eval(`applyViewMode('card')`);
    assert.equal(await client.eval(`!!document.querySelector('.pty-attention-collapse') && !!document.querySelector('.pty-attention-close')`), true, '等待通知始终提供折叠和关闭');
    const click = async selector => {
      const p = await client.eval(`(() => {const e=document.querySelector(${JSON.stringify(selector)}); const r=e.getBoundingClientRect(); return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      for (const type of ['mousePressed','mouseReleased']) await client.send('Input.dispatchMouseEvent', {type,...p,button:'left',clickCount:1});
    };
    const update = async (state, evidence) => client.eval(`(() => {
      observeSessionRuntime('pty-attention-fixture',{state:${JSON.stringify(state)},source:'codex-question',confidence:'authoritative',reason:'question',evidence:${JSON.stringify(evidence)},observedAt:Date.now()});
      updateFloatingBarState();
    })()`);
    await click('.pty-attention-collapse');
    assert.equal(await client.eval(`document.querySelector('.pty-attention-detail').hidden`), true);
    await update('waiting','请在 Codex 终端回答问题');
    assert.equal(await client.eval(`document.querySelector('.pty-attention-detail').hidden`), true, '心跳不展开已折叠提示');
    await click('.pty-attention-collapse');
    assert.equal(await client.eval(`document.querySelector('.pty-attention-detail').hidden`), false);
    await click('.pty-attention-close');
    await update('waiting','请在 Codex 终端回答问题');
    assert.equal(await client.eval(`document.querySelector('.pty-attention-controls').hidden`), true, '关闭后相同等待不弹回');
    await update('waiting','新的授权问题：'+ '很长的中文提示。'.repeat(1000));
    assert.equal(await client.eval(`document.querySelector('.pty-attention-controls').hidden`), false, '新问题重新提醒');
    assert.equal(await client.eval(`(() => { const e=document.querySelector('.pty-attention-close');const r=e.getBoundingClientRect();return document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e; })()`),true,'长通知关闭按钮仍可直接点击');
    const expanded = await client.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out,'expanded.png'),Buffer.from(expanded.data,'base64'));
    await click('.pty-attention-collapse');
    const collapsed = await client.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out,'collapsed.png'),Buffer.from(collapsed.data,'base64'));
    await click('.pty-attention-close');
    await update('running','正在处理');
    await update('waiting','新的授权问题：'+ '很长的中文提示。'.repeat(1000));
    assert.equal(await client.eval(`document.querySelector('.pty-attention-controls').hidden`),false,'新的等待周期允许相同问题提醒');
    await click('.pty-attention-header button');
    assert.equal(await client.eval(`getComputedStyle(document.querySelector('.pty-attention-controls')).display`),'none','到终端处理仍可用');
    const shot = await client.send('Page.captureScreenshot', {format:'png'});
    fs.writeFileSync(path.join(out,'terminal.png'),Buffer.from(shot.data,'base64'));
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify({passed:true,...result},null,2));
    console.log(JSON.stringify({passed:true,out,...result}));
  } finally {
    if (client) client.ws.close();
    if (hub) await gracefulQuit(hub);
  }
}
main().catch(error => { console.error(error); process.exitCode=1; });
