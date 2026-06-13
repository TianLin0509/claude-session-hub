'use strict';

// E2E：一键自更新——公司 Hub UI 真实操作"⟳ 检查更新" → 自动确认 → 应用 → 等待重启
// 用法: node e2e-update-step.js <cdpPort>

const { Cdp } = require('./e2e-remote-cdp-lib');

(async () => {
  const port = process.argv[2];
  if (!port) { console.error('usage: node e2e-update-step.js <cdpPort>'); process.exit(2); }

  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.autoAcceptDialogs();
  console.log('[update-e2e] CDP connected, dialogs auto-accept on');

  await cdp.waitFor(`!!document.getElementById('btn-remote-hub')`, 20000, 'app loaded');
  await cdp.eval(`
    if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();
  `);
  await cdp.waitFor(`document.getElementById('rp-main').style.display !== 'none'`, 15000, 'remote main view');

  await cdp.eval(`document.getElementById('rp-update').click()`);
  console.log('[update-e2e] clicked 检查更新');

  // 等待 info 文案推进到"下载并应用/更新完成/失败"任一终态文案
  await cdp.waitFor(
    `(() => {
      const t = document.getElementById('rp-update-info').textContent;
      return /更新完成|失败|异常|已是最新|需重新下载/.test(t) ? t : false;
    })()`,
    120000, 'update result text',
  );
  const text = await cdp.eval(`document.getElementById('rp-update-info').textContent`);
  console.log(`[update-e2e] result text: ${text}`);
  if (!/更新完成/.test(text)) {
    console.error('[update-e2e] FAIL: expected 更新完成');
    process.exit(1);
  }
  console.log('[update-e2e] PASS: update applied, app should relaunch now');
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[update-e2e] FAIL:', e.message); process.exit(1); });
