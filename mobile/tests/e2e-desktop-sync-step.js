'use strict';

// E2E：桌面会话直通——公司 Hub UI 选目标 Hub → 点"桌面会话"卡片 → 发 prompt →
// 等家里 Hub 真实会话回复（HUB_DELTA）→ 截图
// 用法: node e2e-desktop-sync-step.js <cdpPort> <targetHubId> <cardTitleSubstr> <screenshotPath>

const { Cdp } = require('./e2e-remote-cdp-lib');

(async () => {
  const [port, hubId, titleSub, shot] = process.argv.slice(2);
  if (!port || !hubId || !titleSub) {
    console.error('usage: node e2e-desktop-sync-step.js <cdpPort> <hubId> <cardTitleSubstr> [screenshot]');
    process.exit(2);
  }

  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.send('Page.enable');
  console.log('[desktop-e2e] CDP connected');

  await cdp.waitFor(`!!document.getElementById('btn-remote-hub')`, 20000, 'app loaded');
  await cdp.eval(`
    if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();
  `);
  await cdp.waitFor(`document.getElementById('rp-main').style.display !== 'none'`, 15000, 'remote main view');

  // 选目标 hub
  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#rp-hub-select option')).some(o => o.value === ${JSON.stringify(hubId)})`,
    30000, 'target hub in dropdown',
  );
  await cdp.eval(`(() => {
    const sel = document.getElementById('rp-hub-select');
    sel.value = ${JSON.stringify(hubId)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  console.log('[desktop-e2e] target hub selected, waiting for desktop cards…');

  // 等桌面卡片出现并点击目标卡片
  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#rp-sessions .rp-session-card .rp-sc-title')).some(e => e.textContent.includes(${JSON.stringify(titleSub)}))`,
    30000, 'desktop card visible',
  );
  await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card'));
    const target = cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)}));
    target.click();
  })()`);
  console.log('[desktop-e2e] desktop card clicked');

  const PROMPT = '请只回复四个字：桌面直通';
  await cdp.eval(`(() => {
    document.getElementById('rp-input').value = ${JSON.stringify(PROMPT)};
    document.getElementById('rp-send').click();
  })()`);
  console.log('[desktop-e2e] prompt sent, waiting reply (max 5min)…');

  await cdp.waitFor(
    `Array.from(document.querySelectorAll('.rp-turn.assistant .rp-turn-body')).some(e => e.textContent.includes('桌面直通'))`,
    5 * 60 * 1000, 'assistant reply via hub-delta',
  );
  const replies = await cdp.eval(`Array.from(document.querySelectorAll('.rp-turn.assistant .rp-turn-body')).map(e => e.textContent.slice(0, 100))`);
  console.log(`[desktop-e2e] PASS: ${JSON.stringify(replies)}`);

  if (shot) {
    await cdp.screenshot(shot);
    console.log(`[desktop-e2e] screenshot: ${shot}`);
  }
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[desktop-e2e] FAIL:', e.message); process.exit(1); });
