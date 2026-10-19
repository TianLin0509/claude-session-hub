'use strict';
// 自动派活会话不出选择题（2026-10-19，core/auto-dispatch-rules.js、core/choice-menu-screen.js）：
//   说明层：三类自动派活会话（通道 / 公司助理 / 论坛摘要）的系统提示带「自动派活会话的工作方式」，用户自己的会话不带；
//   强制层：CodeAgent 配置目录登记只匹配 AskUserQuestion 的同步 PreToolUse（ask-gate）；只有带自动派活标记的会话被拒绝；
//   兜底：通道轮次的会话停在选择菜单上 → 这一轮报「卡在选择题」带回题目和选项；追问 / 重试新开会话接着做；从不发按键。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const rules = require('../core/auto-dispatch-rules');
const { detectChoiceMenu, loadRules, DEFAULT_RULES } = require('../core/choice-menu-screen');
const { createHubRulesStore } = require('../core/hub-rules');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nochoice-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

// ---------- 说明层 ----------
test('系统提示：三类自动派活会话带「自动派活规则」，用户自己的会话不带；规则页全关时也带；不抢别的系统提示文件', t => {
  const { SessionManager } = require('../core/session-manager');
  const root = tmp(t);
  const store = createHubRulesStore({ dataDir: path.join(root, 'data'), env: {}, loadPersonal: () => null });
  const fake = { memoryService: { hubRules: store } };
  const pick = (opts, purpose) => SessionManager.prototype.hubRulesSystemPrompt.call(fake, opts, purpose);
  const plain = pick({}, undefined);
  assert.ok(plain && !fs.readFileSync(plain.file, 'utf8').includes(rules.NO_CHOICE_RULE), '用户自己的会话：只有通用规则');
  assert.ok(!plain.fileVersion && !/自动派活/.test(plain.label));
  for (const purpose of ['company-bridge', 'company-assistant', 'company-forum']) {
    const r = pick({}, purpose);
    const body = fs.readFileSync(r.file, 'utf8');
    assert.ok(body.includes(rules.NO_CHOICE_RULE), purpose + ' 带「自动派活会话的工作方式」');
    assert.match(body, /^以下是 AI Hub 默认带上的规则/, '通用规则照旧在前');
    assert.match(r.label, /通用规则 v\d+ \+ 自动派活规则/);
    assert.equal(r.version, plain.version, 'version 仍是通用规则那一版（随消息补送靠它判断）');
    assert.equal(path.basename(r.file), `rules-${r.fileVersion}.md`);
    assert.equal(store.systemPromptText(r.fileVersion), body, '「发送内容」面板能按 fileVersion 读回整份');
  }
  assert.equal(pick({}, 'company-bridge').file, pick({}, 'company-forum').file, '三类会话共用同一份文件（同一处常量）');
  assert.equal(pick({ appendSystemPromptFile: 'C:/other/memory.md' }, 'company-bridge'), null, '已有别的系统提示文件就不改');
  store.setEnabled(false);
  assert.equal(pick({}, undefined), null, '规则全关：用户会话不写');
  const only = pick({}, 'company-bridge');
  const body = fs.readFileSync(only.file, 'utf8');
  assert.equal(body, rules.NO_CHOICE_RULE + '\n', '规则全关：自动派活会话只带这一段');
  assert.equal(only.version, undefined);
  assert.equal(only.label, '自动派活规则');
  assert.deepEqual(SessionManager.hubRulesRecord(only), { version: undefined, label: '自动派活规则', fileVersion: only.fileVersion, autoRule: rules.RULE_VERSION });
  assert.equal(SessionManager.hubRulesRecord(null), undefined);
});

