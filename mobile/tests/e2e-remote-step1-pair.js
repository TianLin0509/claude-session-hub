'use strict';

// E2E step1：公司 Hub UI 真实操作——打开远程面板 → 填 PIN → 配对 → 等连接成功
// 用法: node e2e-remote-step1-pair.js <cdpPort> <pin>

const { Cdp } = require('./e2e-remote-cdp-lib');

(async () => {
  const port = process.argv[2];
  const pin = process.argv[3];
  if (!port || !pin) { console.error('usage: node e2e-remote-step1-pair.js <cdpPort> <pin>'); process.exit(2); }

  const cdp = new Cdp();
  await cdp.connect(port);
  console.log('[step1] CDP connected');

  await cdp.waitFor(`!!document.getElementById('btn-remote-hub')`, 20000, 'app loaded');
  await cdp.eval(`document.getElementById('btn-remote-hub').click()`);
  console.log('[step1] clicked 远程 button');

  await cdp.waitFor(
    `document.getElementById('remote-panel').style.display !== 'none'`,
    10000, 'remote panel visible',
  );

  const configured = await cdp.eval(`document.getElementById('rp-main').style.display !== 'none'`);
  if (configured) {
    console.log('[step1] already configured, skip pairing');
  } else {
    await cdp.waitFor(`document.getElementById('rp-setup').style.display !== 'none'`, 5000, 'setup form');
    await cdp.eval(`(() => {
      const pinEl = document.getElementById('rp-pin');
      pinEl.value = ${JSON.stringify(pin)};
      pinEl.dispatchEvent(new Event('input', { bubbles: true }));
      document.getElementById('rp-pair-btn').click();
    })()`);
    console.log('[step1] PIN filled, pair clicked');
    await cdp.waitFor(
      `document.getElementById('rp-main').style.display !== 'none'
        || document.getElementById('rp-setup-msg').className.includes('err')`,
      25000, 'pair result',
    );
    const err = await cdp.eval(`document.getElementById('rp-setup-msg').className.includes('err') ? document.getElementById('rp-setup-msg').textContent : ''`);
    if (err) { console.error(`[step1] FAIL: ${err}`); process.exit(1); }
  }

  // 等连接到网关 + 链路正常
  await cdp.waitFor(
    `document.querySelector('#rp-conn .rp-conn-text') && ['链路正常','远端 Hub 离线'].includes(document.querySelector('#rp-conn .rp-conn-text').textContent)`,
    20000, 'gateway connected',
  );
  const connText = await cdp.eval(`document.querySelector('#rp-conn .rp-conn-text').textContent`);
  console.log(`[step1] PASS: paired & connected, conn=${connText}`);
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[step1] FAIL:', e.message); process.exit(1); });
