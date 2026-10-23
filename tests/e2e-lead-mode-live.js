'use strict';
// 负责人模式 · 真实模型端到端（2026-10-23）：隔离 Hub + 真实 Claude / Codex / DeepSeek + 真实 UI 输入。
// 场景：田哥只对负责人说话，让 Codex 修一个小 bug、DeepSeek 独立审查；Codex 干活中途田哥追加一条要求，
// 看负责人会不会把新要求追加给正在工作的成员、审查摘要、亲自核实，并统计负责人被叫醒的次数。
//   node tests/e2e-lead-mode-live.js
// 负责人默认 Claude Haiku（LEAD_MODEL 可改）；Codex 低档推理；DeepSeek flash。凭据复制到临时目录，结束时删除。
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher'), { connectFirstPage } = require('./helpers/cdp-client');

const LEAD_MODEL = process.env.LEAD_MODEL || 'claude-haiku-4-5-20251001';
const CODEX_MODEL = process.env.CODEX_MODEL || 'gpt-6.1-sol';
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash';
const MAX_MIN = Number(process.env.MAX_MIN || 30);
const LABEL = process.env.LEAD_LIVE_LABEL || 'lead-mode';
const ROOT = fs.mkdtempSync(path.join(process.env.TEMP || os.tmpdir(), 'hub-lead-live-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work'), HOME = path.join(ROOT, 'home');
const CLAUDE = path.join(ROOT, 'claude'), CODEX = path.join(ROOT, 'codex');
const ART = path.resolve(__dirname, '..', 'artifacts', 'lead-mode-live', `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-')}`);
for (const p of [DATA, WORK, HOME, CLAUDE, CODEX, ART]) fs.mkdirSync(p, { recursive: true });
const secrets = [], delay = ms => new Promise(r => setTimeout(r, ms));
const report = { label: LABEL, realModels: { lead: LEAD_MODEL, codex: CODEX_MODEL, deepseek: DEEPSEEK_MODEL }, root: ROOT, startedAt: new Date().toISOString(), timeline: [], checks: [], problems: [], metrics: {} };
const t0 = Date.now();
const log = (event, extra = {}) => { const row = { min: +((Date.now() - t0) / 60000).toFixed(1), event, ...extra }; report.timeline.push(row); console.log(`[${row.min}m] ${event}${Object.keys(extra).length ? ' ' + JSON.stringify(extra).slice(0, 400) : ''}`); };

// 一个带 bug 的小项目：折扣算错，测试失败。
function seedProject() {
  fs.mkdirSync(path.join(WORK, 'src'), { recursive: true }); fs.mkdirSync(path.join(WORK, 'test'), { recursive: true });
  fs.writeFileSync(path.join(WORK, 'src', 'price.js'), "'use strict';\n// 按百分比打折：applyDiscount(200, 15) 应得 170。\nfunction applyDiscount(price, pct) {\n  return price * pct / 100;\n}\nmodule.exports = { applyDiscount };\n");
  fs.writeFileSync(path.join(WORK, 'test', 'price.test.js'), "'use strict';\nconst test = require('node:test');\nconst assert = require('node:assert/strict');\nconst { applyDiscount } = require('../src/price');\ntest('15% off 200 is 170', () => assert.equal(applyDiscount(200, 15), 170));\ntest('0% keeps the price', () => assert.equal(applyDiscount(80, 0), 80));\n");
  fs.writeFileSync(path.join(WORK, 'README.md'), '# price\n\n小型示例项目。运行测试：`node --test test/`\n');
}
function profiles() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub', 'config.json'), 'utf8'));
  const provider = cfg.providers.codex, profile = provider.subscription_profiles.find(p => p.id === provider.subscription_profile);
  if (!profile) throw Error('没有可用的 Codex 订阅档案');
  const copy = (from, to) => { if (fs.existsSync(from)) { fs.copyFileSync(from, to); secrets.push(to); } };
  copy(path.join(profile.home || path.join(os.homedir(), '.codex'), 'auth.json'), path.join(CODEX, 'auth.json'));
  copy(path.join(profile.home || path.join(os.homedir(), '.codex'), 'models_cache.json'), path.join(CODEX, 'models_cache.json'));
  fs.writeFileSync(path.join(CODEX, 'config.toml'), `model = "${CODEX_MODEL}"\nmodel_reasoning_effort = "low"\n` + [WORK, path.resolve(__dirname, '..')].map(p => `[projects.'${p.toLowerCase()}']\ntrust_level = "trusted"`).join('\n') + '\n');
  copy(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(CLAUDE, '.credentials.json'));
  // 与生产一致：田哥的 Claude 默认 bypassPermissions，后台会话不会停在权限确认上。
  fs.writeFileSync(path.join(CLAUDE, 'settings.json'), JSON.stringify({ permissionMode: 'bypassPermissions', permissions: { defaultMode: 'bypassPermissions' } }));
  fs.writeFileSync(path.join(CLAUDE, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, theme: 'light', skipDangerousModePermissionPrompt: true, bypassPermissionsModeAccepted: true, projects: {} }));
  const hooks = require('../core/claude-hook-integration').ensureClaudeHookIntegration({ claudeDir: CLAUDE, sourceScriptsDir: path.resolve(__dirname, '..', 'scripts'), logger: { log() {}, warn() {} } });
  if (hooks.errors.length) throw Error('Claude hook 安装失败：' + hooks.errors.join('；'));
  const config = path.join(DATA, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ models: { defaults: { codex: CODEX_MODEL, claude: LEAD_MODEL, deepseek: DEEPSEEK_MODEL } },
    providers: { deepseek: cfg.providers.deepseek, codex: { backend: 'subscription', subscription_profile: profile.id, subscription_profiles: [{ id: profile.id, label: profile.label, home: CODEX }] } } }));
  secrets.push(config);
  return { CLAUDE_HUB_HOME_DIR: HOME, CLAUDE_CONFIG_DIR: CLAUDE, CODEX_HOME: CODEX, CODEX_SQLITE_HOME: '', CLAUDE_HUB_AGENT_RUNTIME: 'pty', HUB_CODEX_BACKEND: 'subscription', HUB_CODEX_PROFILE: '',
    CLAUDE_HUB_NO_FAST: '1', OPENAI_API_KEY: '', CODEX_API_KEY: '', ANTHROPIC_API_KEY: '', DEEPSEEK_API_KEY: '', AI_HUB_WORKSPACE_ROOT: WORK,
    HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(ROOT, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(ROOT, 'empty') };
}
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });

