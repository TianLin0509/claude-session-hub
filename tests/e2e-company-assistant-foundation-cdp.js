'use strict';
// 真实隔离 Hub + 真实 Claude Haiku（CodeAgent 兼容替身）+ 合成 WeLink CLI。
// 点刷新/生成简报/出处/发送问题，验证姓名、全文、会议和增量缓存；公司真机验收另记。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
const pause = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
const output = path.join(__dirname, '..', 'artifacts', '20261019-welink-foundation-codex1');

(async () => {
  fs.mkdirSync(output, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-foundation-e2e-'));
  const dataDir = path.join(root, 'data'), profile = path.join(root, 'codeagent-profile'), state = path.join(root, 'welink-state'), log = path.join(root, 'welink-calls.jsonl');
  fs.mkdirSync(dataDir); fs.mkdirSync(profile);
  fs.writeFileSync(state, 'ok'); fs.writeFileSync(path.join(root, 'welink-exchange'), 'demo@example.com');
  const settingsDir = path.join(dataDir, 'company-assistant'); fs.mkdirSync(settingsDir);
  fs.writeFileSync(path.join(settingsDir, 'settings.json'), j({ enabled: true, workdays: [0, 1, 2, 3, 4, 5, 6], keywords: ['验收'], email: 'demo@example.com', refreshMinutes: 60, briefTime: '23:59' }));
  const sourceAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const copiedAuth = path.join(profile, '.credentials.json');
  const result = { syntheticWelink: true, realHub: true, model: 'Claude Haiku via CodeAgent stand-in', checks: [], screenshots: [], dataDir };
  let hub, c;
  const until = async (expr, label, timeout = 60000) => {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await pause(300); }
    throw new Error('等待超时：' + label);
  };
  const click = async selector => {
    const p = await c.eval(`(() => { const e=document.querySelector(${j(selector)}); if(!e) return null; e.scrollIntoView({block:'center'}); const r=e.getBoundingClientRect(); return {x:r.left+r.width/2,y:r.top+r.height/2}; })()`);
    assert.ok(p, '找不到按钮：' + selector);
    await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const shot = async name => { const png = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(output, `20261019-welink-${name}-codex1.png`); fs.writeFileSync(file, Buffer.from(png.data, 'base64')); result.screenshots.push(file); };
  const calls = () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
  try {
    fs.copyFileSync(sourceAuth, copiedAuth);
    fs.writeFileSync(path.join(profile, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, projects: {} }));
    fs.writeFileSync(path.join(profile, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(profile, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'welink-foundation', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: profile,
      CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_FORUM_TIMER: '0', HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: state, WELINK_STANDIN_LOG: log, WELINK_STANDIN_PAD: '0', WELINK_STANDIN_FOUNDATION: '1',
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`!!document.getElementById('btn-company-assistant')`, '助理入口');
    await click('#btn-company-assistant');
    await until(`!document.getElementById('company-assistant-page')?.hidden && !document.querySelector('[data-ca="refresh"]')?.disabled`, '助理页面');
    await click('[data-ca="refresh"]');
    await until(`!document.querySelector('[data-ca="refresh"]')?.disabled && /条消息/.test(document.querySelector('.ca-coverage')?.innerText || '')`, '刷新完成', 90000);
    const readSnapshot = () => {
      const day = new Date().toLocaleDateString('sv-SE');
      return JSON.parse(fs.readFileSync(path.join(settingsDir, `raw-${day}.json`), 'utf8'));
    };
    const snap = readSnapshot();
    const long = snap.messages['g-100'].find(m => m.account === 'colleague_z');
    assert.equal(long.sender, '示例发言人'); assert.match(long.text, /最终决定：周三交付。$/); assert.ok(long.text.length > 400);
    assert.equal(snap.meetings.length, 4); assert.equal(snap.meetingCoverage.status, 'complete');
    assert.equal(snap.messages['g-200'].length, 140); assert.equal(snap.scope.partial, 0);
    result.checks.push('点击刷新：群独有发言人显示中文姓名，长消息结尾保留，会议成功，多页群消息完整');
    const cold = calls().filter(a => a[0] === 'contact').length;
    await click('[data-ca="refresh"]');
    await until(`!document.querySelector('[data-ca="refresh"]')?.disabled`, '暖缓存刷新', 90000);
    assert.equal(calls().filter(a => a[0] === 'contact').length, cold);
    result.checks.push('再次刷新没有额外联系人查询');
    // 先展开已有清单，再从真实按钮生成简报；两个操作都不直接调用后端 IPC。
    if (await c.eval(`!!document.querySelector('.ca-brief-sum') && document.querySelector('.ca-brief-sum').getAttribute('aria-expanded') !== 'true'`)) await click('.ca-brief-sum');
    await until(`!!document.querySelector('[data-ca="brief-now"]')`, '生成简报按钮');
    await click('[data-ca="brief-now"]');
    const sourceSelector = `[data-ca="source:${long.sourceId}"]`;
    await until(`!!document.querySelector(${j(sourceSelector)})`, '长消息出处', 90000);
    await click(sourceSelector);
    await until(`/最终决定：周三交付。/.test(document.querySelector('.ca-source')?.innerText || '')`, '出处全文');
    assert.ok(await c.eval(`document.querySelector('.ca-source').innerText.includes('示例发言人') && document.querySelector('.ca-source').innerText.includes('colleague_z')`));
    assert.ok(await c.eval(`document.querySelectorAll('.ca-source-message').length >= 2`));
    await shot('01-source-full-text');
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(`document.querySelector('[data-slot="panel"]').hidden`, 'Esc 关闭原文');
    result.checks.push('点击出处看到姓名、账号、完整结尾与上下文；Esc 返回简报');
    const prompt = '这是合成数据验收。先读 data/today.json 找到群 g-100 内“本轮验收材料”这条长消息，报告其发言人中文姓名和完整消息最后的决定。再实际运行本目录 welink-ro.cmd im query-history-message --group-id g-100 --query-count 100，核对其中 colleague_z 的 senderName 和原始 sender，并在回答中同时写出这两个值。只读，不发消息。';
    const beforeAsk = calls().length;
    await click('[data-slot="form"] textarea');
    await c.send('Input.insertText', { text: prompt });
    await click('[data-slot="form"] button[type="submit"]');
    await until(`/示例发言人/.test(document.querySelector('[data-slot="chat"]')?.innerText || '') && /周三交付/.test(document.querySelector('[data-slot="chat"]')?.innerText || '') && /colleague_z/.test(document.querySelector('[data-slot="chat"]')?.innerText || '')`, '真实模型回答', 300000);
    const chat = JSON.parse(fs.readFileSync(path.join(settingsDir, 'chat.json'), 'utf8')).at(-1);
    assert.equal(chat.state, 'done'); assert.match(chat.a, /示例发言人/); assert.match(chat.a, /周三交付/); assert.match(chat.a, /colleague_z/);
    assert.ok(calls().slice(beforeAsk).some(a => a[0] === 'im' && a[1] === 'query-history-message' && a.includes('g-100') && a.includes('100')), '模型回合确实补查了原始聊天');
    result.checks.push('真实 Haiku 读完整材料并调用增强 CLI，回答姓名、账号和尾部结论');
    await shot('02-assistant-answer');
    assert.equal(await c.eval('document.documentElement.scrollWidth > innerWidth + 1'), false);
    result.checks.push('1440×900 无整页横向溢出');
    fs.writeFileSync(state, 'conversations-failed');
    await click('[data-ca="refresh"]');
    await until(`!document.querySelector('[data-ca="refresh"]')?.disabled && /上次数据/.test(document.querySelector('.ca-coverage')?.innerText || '')`, '查询失败仍显示旧消息', 90000);
    const stale = readSnapshot();
    assert.equal(stale.messages['g-100'].find(m => m.sourceId === long.sourceId).text, long.text);
    assert.equal(stale.scope.stale, true); assert.ok(stale.scope.partial > 0);
    await click('.ca-coverage summary');
    assert.ok(await c.eval(`/可能已过期/.test(document.querySelector('.ca-coverage').innerText)`));
    await shot('03-failure-preserves-messages');
    fs.writeFileSync(state, 'ok');
    result.checks.push('合成查询故障：旧消息全文保留，页面展示原采集时间与可能过期提示');
    result.coldContactCalls = cold; result.status = 'passed';
  } catch (error) {
    result.status = 'failed'; result.error = error.stack;
    if (c) await shot('failure').catch(() => {});
    process.exitCode = 1;
  } finally {
    if (c) await c.close().catch(() => {});
    if (hub) {
      try { result.teardown = await gracefulQuit(hub); }
      catch (error) { result.status = 'failed'; result.teardownError = error.message; result.hubLogTail = hub.log().slice(-20); process.exitCode = 1; }
    }
    if (fs.existsSync(copiedAuth)) fs.unlinkSync(copiedAuth);
    fs.writeFileSync(path.join(output, '20261019-welink-foundation-e2e-codex1.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