test('规则文字：正面写法，要求按假设做完并在末尾列出假设与备选', () => {
  assert.match(rules.NO_CHOICE_RULE, /按最合理的假设继续做下去/);
  assert.match(rules.NO_CHOICE_RULE, /假设与备选/);
  assert.ok(!/家里/.test(rules.NO_CHOICE_RULE + rules.DENY_REASON), '公司侧文案不出现「家里」');
  assert.equal(rules.DENY_REASON, '这个会话是自动派活的，没人能回答选择题：请按最合理的假设继续，并在回答里写明假设');
  assert.deepEqual(rules.AUTO_PURPOSES, ['company-bridge', 'company-assistant', 'company-forum']);
});

// ---------- 强制层：会话环境与 hook 登记 ----------
test('会话环境：只给三类自动派活会话设标记；其余会话去掉继承来的标记；开关和工具名可配置', () => {
  const cfg = rules.gateConfig({}, {});
  assert.deepEqual(cfg, { enabled: true, tools: ['AskUserQuestion'] });
  const env = { AI_HUB_NO_CHOICE: '1', AI_HUB_NO_CHOICE_REASON: 'x', AI_HUB_NO_CHOICE_TOOLS: 'X', PATH: 'p' };
  assert.equal(rules.applySessionEnv(env, undefined, cfg), false);
  assert.deepEqual(env, { PATH: 'p' }, '用户会话：继承来的标记去掉');
  for (const purpose of rules.AUTO_PURPOSES) {
    const e = {};
    assert.equal(rules.applySessionEnv(e, purpose, cfg), true);
    assert.deepEqual(e, { AI_HUB_NO_CHOICE: '1', AI_HUB_NO_CHOICE_REASON: rules.DENY_REASON, AI_HUB_NO_CHOICE_TOOLS: 'AskUserQuestion' });
  }
  const off = rules.gateConfig({ AI_HUB_CODEAGENT_CHOICE_GATE: '0' }, {});
  assert.equal(off.enabled, false);
  const e = {}; assert.equal(rules.applySessionEnv(e, 'company-bridge', off), false); assert.deepEqual(e, {});
  assert.equal(rules.gateMatcher(off), null, '关掉时不登记 hook');
  assert.equal(rules.gateConfig({}, { choiceGate: false }).enabled, false, 'Hub 设置也能关');
  assert.equal(rules.gateConfig({ AI_HUB_CODEAGENT_CHOICE_GATE: '1' }, { choiceGate: false }).enabled, true, '环境变量优先');
  const renamed = rules.gateConfig({ AI_HUB_CODEAGENT_CHOICE_TOOLS: 'AskUserQuestion, ask_user ,bad name!' }, {});
  assert.deepEqual(renamed.tools, ['AskUserQuestion', 'ask_user'], '工具名可改，不合法的丢掉');
  assert.equal(rules.gateMatcher(renamed), 'AskUserQuestion|ask_user');
  assert.deepEqual(rules.gateConfig({}, { choiceTools: ['ask_user_question'] }).tools, ['ask_user_question']);
});

test('会话管理器：CodeAgent 自动派活会话的终端带标记，用户会话不带（启动参数源码约定）', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  assert.match(source, /require\('\.\/auto-dispatch-rules'\)\.applySessionEnv\(sessionEnv, isCodeAgent \? opts\.purpose : null\)/);
});

