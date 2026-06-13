'use strict';
// 让外部监听器自己把 pty 数据写进 __rpTerm，验证 handler 的 mirror 条件是否是问题根源
// 用法: node probe-mirror-diag2.js <cdpPort> <cardTitleSub>
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, titleSub] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);

  await cdp.eval(`(() => {
    const { ipcRenderer } = require('electron');
    window.__extWrites = 0;
    ipcRenderer.on('remote-event', (e, m) => {
      if ((m.kind === 'pty-snapshot' || m.kind === 'pty-data') && window.__rpTerm && m.payload && m.payload.dataB64) {
        window.__rpTerm.write(Buffer.from(m.payload.dataB64, 'base64').toString('utf8'));
        window.__extWrites++;
      }
    });
    return 'on';
  })()`);

  await cdp.eval(`if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();`);
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card'));
    cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)})).click();
  })()`);
  await new Promise((r) => setTimeout(r, 500));
  await cdp.eval(`document.getElementById('rp-mirror-toggle').click()`);
  await new Promise((r) => setTimeout(r, 5000));

  const out = await cdp.eval(`(() => {
    const t = window.__rpTerm; if (!t) return { err: 'no-term' };
    const b = t.buffer.active;
    let s = '';
    for (let i = Math.max(0, b.length - 30); i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n'; }
    return { extWrites: window.__extWrites, tailLen: s.trim().length, tail: s.slice(-220) };
  })()`);
  console.log(JSON.stringify(out, null, 2));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
