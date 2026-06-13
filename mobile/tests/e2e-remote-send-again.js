'use strict';
// 给当前选中的远程会话再发一条消息（公司 UI 真实路径）。用法: node e2e-remote-send-again.js <cdpPort> <text>
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, text] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.eval(`
    if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();
  `);
  const sel = await cdp.eval(`document.querySelector('#rp-sessions .rp-session-card.active') ? document.querySelector('#rp-sessions .rp-session-card.active .rp-sc-title').textContent : null`);
  if (!sel) { console.error('no active remote session'); process.exit(1); }
  await cdp.eval(`
    document.getElementById('rp-input').value = ${JSON.stringify(text)};
    document.getElementById('rp-send').click();
  `);
  console.log(`sent to "${sel}": ${text}`);
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