test('hook 登记：带 choiceGateMatcher 时多一条只匹配提问工具的同步 PreToolUse；原有异步 tool-start 不变；重复部署不重复登记', t => {
  const { ensureManagedSettings } = require('../core/claude-hook-integration');
  const { HOOK_EVENTS } = require('../core/codeagent-config');
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ model: 'x', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'other-tool' }] }] } }));
  const opts = { logger: {}, events: HOOK_EVENTS, manageStatusLine: false, managePermissionMode: false, choiceGateMatcher: 'AskUserQuestion' };
  assert.equal(ensureManagedSettings(dir, opts).changed, true);
  const s = JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8'));
  const gate = s.hooks.PreToolUse.find(g => g.matcher === 'AskUserQuestion');
  assert.ok(gate && /session-hub-hook\.(?:py|ps1)" ask-gate$/.test(gate.hooks[0].command));
  assert.equal(gate.hooks[0].async, undefined, '同步执行（要在工具运行前给出拒绝）');
  assert.equal(gate.hooks[0].timeout, 20, '超时放宽（PowerShell 启动慢时不至于超时放行）');
  assert.ok(s.hooks.PreToolUse.some(g => g.matcher === '' && g.hooks[0].async === true && /tool-start$/.test(g.hooks[0].command)), '原有异步 tool-start 不变');
  assert.ok(s.hooks.PreToolUse.some(g => g.matcher === 'Bash' && g.hooks[0].command === 'other-tool'), '同事工具的登记原样保留');
  assert.equal(ensureManagedSettings(dir, opts).changed, false, '再部署一次不变');
  const dir2 = tmp(t);
  ensureManagedSettings(dir2, { ...opts, choiceGateMatcher: null });
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir2, 'settings.json'), 'utf8')).hooks.PreToolUse.some(g => g.matcher === 'AskUserQuestion'), '开关关掉时不登记');
  const dir3 = tmp(t);
  ensureManagedSettings(dir3, { ...opts, choiceGateMatcher: 'Ask"; rm -rf' });
  assert.ok(!JSON.parse(fs.readFileSync(path.join(dir3, 'settings.json'), 'utf8')).hooks.PreToolUse.some(g => /rm/.test(g.matcher)), '不合法的 matcher 不登记');
});

// ---------- 强制层：hook 脚本（Python 私人版、PowerShell 公司版） ----------
const SCRIPTS = path.join(__dirname, '..', 'scripts');
const askPayload = JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '选哪个颜色？' }] } });
const autoEnv = { CLAUDE_HUB_SESSION_ID: 'hub-1', CLAUDE_HUB_PORT: '9', AI_HUB_NO_CHOICE: '1', AI_HUB_NO_CHOICE_REASON: rules.DENY_REASON, AI_HUB_NO_CHOICE_TOOLS: 'AskUserQuestion' };
const runners = [
  ['Python', (env, input) => spawnSync('python', [path.join(SCRIPTS, 'session-hub-hook.py'), 'ask-gate'], { input, env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 })],
  ['PowerShell', (env, input) => spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(SCRIPTS, 'session-hub-hook.ps1'), 'ask-gate'], { input, env: { ...process.env, ...env }, windowsHide: true, timeout: 30000 })],
];
for (const [name, run] of runners) {
  test(`ask-gate（${name}）：自动派活会话的 AskUserQuestion 以退出码 2 拒绝、理由走 stderr；其余一律放行`, { skip: name === 'PowerShell' && process.platform !== 'win32' }, () => {
    const denied = run(autoEnv, askPayload);
    assert.equal(denied.status, 2);
    assert.equal(denied.stderr.toString('utf8'), rules.DENY_REASON, '理由是 UTF-8 原文');
    assert.equal(run({ ...autoEnv, AI_HUB_NO_CHOICE: '' }, askPayload).status, 0, '用户会话（没有标记）放行');
    assert.equal(run(autoEnv, JSON.stringify({ tool_name: 'Bash', tool_input: { command: 'dir' } })).status, 0, '别的工具放行');
    assert.equal(run(autoEnv, '{坏的').status, 0, '读不懂输入放行');
    assert.equal(run({ ...autoEnv, AI_HUB_NO_CHOICE_TOOLS: 'ask_user' }, JSON.stringify({ tool_name: 'ask_user' })).status, 2, '改过名字的提问工具也拒绝');
    assert.equal(run({ ...autoEnv, AI_HUB_NO_CHOICE_REASON: '' }, askPayload).stderr.toString('utf8').length > 10, true, '没有理由文字时用内置英文说明');
  });
}

