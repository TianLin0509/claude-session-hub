'use strict';

// E2E：终端镜像——公司 Hub UI 选桌面卡片 → 点"⌨ 终端镜像" → 等家里终端画面同步 →
// 按键直通发 prompt → 等 Claude 回复出现在镜像屏幕 → 截图
// 用法: node e2e-mirror-step.js <cdpPort> <targetHubId> <cardTitleSubstr> <screenshotPath>

const { Cdp } = require('./e2e-remote-cdp-lib');

// 扫描整个 xterm buffer（claude 全屏 TUI 内容散布在各行，不能只读尾部）
const TERM_TAIL = `(() => {
  const t = window.__rpTerm;
  if (!t) return '';
  const b = t.buffer.active;
  let s = '';
  for (let i = 0; i < b.length; i++) {
    const line = b.getLine(i);
    if (line) s += line.translateToString(true) + '\\n';
  }
  return s;
})()`;

(async () => {
  const [port, hubId, titleSub, shot] = process.argv.slice(2);
  if (!port || !hubId || !titleSub) {
    console.error('usage: node e2e-mirror-step.js <cdpPort> <hubId> <cardTitleSubstr> [screenshot]');
    process.exit(2);
  }

  const cdp = new Cdp();
  await cdp.connect(port);
  await cdp.send('Page.enable');
  console.log('[mirror-e2e] CDP connected');

  await cdp.waitFor(`!!document.getElementById('btn-remote-hub')`, 20000, 'app loaded');
  await cdp.eval(`
    if (document.getElementById('remote-panel').style.display === 'none') document.getElementById('btn-remote-hub').click();
  `);
  await cdp.waitFor(`document.getElementById('rp-main').style.display !== 'none'`, 15000, 'remote main view');

  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#rp-hub-select option')).some(o => o.value === ${JSON.stringify(hubId)})`,
    30000, 'target hub in dropdown',
  );
  await cdp.eval(`(() => {
    const sel = document.getElementById('rp-hub-select');
    sel.value = ${JSON.stringify(hubId)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);

  await cdp.waitFor(
    `Array.from(document.querySelectorAll('#rp-sessions .rp-session-card .rp-sc-title')).some(e => e.textContent.includes(${JSON.stringify(titleSub)}))`,
    30000, 'desktop card visible',
  );
  await cdp.eval(`(() => {
    const cards = Array.from(document.querySelectorAll('#rp-sessions .rp-session-card'));
    cards.find(c => c.querySelector('.rp-sc-title').textContent.includes(${JSON.stringify(titleSub)})).click();
  })()`);
  console.log('[mirror-e2e] desktop card selected');

  await cdp.waitFor(`document.getElementById('rp-chat-toolbar').style.display !== 'none'`, 8000, 'toolbar visible');
  await cdp.eval(`document.getElementById('rp-mirror-toggle').click()`);
  console.log('[mirror-e2e] mirror opened, waiting for screen sync…');

  // 等家里终端画面（claude TUI 特征：bypass permissions / Claude Code）同步到镜像
  await cdp.waitFor(
    `(${TERM_TAIL}).includes('bypass permissions') || (${TERM_TAIL}).includes('Claude Code')`,
    30000, 'terminal screen synced',
  );
  const screen1 = await cdp.eval(TERM_TAIL);
  console.log(`[mirror-e2e] screen synced (${screen1.trim().length} non-empty chars)`);

  // 按键直通发 prompt（先文本后回车，模拟真实键入节奏）
  await cdp.eval(`window.__rpTermSend(${JSON.stringify('请只回复四个字：镜像直通')})`);
  await new Promise((r) => setTimeout(r, 800));
  await cdp.eval(`window.__rpTermSend('\\r')`);
  console.log('[mirror-e2e] prompt typed via PTY input, waiting for reply on mirror screen (max 5min)…');

  // claude 回复出现：镜像屏幕上"镜像直通"出现 ≥2 次（一次回显输入，一次 assistant 回复）
  await cdp.waitFor(
    `((${TERM_TAIL}).match(/镜像直通/g) || []).length >= 2`,
    5 * 60 * 1000, 'reply visible on mirror',
  );
  const finalScreen = await cdp.eval(TERM_TAIL);
  const hits = (finalScreen.match(/镜像直通/g) || []).length;
  console.log(`[mirror-e2e] PASS: 镜像屏幕"镜像直通"出现 ${hits} 次（输入回显 + Claude 回复均已镜像回流）`);

  if (shot) {
    await cdp.screenshot(shot);
    console.log(`[mirror-e2e] screenshot: ${shot}`);
  }
  cdp.close();
  process.exit(0);
})().catch((e) => { console.error('[mirror-e2e] FAIL:', e.message); process.exit(1); });
