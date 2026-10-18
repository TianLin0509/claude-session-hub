'use strict';
// 真实验收（替身）：公司版「助理」页在隔离 Hub 里的完整链路（2026-10-16）。
//   WeLink 用假 welink-cli（tests/fixtures/welink-cli-standin.js，占位数据）；CodeAgent 用替身（真 Claude Code，配置成 haiku）。
//   覆盖：左侧「助理」按钮 → 登录过期提示 → 扫码面板出二维码 → 登录后自动取数、生成简报（先清单、再 AI 版，逐条带出处）→
//   点小标签提问、拿到回答 → 会前准备提醒弹出 → 假 welink-cli 收到的全是查询命令（扫码登录除外）。
//   截图（1440 宽）存 output/。凭据复制进临时目录，finally 删除。
//   node tests/e2e-company-assistant-real.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { checkArgs } = require('../core/company-assistant/welink');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CODEAGENT = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-assistant-'));
  const out = path.resolve(__dirname, '..', 'output'); fs.mkdirSync(out, { recursive: true });
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), log = path.join(root, 'welink-calls.log'), state = path.join(root, 'welink-state');
  for (const d of [cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(state, 'expired');
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const result = { checks: [], shots: [] };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(400); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, `${stamp}-company-assistant-${name}-claude1.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
  const status = () => c.eval(`ipcRenderer.invoke('company-assistant:status')`);
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    // 助理会话不指定模型（用 CodeAgent 的默认）：替身里用配置把默认设成 haiku，省额度。
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company-assistant', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: CODEAGENT, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: state } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!document.getElementById("btn-company-assistant")', 'rail button', 60000);
    // 测试可能在周末跑：把工作日设成每天（只改隔离实例的设置）。
    await c.eval(`ipcRenderer.invoke('company-assistant:set-settings', { workdays: [0,1,2,3,4,5,6] })`);
    const order = await c.eval(`[...document.querySelectorAll('#scene-rail .rail-navigation > button')].filter(b => !b.hidden && getComputedStyle(b).display !== 'none').map(b => b.id)`);
    assert.equal(order[order.indexOf('btn-rules') + 1], 'btn-company-assistant', order.join(','));
    const assistantNavs = await c.eval(`[...document.querySelectorAll('#scene-rail button')].filter(b => b.offsetParent !== null && /助理/.test(b.querySelector('.btn-label')?.textContent || '')).map(b => b.id)`);
    assert.deepEqual(assistantNavs, ['btn-company-assistant'], '公司版左侧只有一个「助理」，打开的是公司助理页');
    result.checks.push('左侧只有一个「助理」按钮（公司助理页），在「规则」下面');

    // ① 打开：登录过期
    await c.eval(`document.getElementById('btn-company-assistant').click()`);
    await until(`!document.getElementById('company-assistant-page')?.hidden && /登录已过期/.test(document.querySelector('.ca-status')?.innerText || '')`, 'expired chip', 60000);
    await until(`/扫码登录/.test(document.querySelector('[data-slot="brief"]')?.innerText || '')`, 'brief says login', 30000);
    await shot('01-login-expired');
    result.checks.push('登录过期：顶部标出、简报提示扫码登录');

    // ② 扫码：二维码出现，登录后自动取数、出简报
    await c.eval(`document.querySelector('[data-ca="login"]').click()`);
    await until(`!!document.querySelector('.ca-qr')`, 'qr image', 30000);
    await shot('02-qr');
    await until(`/WeLink 已登录/.test(document.querySelector('.ca-status')?.innerText || '')`, 'logged in', 60000);
    await until(`!!document.querySelector('.ca-brief-sum')`, 'list brief', 90000);
    result.checks.push('扫码面板显示二维码；登录后状态变为已登录并生成简报');
    const s1 = await status();
    // 2026-10-17：邮箱从 WeLink 账号自动读到并配好邮件和日历，不再要用户点「初始化日历」、也不让助理在对话里问。
    assert.equal(s1.calendarNeedsSetup, false);
    assert.equal(s1.mailSetup && s1.mailSetup.from, 'welink');
    assert.ok(/邮件和日历已接入/.test(await c.eval(`document.querySelector('.ca-status').innerText`)));
    await c.eval(`document.querySelector('[data-ca="settings"]').click()`);
    await until(`!!document.querySelector('.ca-tab')`, 'settings tabs', 10000);
    await c.eval(`document.querySelector('[data-ca="settings-tab:welink"]').click()`);
    await until(`/从 WeLink 账号自动读到/.test(document.querySelector('.ca-tab-body')?.innerText || '')`, 'welink tab email', 10000);
    assert.equal(await c.eval(`document.querySelector('[data-f="email"]').value`), 'user001@example.com');
    await shot('02b-settings-welink');
    // 2026-10-18：「简报与提醒」页不再勾关注群，改成「聊天记录范围」，并写明上次取到多少会话和消息（假 welink-cli 有 17 个会话，第 10 名以后的也要取到）
    await c.eval(`document.querySelector('[data-ca="settings-tab:brief"]').click()`);
    await until(`/聊天记录范围/.test(document.querySelector('.ca-tab-body')?.innerText || '') && /上次取到 \\d+ 个会话/.test(document.querySelector('.ca-tab-body')?.innerText || '')`, 'brief tab scope', 10000);
    const scopeText = await c.eval(`document.querySelector('.ca-tab-body').innerText`);
    assert.ok(!/关注的群/.test(scopeText), '关注群设置已去掉');
    assert.match(scopeText, /上次取到 4 个会话（单聊 2、群 2）/);
    await shot('02c-settings-brief-scope');
    result.checks.push('设置「简报与提醒」：关注群换成聊天记录范围（回看时长、会话个数），显示上次取到 4 个会话（含列表第 10 名以后的）');
    await c.eval(`document.querySelector('[data-ca="close-panel"]').click()`);
    result.checks.push('邮件和日历：登录后自动从 WeLink 读邮箱配好；设置「WeLink 与邮箱」页显示邮箱来源和各项取数结果');

    // ③ AI 版简报（真 CodeAgent 替身作答）
    await until(`ipcRenderer.invoke('company-assistant:status').then(s => s.brief && s.brief.by === 'ai' && !s.brief.organizing)`, 'ai brief', 300000);
    const s2 = await status();
    result.brief = { by: s2.brief.by, total: s2.brief.total, dropped: s2.brief.dropped, sections: s2.brief.sections.map(x => `${x.title}:${x.items.length}`) };
    assert.ok(s2.brief.total >= 1 && s2.brief.total <= 10 + s2.brief.sections.flatMap(x => x.items).filter(i => !i.top).length);
    for (const item of s2.brief.sections.flatMap(x => x.items)) assert.ok(item.sourceLabel, '每条都有出处：' + item.text);
    await c.eval(`(() => { const b = document.querySelector('.ca-brief-sum'); if (b && b.getAttribute('aria-expanded') !== 'true') b.click(); })()`);
    await sleep(500);
    await shot('03-brief');
    result.checks.push(`AI 简报：${s2.brief.total} 条，均带出处，删掉 ${s2.brief.dropped} 条无出处`);

    // ④ 小标签提问
    await c.eval(`[...document.querySelectorAll('.ca-chip-btn')].find(b => b.textContent === '今天的会').click()`);
    await until(`ipcRenderer.invoke('company-assistant:status').then(s => s.chat.length && s.chat[s.chat.length - 1].state === 'done')`, 'chat answer', 300000);
    await sleep(800);
    const answer = (await status()).chat.slice(-1)[0];
    result.answer = String(answer.a).slice(0, 300);
    assert.ok(answer.a.length > 0);
    // 回答里的会议时间要和 Hub 取到的数据一致（假 welink-cli 每次查询返回同一时间）
    const day = s2.day, raw = JSON.parse(fs.readFileSync(path.join(dataDir, 'company-assistant', `raw-${day}.json`), 'utf8'));
    const soon = raw.meetings.find(m => m.id === 'm-soon'), hhmm = new Date(soon.start).toTimeString().slice(0, 5);
    result.soonMeeting = hhmm;
    assert.ok(answer.a.includes(hhmm), `回答里方案评审的时间应为 ${hhmm}`);
    await shot('04-chat');
    result.checks.push('点「今天的会」小标签：助理会话作答，页面显示回答');

    // ⑤ 提醒：10 分钟后的会出准备卡（每分钟检查一次）
    await until(`ipcRenderer.invoke('company-assistant:status').then(s => s.notices.some(n => n.kind === 'meeting-prep'))`, 'prep notice', 150000);
    const s3 = await status();
    result.notices = s3.notices.map(n => `${n.kind}:${n.title}`);
    assert.ok(s3.notices.length <= 3, '每小时最多 3 条');
    // 收起简报、展开提醒列表再截图
    await c.eval(`(() => { const b = document.querySelector('.ca-brief-sum'); if (b && b.getAttribute('aria-expanded') === 'true') b.click(); })()`);
    await sleep(300);
    await c.eval(`(() => { const n = document.querySelector('.ca-notices'); if (n) { n.setAttribute('open', ''); n.scrollIntoView({ block: 'start' }); } })()`);
    await sleep(500);
    await shot('05-notices');
    result.checks.push('会前准备提醒按时发出；提醒总数不超过每小时 3 条');

    // ⑤b 桌宠入口（hub-pet:open-assistant，合成事件）：先切回主页，再按桌宠的三种 detail 打开助理页
    const pet = detail => c.eval(`window.dispatchEvent(new CustomEvent('hub-pet:open-assistant', { detail: ${j(detail)} })); true`);
    const prepId = s3.notices.find(n => n.kind === 'meeting-prep').id;
    await c.eval(`document.getElementById('btn-home').click()`);
    await until(`document.getElementById('company-assistant-page').hidden`, 'page closed', 10000);
    await pet({ source: 'pet', noticeId: prepId });
    await until(`!document.getElementById('company-assistant-page').hidden && document.querySelector('.ca-notices')?.open && document.querySelector('.ca-notice.focus')?.dataset.noticeId === ${j(prepId)}`, 'pet notice focus', 15000);
    await c.eval(`document.querySelector('[data-slot="form"] textarea').value = ''`);
    await pet({ source: 'pet', prompt: '桌宠带来的问题' });
    await until(`document.querySelector('[data-slot="form"] textarea').value === '桌宠带来的问题'`, 'pet prompt filled', 10000);
    await pet({ source: 'pet', prompt: '第二个问题' });
    await sleep(800);
    assert.equal(await c.eval(`document.querySelector('[data-slot="form"] textarea').value`), '桌宠带来的问题', '输入框已有内容不覆盖');
    await c.eval(`document.querySelector('[data-slot="form"] textarea').value = ''`);
    await pet({ source: 'pet', action: 'group-summary', prompt: '帮我汇总一个群今天的讨论。' });
    await until(`document.querySelector('[data-slot="form"] textarea').value.startsWith('汇总群「」')`, 'pet action chip', 10000);
    await c.eval(`document.querySelector('[data-slot="form"] textarea').value = ''`);
    result.checks.push('桌宠事件：带提醒编号时展开并定位那条提醒；带问题时填进空输入框、不覆盖已有内容；带动作时等于点对应小标签');

    // ⑥ 只调了查询命令
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    for (const call of calls) checkArgs(call, { allowSetup: (call[0] === 'auth' && call[1] === 'login') || (call[0] === 'mail' && call[1] === 'autodiscover') });
    assert.equal(calls.filter(c => c[1] === 'login').length, 1, '扫码登录只在点按钮时跑一次');
    assert.ok(calls.filter(c => c[1] === 'autodiscover').length <= 2, '自动配置邮箱不反复跑');
    result.welinkCalls = calls.length;
    result.checks.push(`假 welink-cli 共收到 ${calls.length} 次调用，全是查询命令（外加一次扫码登录、自动配置邮箱 ${calls.filter(c => c[1] === 'autodiscover').length} 次）`);
    const sessionsList = await c.eval(`ipcRenderer.invoke('get-sessions').then(list => list.filter(s => s.purpose === 'company-assistant').map(s => ({ kind: s.kind, cwd: s.cwd })))`);
    assert.equal(sessionsList.length, 1);
    assert.ok(sessionsList[0].cwd.includes('company-assistant'), sessionsList[0].cwd);
    result.checks.push('助理只开了一个 CodeAgent 会话，工作目录在 Hub 数据目录里');
    result.passed = true;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, `${stamp}-company-assistant-e2e-claude1.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
}
// 自用版不变：不开公司助理时，没有公司助理按钮和页面，旧的「助理」照常显示、点开是原来的助理页。
async function personalEditionUnchanged() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-personal-assistant-'));
  const hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'personal-assistant',
    extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_COMPANY_ASSISTANT: '0' } });
  const c = await connectFirstPage(hub);
  try {
    const end = Date.now() + 60000;
    while (Date.now() < end && !(await c.eval('typeof sessions !== "undefined" && !!document.getElementById("btn-assistant")').catch(() => false))) await sleep(400);
    const navs = await c.eval(`[...document.querySelectorAll('#scene-rail button')].filter(b => b.offsetParent !== null && /助理/.test(b.querySelector('.btn-label')?.textContent || '')).map(b => b.id)`);
    assert.deepEqual(navs, ['btn-assistant'], '自用版只有原来的「助理」');
    assert.equal(await c.eval(`!!document.getElementById('btn-company-assistant') || !!document.getElementById('company-assistant-page')`), false);
    const registered = await c.eval(`ipcRenderer.invoke('company-assistant:status').then(() => 'registered', e => 'absent')`);
    assert.equal(registered, 'absent', '自用版主进程不启动公司助理');
    await c.eval(`document.getElementById('btn-assistant').click()`);
    const end2 = Date.now() + 20000;
    let opened = false;
    while (Date.now() < end2 && !(opened = await c.eval(`document.body.classList.contains('assistant-page-open') || document.body.classList.contains('assistant-session-active')`))) await sleep(300);
    assert.equal(opened, true, '点原来的「助理」打开原来的助理页');
    return ['自用版：左侧只有原来的「助理」，没有公司助理页和服务，点开是原来的助理页'];
  } finally { try { c.close(); } catch {} await gracefulQuit(hub).catch(() => {}); }
}

main().then(personalEditionUnchanged).then(checks => { console.log(JSON.stringify({ personal: checks })); }).then(() => setTimeout(() => process.exit(0), 300), error => { console.error(error); setTimeout(() => process.exit(1), 300); });