// ---------- 兜底：屏幕识别选择菜单 ----------
const rowsOf = text => text.split('\n');
const ASK_MENU = [
  '● 我先确认一下你的偏好。',
  '',
  '────────────────────────────────────────────────────────────',
  ' ←  ☐ 颜色  ✔ Submit  →',
  '',
  '选哪个颜色？',
  '',
  '❯ 1. 红',
  '     暖色',
  '  2. 蓝',
  '     冷色',
  '  3. Type something.',
  '────────────────────────────────────────────────────────────',
  '  4. Chat about this',
  '',
  'Enter to select · ↑/↓ to navigate · Esc to cancel',
].join('\n');
const PERMISSION = 'Bash command\n\n  rm -rf build\n\nDo you want to proceed?\n❯ 1. Yes\n  2. Yes, and don\'t ask again\n  3. No, and tell Claude what to do differently (esc)';

test('屏幕识别：AskUserQuestion 菜单、权限确认菜单都认得出题目和选项', () => {
  const m = detectChoiceMenu(rowsOf(ASK_MENU));
  assert.equal(m.question, '选哪个颜色？');
  assert.deepEqual(m.options.map(o => o.label), ['红', '蓝', 'Type something.', 'Chat about this']);
  assert.deepEqual(m.options.map(o => o.selected), [true, false, false, false]);
  assert.match(m.footer, /Enter to select/);
  const p = detectChoiceMenu(rowsOf(PERMISSION));
  assert.equal(p.question, 'Do you want to proceed?');
  assert.equal(p.options.length, 3);
  const boxed = detectChoiceMenu(['╭──────────────╮', '│ 要继续吗？    │', '│ ❯ 1. 继续     │', '│   2. 停下     │', '╰──────────────╯']);
  assert.deepEqual(boxed && boxed.options.map(o => o.label), ['继续', '停下'], '框线包着的也认得');
  const ghost = [...rowsOf(ASK_MENU), ' '.repeat(88) + '❯ ', '', ' '.repeat(100) + '⏵⏵ bypass perm', 'is'];
  assert.ok(detectChoiceMenu(ghost), '回放宽度和终端不一致时右边残留的孤立光标符号不当成输入框（2026-10-19 真实样本）');
});

test('屏幕识别：普通输出不误判', () => {
  const answer = ['● 方案如下：', '  1. 每周一上午开周会', '  2. 每次 30 分钟', '  3. 轮流主持', '', '假设与备选：……', '',
    '╭────────────────────────────────╮', '│ ❯                              │', '╰────────────────────────────────╯', '  ? for shortcuts'];
  assert.equal(detectChoiceMenu(answer), null, '回答里的编号列表没有光标符号');
  const quoted = ['> 1. 第一条', '> 2. 第二条', 'Enter to select'];
  assert.equal(detectChoiceMenu(quoted), null, '引用块里每行都带 >，不是菜单');
  const typed = ['❯ 1. 帮我看看', '  2. 这两个文件', '', '╭──╮', '│ ❯ │', '╰──╯'];
  assert.equal(detectChoiceMenu(typed), null, '底下还有输入框：不是停在菜单上');
  const noHint = ['● 结果：', '❯ 1. 红', '  2. 蓝', '● 完成'];
  assert.equal(detectChoiceMenu(noHint), null, '没有题目也没有按键提示，不判');
  const scrolled = [...rowsOf(ASK_MENU), ...Array.from({ length: 20 }, (_, i) => `● 第 ${i} 行输出`)];
  assert.equal(detectChoiceMenu(scrolled), null, '菜单早已滚到上面（不在屏幕最下方）');
  const notFromOne = ['选哪个？', '❯ 2. 红', '  3. 蓝', 'Enter to select'];
  assert.equal(detectChoiceMenu(notFromOne), null, '编号不从 1 起');
  assert.equal(detectChoiceMenu([]), null);
  assert.equal(detectChoiceMenu(rowsOf(ASK_MENU), { ...DEFAULT_RULES, enabled: false }), null, '规则里关掉就不识别');
});

