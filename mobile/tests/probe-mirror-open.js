'use strict';
// 调试：UI 点击打开镜像后，看 term 是否收到数据。用法: node probe-mirror-open.js <cdpPort> <cardTitleSub>
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, titleSub] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.eval(`if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();`);
  await new Promise((r) => setTimeout(r, 1500));
  // 点目标卡片
  const clicked = await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card'));
    const t = cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)}));
    if (!t) return 'card-not-found';
    t.click(); return 'clicked';
  })()`);
  console.log('card:', clicked);
  await new Promise((r) => setTimeout(r, 500));
  const tb = await cdp.eval(`document.getElementById('rp-chat-toolbar').style.display`);
  console.log('toolbar display:', tb);
  await cdp.eval(`document.getElementById('rp-mirror-toggle').click()`);
  console.log('mirror toggled, waiting 6s for data…');
  await new Promise((r) => setTimeout(r, 6000));
  const state = await cdp.eval(`(() => {
    const t = window.__rpTerm;
    if (!t) return { hasTerm: false };
    const b = t.buffer.active;
    let s = '';
    for (let i = Math.max(0, b.length - 20); i < b.length; i++) { const l = b.getLine(i); if (l) s += l.translateToString(true) + '\\n'; }
    return { hasTerm: true, cols: t.cols, rows: t.rows, bufLen: b.length, tailLen: s.trim().length, tail: s.slice(-200) };
  })()`);
  console.log('term state:', JSON.stringify(state, null, 2));
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