(async () => {
  let hub, cdp, meetingId = '', room = null;
  const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const ledger = () => read(path.join(DATA, 'task-docs', meetingId || '-', 'orchestration', 'ledger.json'));
  const chat = () => read(path.join(DATA, 'arena-prompts', `${meetingId}-groupchat.json`)) || {};
  const invoke = (ch, args = {}) => cdp.eval(`require('electron').ipcRenderer.invoke(${JSON.stringify(ch)},${JSON.stringify(args)})`);
  const shot = async name => { try { const r = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(r.data, 'base64')); } catch (e) { report.problems.push('screenshot ' + name + ': ' + e.message); } };
  const wait = async (label, pred, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await pred(); if (v) return v; } catch {} await delay(1000); } throw Error('Timeout: ' + label); };
  const send = async text => {
    const p = await cdp.eval("(()=>{const r=document.querySelector('#mr-input-box').getBoundingClientRect();return {x:r.x+30,y:r.y+20};})()");
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.insertText', { text });
    for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    log('田哥发言', { text });
  };
  const busy = sid => cdp.eval(`(()=>{const s=sessions.get(${JSON.stringify(sid)});return !!s && s.status==='running';})()`).catch(() => false);
  try {
    seedProject();
    const env = profiles();
    fs.writeFileSync(path.join(DATA, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
    fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
    hub = await launchIsolatedHub({ dataDir: DATA, port: await port(), windowMode: 'hidden', label: 'lead-live', allowExternalState: true, extraEnv: env });
    cdp = await connectFirstPage(hub, t => /index\.html/.test(t.url));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('renderer', () => cdp.eval('!!window.MeetingRoom && typeof selectMeeting === "function"'), 90000);
    log('isolated Hub launched', { pid: hub.pid });
    room = await invoke('create-meeting', { mode: 'general', scene: 'general', groupChat: true, title: '负责人模式实测', workspace: WORK,
      slots: [{ index: 0, kind: 'claude', model: LEAD_MODEL, mcpProfile: 'lean' }, { index: 1, kind: 'codex', model: CODEX_MODEL, mcpProfile: 'lean' }, { index: 2, kind: 'deepseek', model: DEEPSEEK_MODEL, mcpProfile: 'lean' }],
      participants: [0], orchestration: { enabled: true, settings: { stuckMin: 8 } } });
    if (!room?.id) throw Error('create-meeting failed: ' + JSON.stringify(room));
    meetingId = report.meetingId = room.id;
    await cdp.eval(`selectMeeting(${JSON.stringify(meetingId)})`);
    await wait('orchestration strip', () => cdp.eval("!!document.querySelector('.mr-orch-strip')"));
    await shot('00-room');
    await delay(8000);
    await send('这个目录是一个小项目，src/price.js 的打折函数有 bug，测试 node --test test/ 跑不过。请你当负责人：让 Codex 修复并让测试通过，让 DeepSeek 独立审查 Codex 的改动；你审查他们的摘要、亲自核实关键证据后再向我汇报。');

    const [leadSid, codexSid] = room.subSessions;
    let supplementSent = false, last = '', idleSince = Date.now(), nudges = 0;
    const deadline = Date.now() + MAX_MIN * 60000;
    while (Date.now() < deadline) {
      const l = ledger();
      if (!l) { await delay(3000); continue; }
      // Codex 一开始干活，田哥就追加一条要求：看负责人是否把它追加给正在工作的成员。
      if (!supplementSent && await busy(codexSid) && (l.channel?.messages || []).some(m => m.from === 'm1' && m.to === 'm2')) {
        await delay(15000);
        await send('补充要求：applyDiscount 遇到 pct 小于 0 或大于 100 时要抛 RangeError，并补一条对应的测试。这条请马上告诉正在改代码的成员。');
        supplementSent = true; report.supplementAt = +((Date.now() - t0) / 60000).toFixed(1);
      }
      const msgs = l.channel?.messages || [];
      const key = JSON.stringify([l.status, l.halt?.reason, l.plan?.version, msgs.map(m => m.id + m.state), l.reports?.length]);
      if (key !== last) {
        last = key; idleSince = Date.now();
        log('state', { status: l.status, halt: l.halt?.reason || null, plan: l.plan?.version || 0, messages: msgs.map(m => `${m.from}->${m.to}:${m.state}${m.via ? '/' + m.via : ''}${m.wake === false ? '/quiet' : ''}`) });
      }
      const view = (await invoke('orchestration:view', { meetingId }))?.view;
      if (l.status === 'finished') { log('finished'); break; }
      if (!view?.orchestratorBusy && !(await busy(room.subSessions[1])) && !(await busy(room.subSessions[2])) && Date.now() - idleSince > 150000 && nudges < 2) {
        nudges += 1;
        await send('按你推荐的来，直接继续，做完向我汇报。');
        idleSince = Date.now();
      }
      await delay(3000);
    }
    await delay(5000);
    await shot('90-end');
    const l = ledger() || {};
    const msgs = l.channel?.messages || [];
    const all = Array.isArray(chat().messages) ? chat().messages : [];
    const leadTurns = all.filter(m => m.role === 'assistant' && m.sid === leadSid);
    const noticeCards = all.filter(m => m.dispatch?.kind === 'orch-notice');
    report.metrics = {
      minutes: +((Date.now() - t0) / 60000).toFixed(1),
      leadAnswers: leadTurns.length, hubWakesOfLead: noticeCards.length,
      userMessages: all.filter(m => m.role === 'user' && !m.dispatch).length,
      leadToMember: msgs.filter(m => m.from === 'm1').length,
      interrupts: msgs.filter(m => m.via === 'interrupt').length,
      memberToLead: msgs.filter(m => m.to === 'm1').length, memberQuietNotes: msgs.filter(m => m.to === 'm1' && m.wake === false).length,
      peerGrants: (l.channel?.grants || []).length,
      memberAnswers: all.filter(m => m.role === 'assistant' && m.sid !== leadSid && m.answer?.state === 'delivered').length,
    };
    log('metrics', report.metrics);
    const check = (label, ok, detail) => { report.checks.push({ label, ok: !!ok, ...(detail ? { detail } : {}) }); log((ok ? 'PASS ' : 'FAIL ') + label); };
    let testOutput = '', testsPass = false;
    // Node 24 的 `node --test test/` 会把目录当模块加载（MODULE_NOT_FOUND），按测试文件逐个跑；原命令结果另记。
    const files = fs.readdirSync(path.join(WORK, 'test')).filter(n => /\.test\.js$/.test(n)).map(n => path.join('test', n));
    try { testOutput = execFileSync(process.execPath, ['--test', ...files], { cwd: WORK, encoding: 'utf8', timeout: 60000 }); testsPass = true; } catch (e) { testOutput = String(e.stdout || '') + String(e.stderr || ''); }
    try { execFileSync(process.execPath, ['--test', 'test/'], { cwd: WORK, encoding: 'utf8', timeout: 60000 }); report.originalCommandPasses = true; } catch { report.originalCommandPasses = false; }
    report.projectTestOutput = testOutput.slice(-2000);
    const source = fs.readFileSync(path.join(WORK, 'src', 'price.js'), 'utf8');
    check('结项', l.status === 'finished');
    check('项目测试真的通过（Hub 外独立运行 node --test）', testsPass);
    check('补充要求落地：代码会抛 RangeError', /RangeError/.test(source));
    check('负责人把活派给成员（负责人→成员消息或工作段 ≥ 1）', report.metrics.leadToMember > 0 || (l.segments || []).length > 0);
    check('两位成员都交付过正式回答', new Set(all.filter(m => m.role === 'assistant' && m.sid !== leadSid && m.answer?.state === 'delivered').map(m => m.sid)).size >= 2);
    check('田哥追加要求后，负责人把它转给了成员（追加或新消息）', supplementSent && msgs.some(m => m.from === 'm1' && m.at > t0 + report.supplementAt * 60000 && /RangeError/.test(m.text || '')));
    report.interruptUsed = report.metrics.interrupts > 0;
    const finalText = (l.reports || []).map(r => r.summary).join('\n') + '\n' + leadTurns.slice(-2).map(m => m.content || '').join('\n');
    report.leadFinal = finalText.slice(-3000);
    check('负责人汇报里写了亲自核实了什么', /核实|亲自|验证|复核|跑了|运行/.test(finalText));
    const folded = await cdp.eval(`[...document.querySelectorAll('.mr-gc-msg.ai')].map(a=>({sid:a.dataset.sourceSid,min:a.dataset.journalMinimized}))`).catch(() => []);
    report.cards = folded;
    check('界面上成员卡片默认折叠、负责人卡片展开', folded.some(c => c.sid !== leadSid && c.min === 'true') && folded.filter(c => c.sid === leadSid).every(c => c.min === 'false'));
    report.brief = l && fs.existsSync(path.join(DATA, 'orchestration', 'project-briefs')) ? fs.readdirSync(path.join(DATA, 'orchestration', 'project-briefs')).map(f => ({ f, text: fs.readFileSync(path.join(DATA, 'orchestration', 'project-briefs', f), 'utf8').slice(0, 2000) })) : [];
    check('项目档案已建立', report.brief.length > 0);
    report.briefUpdatedByLead = report.brief.some(b => !/^## 项目是什么、怎么跑\n\n## 架构/m.test(b.text));
  } catch (e) { report.problems.push(e.stack); console.error(e.stack); if (cdp) await shot('fatal').catch(() => {}); }
  finally {
    try { if (meetingId) fs.cpSync(path.join(DATA, 'task-docs', meetingId), path.join(ART, 'task-docs'), { recursive: true }); } catch {}
    try { if (meetingId) fs.copyFileSync(path.join(DATA, 'arena-prompts', `${meetingId}-groupchat.json`), path.join(ART, 'groupchat.json')); } catch {}
    try { fs.cpSync(path.join(WORK, 'src'), path.join(ART, 'work-src'), { recursive: true }); fs.cpSync(path.join(WORK, 'test'), path.join(ART, 'work-test'), { recursive: true }); } catch {}
    if (hub) fs.writeFileSync(path.join(ART, 'hub.log'), hub.log().join('\n'));
    if (cdp) await cdp.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(e => report.problems.push('quit: ' + e.message));
    for (const s of secrets) fs.rmSync(s, { force: true });
    report.credentialsRemoved = secrets.every(s => !fs.existsSync(s));
    report.end = new Date().toISOString();
    fs.writeFileSync(path.join(ART, 'report.json'), JSON.stringify(report, null, 2));
    console.log('ARTIFACT ' + ART);
    process.exitCode = !report.problems.length && report.checks.length && report.checks.every(c => c.ok) ? 0 : 1;
  }
})();