test('屏幕识别规则可配置：数据目录里的 choice-menu-rules.json 覆盖默认；写错了按默认并说明', t => {
  const root = tmp(t);
  assert.equal(loadRules(root).error, null, '没有文件用默认');
  fs.mkdirSync(path.join(root, 'company-bridge'), { recursive: true });
  fs.writeFileSync(path.join(root, 'company-bridge', 'choice-menu-rules.json'), JSON.stringify({ cursor: '»', footer: '回车确认' }));
  const custom = loadRules(root).rules;
  assert.ok(detectChoiceMenu(['选哪个？', '» 1. 红', '  2. 蓝', '回车确认'], custom), '公司 CodeAgent 换了光标符号和提示文字时改规则就能认');
  assert.equal(detectChoiceMenu(['选哪个？', '» 1. 红', '  2. 蓝', '回车确认']), null);
  fs.writeFileSync(path.join(root, 'company-bridge', 'choice-menu-rules.json'), JSON.stringify({ footer: '(' }));
  const bad = loadRules(root);
  assert.match(bad.error, /规则文件写错了/);
  assert.equal(bad.rules.footer, DEFAULT_RULES.footer);
});

test('屏幕识别：真实 Claude Code AskUserQuestion 样本（端到端 A4 抓取）经 xterm 回放后认得出', { skip: !fs.existsSync(path.join(__dirname, 'fixtures', 'choice-menu', 'claude-code-2.1-askuserquestion.json')) }, async () => {
  const { renderRows } = require('../core/hub-phone/session-chat');
  const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'choice-menu', 'claude-code-2.1-askuserquestion.json'), 'utf8'));
  const m = detectChoiceMenu(await renderRows(sample));
  assert.ok(m, '认得出');
  assert.match(m.question, /颜色/);
  assert.ok(m.options.some(o => /红/.test(o.label)) && m.options.some(o => /蓝/.test(o.label)));
  assert.equal(m.options.filter(o => o.selected).length, 1);
});

// ---------- 兜底：通道轮次 ----------
const { CompanyBridge } = require('../core/company-bridge/company');
const { HomeBridge } = require('../core/company-bridge/home');
function fakeRelay(clock) {
  const channels = new Map();
  const headers = type => ({ get: k => (String(k).toLowerCase() === 'content-type' ? type : null) });
  const json = (status, body) => ({ ok: status < 400, status, type: 'basic', headers: headers('application/json'), text: async () => JSON.stringify(body) });
  return async (url, init = {}) => {
    const u = new URL(url), m = u.pathname.match(/\/bridge\/([a-f0-9]{32})\/msg$/);
    if (!m) return json(404, { ok: false });
    if ((init.method || 'GET') === 'POST') {
      const ch = channels.get(m[1]) || { next: 1, rows: [], epoch: 'e1' }; channels.set(m[1], ch);
      const body = JSON.parse(init.body);
      const dup = ch.rows.find(r => r.mid === body.mid);
      if (dup) return json(200, { ok: true, seq: dup.seq, duplicate: true });
      const row = { seq: ch.next++, to: body.to, mid: body.mid, blob: body.blob }; ch.rows.push(row);
      return json(200, { ok: true, seq: row.seq, duplicate: false });
    }
    const ch = channels.get(m[1]), to = u.searchParams.get('to'), after = Number(u.searchParams.get('after'));
    return json(200, { ok: true, messages: ch ? ch.rows.filter(r => r.to === to && r.seq > after).map(r => ({ seq: r.seq, blob: r.blob })) : [], seen: { home: new Date(clock.now).toISOString(), company: new Date(clock.now).toISOString() }, more: false, epoch: ch ? ch.epoch : null });
  };
}
function sessions() {
  const s = { map: new Map(), busy: new Set(), finals: new Map(), sent: [], created: [], keys: [] };
  s.deps = {
    createSession: async (kind, opts) => { const x = { id: opts.id, kind, status: 'idle', title: opts.title, opts }; s.map.set(opts.id, x); s.created.push({ kind, opts }); return x; },
    sendPrompt: async (id, text) => { s.sent.push({ id, text }); return { ok: true }; },
    getSession: id => s.map.get(id) || null,
    getSessionMetadata: id => s.map.get(id) || null,
    resumeSession: async () => {},
    isAgentTurnActive: id => s.busy.has(id),
    readFinals: meta => s.finals.get(meta.id) || [],
    // 只读屏幕；通道没有发按键的入口（下面断言 keys 一直为空）
    sessionKeys: (id, data) => s.keys.push({ id, data }),
  };
  return s;
}
function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-nochoice-bridge-'));
  const clock = { now: 1_800_000_000_000 };
  const fetchImpl = fakeRelay(clock);
  const hs = sessions(), cs = sessions();
  const screens = new Map();
  const home = new HomeBridge({ dataDir: path.join(root, 'home'), noTimer: true, fetchImpl, now: () => clock.now, relayBaseUrl: () => 'https://relay.example.test/drop/tok', onNotify: () => {}, ...hs.deps });
  const company = new CompanyBridge({ dataDir: path.join(root, 'company'), noTimer: true, fetchImpl, now: () => clock.now, fallbackCwd: root, isDirectory: () => true, onNotify: () => {}, ...cs.deps,
    readTerminalScreen: async id => (screens.has(id) ? { text: screens.get(id), cols: 120, rows: 30 } : null), renderRows: async raw => raw.text.split('\n') });
  // 先关数据库再删目录（Windows 上开着的 sqlite 文件删不掉）
  t.after(() => { try { home.close(); company.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  return { root, clock, hs, cs, home, company, screens };
}
async function pair(r) {
  const { code } = r.home.createPairing();
  await r.company.pair(code);
  for (let i = 0; i < 3; i++) { await r.home.checkNow(); await r.company.checkNow(); }
  await r.home.checkNow();
  assert.equal(r.company.status().link.state, 'paired');
}

test('通道兜底：会话停在选择菜单上连续 20 秒 → 这一轮报「卡在选择题」带回题目和选项；不发按键、不替它选', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '帮我把 C:/AirView/cfg/a.cfg 的门限改成合适的值' } });
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.busy.add(sid);
  // 普通的工作中屏幕：不判
  r.screens.set(sid, '● 正在读代码…\n  ⎿  Read a.cfg\n✻ Thinking…');
  r.clock.now += 60000; await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running');
  // 菜单第一次出现：先记下，不判
  r.screens.set(sid, ASK_MENU.replace('选哪个颜色？', '门限改成哪个？见 C:/AirView/cfg/a.cfg').replace('红', '-90 dBm').replace('蓝', '-100 dBm'));
  r.clock.now += 9000; await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running', '刚出现不判');
  r.clock.now += 9000; await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running', '不到 20 秒不判');
  r.clock.now += 12000; await r.company.checkNow();
  const t1 = r.company.thread(thread);
  assert.equal(t1.state, 'failed');
  assert.equal(t1.choiceStuckSession, sid);
  const round = t1.rounds[0];
  assert.match(round.error, /^卡在选择题：/);
  assert.match(round.error, /题目：门限改成哪个？见 <路径>/, '题目脱敏（路径隐去）');
  assert.match(round.error, /1\. -90 dBm \/ 2\. -100 dBm/);
  assert.match(round.error, /追问给出你的选择.*retry 重做/);
  assert.ok(!/家里/.test(round.error), '公司侧文案不出现「家里」');
  assert.deepEqual(round.choiceStuck.options.slice(0, 2), ['1. -90 dBm', '2. -100 dBm']);
  assert.deepEqual(r.cs.keys, [], '没有发按键');
  assert.equal(r.cs.sent.length, 1, '没有往停住的会话里再发消息');
  assert.match(fs.readFileSync(path.join(r.root, 'company', 'logs', 'company-bridge.log'), 'utf8'), new RegExp(`choice-stuck ${thread}#1`));
  // 家里收到「没答上」，正文是题目和选项
  await r.home.checkNow();
  const hr = r.home.thread(thread).rounds[0];
  assert.match(hr.error, /卡在选择题/);
  assert.match(r.hs.sent.at(-1).text, /没答上[\s\S]*卡在选择题[\s\S]*-90 dBm/);

  // 家里追问给出选择 → 公司新开会话接着做，带上原问题和那道题；旧会话不动
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'h', arguments: { thread, question: '选 -90 dBm' } });
  await r.company.checkNow();
  assert.equal(r.cs.created.length, 2, '新开了一个会话');
  const sid2 = r.cs.created[1].opts.id;
  assert.notEqual(sid2, sid);
  const prompt = r.cs.sent.at(-1);
  assert.equal(prompt.id, sid2, '追问发进新会话，不发进停在菜单上的旧会话');
  assert.match(prompt.text, /停在了一道选择题上/);
  assert.match(prompt.text, /第 1 轮提问（停在选择题上，没有作答）\n[\s\S]*帮我把/);
  assert.match(prompt.text, /那道选择题：门限改成哪个/);
  assert.match(prompt.text, /## 本轮（第 2 轮）请求\n\n选 -90 dBm$/);
  const t2 = r.company.thread(thread);
  assert.equal(t2.rounds[1].rehome.kind, 'choice');
  assert.ok(t2.prevSessions.some(p => p.sessionId === sid));
  assert.deepEqual(r.cs.keys, []);
  // 新会话答完 → 回执元数据写明因选择题新开会话；家里的说明对得上
  r.cs.finals.set(sid2, [{ id: 'f1', text: '已按 -90 dBm 说明。\n假设与备选：……' }]);
  r.clock.now += 5000; await r.company.checkNow();
  await r.home.checkNow();
  const reply = r.home.thread(thread).rounds[1];
  assert.equal(reply.meta.rehomeKind, 'choice');
  assert.match(r.hs.sent.at(-1).text, /原会话停在一道选择题上，公司新开会话/);
});

test('通道兜底：重试停在选择题上的那一轮也新开会话；关掉识别开关就不判；菜单一闪而过不判', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '周会定在什么时候合适？' } });
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.busy.add(sid);
  r.screens.set(sid, PERMISSION);
  r.clock.now += 9000; await r.company.checkNow();
  r.screens.set(sid, '✻ Working…');
  r.clock.now += 9000; await r.company.checkNow();
  r.screens.set(sid, PERMISSION);
  r.clock.now += 9000; await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running', '菜单中途消失过，重新计时');
  r.clock.now += 9000; await r.company.checkNow();
  r.clock.now += 9000; await r.company.checkNow();
  r.clock.now += 9000; await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'failed');
  const createdBefore = r.cs.created.length;
  r.company.retry(thread);
  await r.company.checkNow();
  assert.equal(r.cs.created.length, createdBefore + 1, '重试新开会话');
  const prompt = r.cs.sent.at(-1).text;
  assert.match(prompt, /上一次做这一轮时停在了这道选择题上：\n那道选择题：Do you want to proceed\?/);
  assert.match(prompt, /周会定在什么时候合适？$/);
  assert.deepEqual(r.cs.keys, []);

  // 关掉识别开关
  const r2 = rig(t);
  await pair(r2);
  r2.company.setSettings({ choiceDetect: false });
  r2.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const q2 = await r2.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '周会定在什么时候合适？' } });
  await r2.company.checkNow();
  const s2 = r2.cs.created[0].opts.id;
  r2.cs.busy.add(s2); r2.screens.set(s2, PERMISSION);
  for (let i = 0; i < 6; i++) { r2.clock.now += 9000; await r2.company.checkNow(); }
  assert.equal(r2.company.thread(q2.thread).state, 'running');
});
