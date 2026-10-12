'use strict';
// 隔离实例里真实挂载一张 CodeAgent 会话的回答卡片（回合带 Claude 格式的 kind:'claude'），
// 核对头像是 CodeAgent（智谱画像）且图片真的加载出来。
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

(async () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codeagent-avatar-'));
  const out = process.argv[2] || temp;
  let hub, cdp, ok = false;
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await port(), label: 'codeagent-avatar' });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 0, mobile: false });
    const end = Date.now() + 30000;
    while (!(await cdp.eval('typeof sessions!=="undefined" && typeof window._mountSessionTurnCard==="function"'))) {
      if (Date.now() > end) throw Error('renderer not ready'); await _waitMs(100);
    }
    const result = await cdp.eval(`(async () => {
      const sid = 'codeagent-avatar-e2e';
      sessions.set(sid, { id: sid, kind: 'codeagent', title: 'CodeAgent 头像', status: 'idle', createdAt: Date.now(), lastMessageTime: Date.now() });
      activeMeetingId = null; activeSessionId = sid; currentView = 'card';
      document.getElementById('terminal-panel').style.display = '';
      document.getElementById('terminal-panel').classList.remove('home-active');
      const empty = document.getElementById('empty-state'); if (empty) empty.style.display = 'none';
      const overlay = document.getElementById('msg-overlay'); overlay.innerHTML = ''; overlay.classList.remove('hidden');
      window._sessionTurns.clear();
      window._mountSessionTurnCard(sid, { id: 'q1', role: 'user', kind: 'claude', text: '你好', ts: Date.now() }, { kind: 'codeagent' });
      window._mountSessionTurnCard(sid, { id: 'a1', role: 'assistant', kind: 'claude', model: 'GLM-5.2', text: '你好，我是 CodeAgent。', ts: Date.now() + 1 }, { kind: 'codeagent' });
      const img = overlay.querySelector('.turn-card.assistant .turn-avatar img');
      if (!img) return { missing: true };
      if (!img.complete) await new Promise(r => { img.onload = img.onerror = r; setTimeout(r, 5000); });
      return { src: img.getAttribute('src'), alt: img.getAttribute('alt'), width: img.naturalWidth, agent: overlay.querySelector('.turn-card.assistant').dataset.responseAgent };
    })()`);
    console.log(JSON.stringify(result));
    const png = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'codeagent-card-avatar.png'), Buffer.from(png.data, 'base64'));
    assert.equal(result.src, 'assets/ai-avatars/cel-v2/glm.png', 'CodeAgent 卡片用智谱画像');
    assert.ok(result.width > 0, '头像图片已加载');
    assert.equal(result.agent, 'codeagent');
    ok = true;
  } finally {
    if (cdp) try { cdp.close(); } catch {}
    if (hub) await gracefulQuit(hub);
  }
  console.log(ok ? 'e2e-codeagent-card-avatar: OK' : 'e2e-codeagent-card-avatar: FAIL');
  process.exit(ok ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });
