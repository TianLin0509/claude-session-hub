'use strict';
// 公司版助理会话常驻侧栏（2026-10-18 田哥在公司 2.1.10：助理答得了，但左侧会话栏里没有它、「打开会话」也打不开）。
// 公司侧栏有「特战 / 置顶 / 今天·3天 / 项目 / 模型」筛选，任何一个都会把助理会话筛掉。现在助理单独放在最上面的「助理」一栏。
// 用公司版导出物跑（只有公司版有「特战」开关）：
//   没开会话时显示「公司助理 · 点击打开」→ 打开「特战」「置顶」后仍在 → 点它打开助理会话并选中 → 筛选下仍显示会话本身。
// 用法：node tests/e2e-company-assistant-resident-cdp.js <公司版导出目录> [输出目录]
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-resident-'));
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data');
  for (const d of [cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(cac, '.credentials.json'));
  const j = JSON.stringify;
  fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
  fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
  fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
  fs.writeFileSync(path.join(root, 'welink-state'), 'ok');
  const d = new Date(), stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  const result = { checks: [], shots: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), entryPath: ENTRY, label: 'ca-resident', windowMode: 'hidden', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_ASSISTANT_TIMER: '0',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: path.join(root, 'welink-state'), WELINK_STANDIN_PAD: '0' } });
    c = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/i.test(t.url || ''));
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await _waitMs(300); } throw new Error('timeout: ' + label); };
    const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(OUT, `${stamp}-company-assistant-resident-${name}-claude2.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
    const list = () => c.eval(`document.getElementById('session-list').innerText`);
    await until(`typeof sessions !== 'undefined' && !!document.getElementById('btn-company-assistant') && !!document.querySelector('.sec-resident')`, 'resident section');

    // ① 还没开过助理会话：「助理」一栏里是「公司助理 · 点击打开」
    assert.match(await list(), /助理[\s\S]*公司助理[\s\S]*点击打开/);
    result.checks.push('没开过助理会话时，侧栏最上面有「助理」一栏，显示「公司助理 · 点击打开」');
    // ② 打开「特战」（只看特战队会话）和「置顶」：助理一栏还在
    await c.eval(`document.getElementById('btn-sidebar-wireless').click()`);
    await c.eval(`document.querySelector('[data-session-days="pinned"]')?.click()`);
    await _waitMs(500);
    assert.equal(await c.eval(`document.getElementById('btn-sidebar-wireless').getAttribute('aria-pressed')`), 'true', '特战开着');
    assert.match(await list(), /公司助理/);
    await shot('01-placeholder-with-filters');
    result.checks.push('打开「特战」「置顶」筛选后，「助理」一栏照样在');
    // ③ 点占位行：恢复或新开助理会话，并选中它
    await c.eval(`document.querySelector('.resident-placeholder').click()`);
    await until(`(() => { const s = [...sessions.values()].find(x => x.purpose === 'company-assistant'); return s && typeof activeSessionId !== 'undefined' && activeSessionId === s.id; })()`, 'assistant session opened', 120000);
    await until(`!document.querySelector('.resident-placeholder') && [...document.querySelectorAll('.sec-resident ~ .session-item')].some(e => /公司助理/.test(e.innerText))`, 'resident row is the session', 30000);
    const rows = await c.eval(`[...document.querySelectorAll('#session-list .session-item')].filter(e => /公司助理/.test(e.innerText)).length`);
    assert.equal(rows, 1, '助理会话只出现一次（不在普通分组里重复）');
    await _waitMs(800);
    await shot('02-opened-with-filters');
    result.checks.push('点「点击打开」：助理会话被打开并选中；在「特战」「置顶」筛选下侧栏照样显示它，只出现一次');
    // ④ 助理页的「打开会话」按钮也走同一条路
    await c.eval(`document.getElementById('btn-company-assistant').click()`);
    await until(`!document.getElementById('company-assistant-page').hidden`, 'assistant page');
    await c.eval(`document.querySelector('[data-ca="open-session"]').click()`);
    await until(`document.getElementById('company-assistant-page').hidden && (() => { const s = [...sessions.values()].find(x => x.purpose === 'company-assistant'); return s && activeSessionId === s.id; })()`, 'open-session button', 30000);
    result.checks.push('助理页底部「打开会话」：关掉助理页、选中助理会话');
    result.passed = true;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
