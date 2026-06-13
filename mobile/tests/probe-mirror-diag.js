'use strict';
// 综合诊断镜像：term.write 是否工作 + 重订阅时 pty 事件到达情况 + sessionId 匹配
// 用法: node probe-mirror-diag.js <cdpPort> <cardTitleSub>
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, titleSub] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);

  // 装 pty 事件监听（独立于 remote-mode.js handler）
  await cdp.eval(`(() => {
    const { ipcRenderer } = require('electron');
    window.__ptyLog = [];
    ipcRenderer.on('remote-event', (e, m) => {
      if (m.kind && m.kind.indexOf('pty') === 0) {
        window.__ptyLog.push({ kind: m.kind, sid: m.payload && m.payload.sessionId, len: m.payload && m.payload.dataB64 ? m.payload.dataB64.length : 0 });
      }
    });
    return 'listener on';
  })()`);

  // 打开面板 + 点卡片
  await cdp.eval(`if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();`);
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card'));
    const t = cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)}));
    t.click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));

  // 开镜像
  await cdp.eval(`document.getElementById('rp-mirror-toggle').click()`);
  await new Promise((r) => setTimeout(r, 4000));

  // 测试 term.write 本身
  const writeTest = await cdp.eval(`(() => {
    if (!window.__rpTerm) return 'no-term';
    window.__rpTerm.write('DIAG_WRITE_OK\\r\\n');
    return 'wrote';
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  const termHasDiag = await cdp.eval(`(() => {
    const t = window.__rpTerm; if (!t) return false;
    const b = t.buffer.active;
    for (let i = 0; i < b.length; i++) { const l = b.getLine(i); if (l && l.translateToString(true).includes('DIAG_WRITE_OK')) return true; }
    return false;
  })()`);

  const ptyLog = await cdp.eval(`window.__ptyLog`);

  console.log('write test:', writeTest, '| term shows DIAG:', termHasDiag);
  console.log('pty events received:', JSON.stringify(ptyLog, null, 2));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
