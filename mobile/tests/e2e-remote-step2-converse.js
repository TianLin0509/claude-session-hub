'use strict';

// E2E step2：公司 Hub UI 真实操作——选目标 Hub → 新建远程会话 → 发 prompt → 等 Claude 回复 → 截图
// 用法: node e2e-remote-step2-converse.js <cdpPort> <targetHubId> <screenshotPath>

const { Cdp } = require('./e2e-remote-cdp-lib');

(async () => {
  const port = process.argv[2];
  const hubId = process.argv[3];
  const shot = process.argv[4];
  if (!port || !hubId) { console.error('usage: node e2e-remote-step2-converse.js <cdpPort> <hubId> [screenshot]'); process.exit(2); }

  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.send('Page.enable');
  console.log('[step2] CDP connected');

  // 面板若被关掉，重新打开
  await cdp.eval(`
    if (document.getElementById('remote-panel').style.display === 'none') {
      document.getElementById('btn-remote-hub').click();
    }
  `);
  await cdp.waitFor(`document.getElementById('rp-main').style.display !== 'none'`, 10000, 'main view');

  // 刷新 hub 列表，等目标 hub 出现在下拉里
  await cdp.eval(`document.getElementById('rp-refresh').click()`);
  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#rp-hub-select option')).some(o => o.value === ${JSON.stringify(hubId)})`,
    30000, 'target hub in dropdown',
  );
  console.log('[step2] target hub visible in dropdown');

  // 选中目标 hub（真实 change 事件）
  await cdp.eval(`(() => {
    const sel = document.getElementById('rp-hub-select');
    sel.value = ${JSON.stringify(hubId)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  // 等目标 hub 的 session-list 刷新落地（旧选中会话不在新列表会被清掉）
  await new Promise((r) => setTimeout(r, 4000));
  const prevTitle = await cdp.eval(`(() => {
    const el = document.querySelector('#rp-sessions .rp-session-card.active .rp-sc-title');
    return el ? el.textContent : '';
  })()`);

  // 新建远程会话（远端 spawn 真实 claude PTY），等"新标题"的 active 卡出现
  await cdp.eval(`document.getElementById('rp-new-session').click()`);
  console.log('[step2] new-session clicked, waiting for NEW session card…');
  await cdp.waitFor(
    `(() => {
      const el = document.querySelector('#rp-sessions .rp-session-card.active .rp-sc-title');
      return !!(el && el.textContent && el.textContent !== ${JSON.stringify(String(prevTitle || ''))});
    })()`,
    30000, 'remote session created & selected',
  );
  const title = await cdp.eval(`document.querySelector('#rp-sessions .rp-session-card.active .rp-sc-title').textContent`);
  console.log(`[step2] remote session created: ${title}`);

  // 发送测试 prompt（远端 claude 真实执行）
  const PROMPT = '请只回复四个字：链路畅通';
  await cdp.eval(`
    document.getElementById('rp-input').value = ${JSON.stringify(PROMPT)};
    document.getElementById('rp-send').click();
  `);
  console.log('[step2] prompt sent, waiting for remote Claude reply (max 5min)…');

  await cdp.waitFor(
    `Array.from(document.querySelectorAll('.rp-turn.assistant .rp-turn-body')).some(e => e.textContent.includes('链路畅通'))`,
    5 * 60 * 1000, 'assistant reply',
  );
  const replies = await cdp.eval(`Array.from(document.querySelectorAll('.rp-turn.assistant .rp-turn-body')).map(e => e.textContent.slice(0, 120))`);
  console.log(`[step2] PASS: assistant replied: ${JSON.stringify(replies)}`);

  if (shot) {
    await cdp.screenshot(shot);
    console.log(`[step2] screenshot saved: ${shot}`);
  }
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[step2] FAIL:', e.message); process.exit(1); });
