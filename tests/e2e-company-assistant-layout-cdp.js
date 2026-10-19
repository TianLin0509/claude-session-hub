'use strict';
// 公司版助理页的布局（2026-10-19 田哥）：从「规则」切到「助理」会叠在一起、要先回主页再切；助理设置页滚轮滚不动。
// 用公司版导出物、真窗口（后台模式，滚轮事件和真鼠标一样会滚动）：
//   规则 → 助理、规则 → 论坛：规则页关掉、页面高度正常；设置盖在对话区上、矮屏（1366×680）下滚轮能滚、「保存」一直看得见。
// 用法：node tests/e2e-company-assistant-layout-cdp.js <公司版导出目录> [输出目录]
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ENTRY = path.resolve(process.argv[2] || '');
const OUT = path.resolve(process.argv[3] || path.join(__dirname, '..', 'output'));
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  assert.ok(fs.existsSync(path.join(ENTRY, 'community-edition.json')), '需要公司版导出目录');
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-layout-'));
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'welink-state'), 'ok');
  fs.writeFileSync(path.join(root, 'welink-exchange'), 'x@example.com');
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = { checks: [], shots: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ entryPath: ENTRY, dataDir: path.join(root, 'data'), port: await freePort(), label: 'ca-layout', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: path.join(root, 'welink-state'), WELINK_STANDIN_PAD: '0' } });
    c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await _waitMs(250); } throw new Error('timeout: ' + label); };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${stamp}-company-assistant-layout-${name}-claude2.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
    const box = id => c.eval(`(() => { const e = document.getElementById(${JSON.stringify(id)}); if (!e || e.hidden || getComputedStyle(e).display === 'none') return null; const r = e.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height) }; })()`);
    await until(`!!document.getElementById('btn-company-assistant') && !!document.getElementById('btn-company-forum') && typeof sessions !== 'undefined'`, 'boot', 60000);

    for (const [btn, pageId, name] of [['btn-company-assistant', 'company-assistant-page', '助理'], ['btn-company-forum', 'company-forum-page', '论坛']]) {
      await c.eval(`document.getElementById('btn-rules').click()`);
      await until(`!!document.getElementById('rules-panel') && getComputedStyle(document.getElementById('rules-panel')).display !== 'none'`, 'rules open');
      await c.eval(`document.getElementById(${JSON.stringify(btn)}).click()`);
      await until(`!document.getElementById(${JSON.stringify(pageId)})?.hidden`, name + ' open');
      await _waitMs(600);
      assert.equal(await box('rules-panel'), null, `规则 → ${name}：规则页关掉了`);
      const b = await box(pageId);
      assert.ok(b && b.height > 600, `规则 → ${name}：页面高度正常（${b && b.height}）`);
      result.checks.push(`从「规则」切到「${name}」：规则页关掉，${name}页高 ${b.height}px，不再被压成一条叠在规则页上`);
    }
    await c.eval(`document.getElementById('btn-company-assistant').click()`);
    await until(`!document.getElementById('company-assistant-page').hidden`, 'assistant');
    await shot('01-rules-then-assistant');

    // 设置：矮屏下盖在对话区上，滚轮能滚，「保存」一直看得见
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1366, height: 680, deviceScaleFactor: 1, mobile: false });
    await c.eval(`document.querySelector('[data-ca="settings"]').click()`);
    await until(`!!document.querySelector('[data-ca="settings-tab:phone"]')`, 'settings');
    await c.eval(`document.querySelector('[data-ca="settings-tab:phone"]').click()`);
    await until(`!!document.querySelector('[data-x="phone-save"]')`, 'phone tab');
    await _waitMs(500);
    const before = await c.eval(`(() => { const p = document.querySelector('[data-slot="panel"]'); const r = p.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2, sh: p.scrollHeight, ch: p.clientHeight, pos: getComputedStyle(p).position }; })()`);
    assert.equal(before.pos, 'absolute', '设置盖在对话区上');
    assert.ok(before.sh > before.ch, '矮屏下设置比可见区高，需要滚动');
    await c.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: before.x, y: before.y, deltaX: 0, deltaY: 600 });
    await _waitMs(700);
    const top = await c.eval(`document.querySelector('[data-slot="panel"]').scrollTop`);
    assert.ok(top > 100, `滚轮滚动了 ${top}px`);
    const saveVisible = await c.eval(`(() => { const r = document.querySelector('[data-x="phone-save"]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`);
    assert.equal(saveVisible, true, '「保存」一直看得见');
    await shot('02-settings-short-screen-scrolled');
    result.checks.push(`矮屏 1366×680：设置盖在对话区上，内容高 ${before.sh}px、可见 ${before.ch}px，滚轮滚动 ${Math.round(top)}px，「保存」固定在底下看得见`);
    await c.eval(`document.activeElement?.blur(); document.getElementById('company-assistant-page').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
    await until(`document.querySelector('[data-slot="panel"]').hidden`, 'esc closes');
    result.checks.push('按 Esc 关掉设置');
    result.passed = true;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
