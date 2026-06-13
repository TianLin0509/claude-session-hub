'use strict';
const { Cdp } = require('./e2e-remote-cdp-lib');
(async () => {
  const [port, titleSub, shot] = process.argv.slice(2);
  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.send('Page.enable');
  await cdp.eval(`if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();`);
  await new Promise((r) => setTimeout(r, 1500));
  await cdp.eval(`(() => { const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card')); cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)})).click(); })()`);
  await new Promise((r) => setTimeout(r, 500));
  await cdp.eval(`document.getElementById('rp-mirror-toggle').click()`);
  await new Promise((r) => setTimeout(r, 5000));
  await cdp.screenshot(shot);
  console.log('screenshot:', shot);
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
