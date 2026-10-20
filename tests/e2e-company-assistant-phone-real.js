'use strict';
// 真实验收（替身）：公司助理的手机对话（2026-10-18）在隔离 Hub 里的完整链路。
//   WeLink 用假 welink-cli（tests/fixtures/welink-cli-standin.js）：专用群「助理 CodeAgent」（g-phone），测试往里写「手机发的」消息；
//   CodeAgent 用替身（真 Claude Code，配置成 haiku），助理会话经 MCP 调 Hub 的会话工具。
//   按真实点击路径：助理页 → 设置「手机」→ 选群、检查成员、开启并保存（群里收到「已接通」）→
//   手机问「有哪些会话」（助理调 list_sessions，回答发回群里）→ 手机派活给一个会话（send_session）→ 那个会话答完推到群里。
//   截图（1440 宽）存 output/。凭据复制进临时目录，finally 删除。
//   node tests/e2e-company-assistant-phone-real.js
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { spawnSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { checkArgs } = require('../core/company-assistant/welink');

const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CODEAGENT = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-phone-'));
  const out = path.resolve(__dirname, '..', 'output'); fs.mkdirSync(out, { recursive: true });
  const now = new Date(), stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), log = path.join(root, 'welink-calls.log'), state = path.join(root, 'welink-state');
  for (const d of [cac, dataDir]) fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(state, 'ok');
  fs.writeFileSync(path.join(root, 'welink-exchange'), 'user001@example.com');
  const groupFile = path.join(root, 'welink-phone-group.jsonl');
  const group = () => (fs.existsSync(groupFile) ? fs.readFileSync(groupFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const say = text => { const r = spawnSync(process.execPath, [WELINK, '__test', 'say', '--text', text], { env: { ...process.env, WELINK_STANDIN_STATE: state, WELINK_STANDIN_LOG: log }, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const claudeAuth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  const result = { checks: [], shots: [], timings: {} };
  let hub, c;
  const until = async (expr, label, ms = 180000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await sleep(400); } throw Error('timeout: ' + label); };
  const untilGroup = async (fn, label, ms = 300000) => { const end = Date.now() + ms; while (Date.now() < end) { const m = group().find(fn); if (m) return m; await sleep(500); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, `${stamp}-company-phone-${name}-claude2.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); };
  try {
    fs.copyFileSync(claudeAuth, path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true,
      skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));

    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company-phone', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: CODEAGENT, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: WELINK, WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: state } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!document.getElementById("btn-company-assistant")', 'rail button', 60000);
    // 一个要被助理管的普通会话（还没交代过任务）
    const work = await c.eval(`ipcRenderer.invoke('create-session', { kind: 'codeagent', opts: { title: '信道仿真' } }).then(s => s.id)`);
    assert.ok(work);

    // ① 设置「手机」页：选群、检查成员、开启并保存
    await c.eval(`document.getElementById('btn-company-assistant').click()`);
    await until(`/自动维护登录|自动续期/.test(document.querySelector('.ca-status')?.innerText || '')`, 'logged in', 60000);
    await c.eval(`document.querySelector('[data-ca="settings"]').click()`);
    await until(`!!document.querySelector('[data-ca="settings-tab:phone"]')`, 'phone tab button', 10000);
    await c.eval(`document.querySelector('[data-ca="settings-tab:phone"]').click()`);
    await until(`!!document.querySelector('[data-f="phone-group"]')`, 'phone tab body', 15000);
    await c.eval(`(() => { const s = document.querySelector('[data-f="phone-group"]'); s.value = 'g-phone'; s.dispatchEvent(new Event('change')); })()`);
    await c.eval(`document.querySelector('[data-x="phone-check"]').click()`);
    await until(`/成员没问题/.test(document.querySelector('[data-slot="phone-check"]')?.innerText || '')`, 'group check', 20000);
    await shot('01-phone-tab');
    result.checks.push('设置「手机」页：直接填群 ID；查看群成员显示只有本人和小微助手');
    await c.eval(`document.querySelector('[data-x="phone-connect"]').click()`);
    const welcome = await untilGroup(m => m.content.startsWith('【助理】手机对话已接通'), 'welcome in group', 30000);
    await until(`/已接通/.test(document.querySelector('[data-slot="phone-live"]')?.innerText || '')`, 'phone live connected', 30000);
    await shot('02-phone-connected');
    result.checks.push('点击接通：群里收到「已接通」，设置页状态变成「已接通」');

    // ② 手机问：有哪些会话
    await c.eval(`document.querySelector('[data-ca="close-panel"]').click()`);
    let t0 = Date.now();
    say('现在 Hub 里有哪些会话？各自什么状态？');
    const a1 = await untilGroup(m => m.msgId !== welcome.msgId && m.content.startsWith('【助理】') && /信道仿真/.test(m.content), 'answer lists sessions', 420000);
    result.timings.listAnswerSec = Math.round((Date.now() - t0) / 1000);
    result.answer1 = a1.content.slice(0, 400);
    result.checks.push(`手机问「有哪些会话」：${result.timings.listAnswerSec} 秒后群里收到回答，提到「信道仿真」`);

    // ③ 手机派活：让「信道仿真」回复一句；它答完推到群里
    t0 = Date.now();
    say('让「信道仿真」那个会话直接回复一句话：仿真完成，吞吐提升 3%。不用做别的。');
    const pushed = await untilGroup(m => /「信道仿真」这一轮答完了/.test(m.content), 'done push', 480000);
    result.timings.dispatchDoneSec = Math.round((Date.now() - t0) / 1000);
    result.donePush = pushed.content.slice(0, 300);
    assert.match(pushed.content, /3%/);
    const sent = await c.eval(`ipcRenderer.invoke('company-assistant:status').then(s => s.chat.filter(x => x.via === 'phone').map(x => ({ q: x.q, state: x.state, a: String(x.a || '').slice(0, 200) })))`);
    result.chat = sent;
    assert.equal(sent.length, 2, '两句手机消息都进了助理对话');
    result.checks.push(`手机派活：助理交给「信道仿真」，它答完 ${result.timings.dispatchDoneSec} 秒内推到群里（含「3%」）`);

    // ④ 助理页对话里标着「手机」
    await until(`document.querySelectorAll('.ca-message-row.user .ca-chip').length >= 2 && /手机/.test(document.querySelector('.ca-message-row.user .ca-chip').textContent)`, 'phone chips in chat', 30000);
    await c.eval(`(() => { const s = document.querySelector('.ca-scroll'); s.scrollTop = s.scrollHeight; })()`);
    await sleep(500);
    await shot('03-chat-with-phone');
    result.checks.push('助理页对话里，手机发来的问题标着「手机」');

    // ⑤ 写命令只有往选定的群发消息
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(a => a[0] !== '__test');
    const writes = calls.filter(a => a[1] === 'send-to-group');
    for (const call of calls) checkArgs(call, { allowSetup: call[0] === 'mail' && call[1] === 'autodiscover', sendGroup: 'g-phone' });
    assert.ok(writes.every(a => a[3] === 'g-phone'));
    result.groupMessages = group().map(m => `${m.sender}: ${m.content.slice(0, 80)}`);
    result.checks.push(`假 welink-cli 共 ${calls.length} 次调用：写命令只有 ${writes.length} 次往「助理 CodeAgent」群发消息，其余全是查询`);
    result.passed = true;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    try { fs.rmSync(path.join(cac, '.credentials.json'), { force: true }); } catch {}
    fs.writeFileSync(path.join(out, `${stamp}-company-phone-e2e-claude2.json`), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
}
main().catch(error => { console.error(error); process.exitCode = 1; });
