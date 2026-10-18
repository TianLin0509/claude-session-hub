'use strict';
// 公司版「助理」（2026-10-16）：只读白名单、回执解析、简报出处核对、6 条提醒的触发/去重/限流、服务端到端（假 welink-cli + 假会话）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const W = require('../core/company-assistant/welink');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const R = require('../core/company-assistant/reminders');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { companyAssistantEnabled } = require('../core/company-assistant/gate');

const STANDIN = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'company-assistant-'));

test('白名单：只放行查询命令；发消息、回邮件、建会议、建日程、云盘改动一律拒绝；登录与日历初始化只在按钮触发时放行', () => {
  for (const ok of [['im', 'query-recent-conversation'], ['im', 'query-history-message', '--group-id', 'g'], ['meeting', 'query-list', '--type', '1'], ['calendar', 'list'], ['mail', 'list'], ['mail', 'get'], ['search', 'person'], ['contact', 'detail'], ['auth', 'status']]) {
    assert.deepEqual(W.checkArgs(ok), ok);
  }
  for (const bad of [['im', 'send-message'], ['im', 'send-text'], ['meeting', 'create'], ['meeting', 'cancel'], ['calendar', 'create'], ['calendar', 'delete'], ['mail', 'send'], ['mail', 'reply'], ['onebox', 'delete'], ['onebox', 'upload'], ['auth', 'logout'], [], ['im']]) {
    assert.throws(() => W.checkArgs(bad), e => e.code === 'WELINK_NOT_ALLOWED', bad.join(' '));
  }
  assert.throws(() => W.checkArgs(['auth', 'login']), /拒绝/);
  assert.throws(() => W.checkArgs(['mail', 'autodiscover', '--email', 'a@b.c']), /拒绝/);
  assert.ok(W.checkArgs(['auth', 'login'], { allowSetup: true }));
  assert.ok(W.checkArgs(['mail', 'autodiscover', '--email', 'a@b.c'], { allowSetup: true }));
  assert.throws(() => W.checkArgs(['mail', 'send'], { allowSetup: true }), /拒绝/);
  assert.throws(() => W.checkArgs(['im', 'query-history-message', 'a\nb']), e => e.code === 'WELINK_BAD_ARG');
});

test('只读包装 welink-ro.js：查询命令照常输出，写命令在调用 welink-cli 之前就被拒绝', () => {
  const dir = tmp(), log = path.join(dir, 'calls.log');
  const env = { ...process.env, CLAUDE_HUB_WELINK_CLI: STANDIN, WELINK_STANDIN_LOG: log };
  const script = path.join(__dirname, '..', 'core', 'company-assistant', 'welink-ro.js');
  const ok = spawnSync(process.execPath, [script, 'meeting', 'query-list', '--type', '1'], { env, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(W.parseJson(ok.stdout).meetings.length, 4);
  const bad = spawnSync(process.execPath, [script, 'im', 'send-message', '--user-account', 'x', '--content', 'hi'], { env, encoding: 'utf8' });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /拒绝执行：im send-message/);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(calls, [['meeting', 'query-list', '--type', '1']], '写命令不应到达 welink-cli');
});

test('回执解析：带提示文字的 JSON、登录状态、日历未初始化、二维码三种形式', () => {
  assert.deepEqual(W.parseJson('提示：共 1 条\n{"a":[1]}\n完成'), { a: [1] });
  assert.equal(W.parseJson('没有 JSON'), null);
  assert.deepEqual(W.loginState('UID: u1\nUser Token: EXPIRED'), { ok: false, reason: 'expired', uid: 'u1' });
  assert.equal(W.loginState('UID: u1\nUser Token: VALID').ok, true);
  assert.equal(W.calendarNeedsSetup('Exchange server domain not found. Please run first: welink-cli mail autodiscover --email'), true);
  assert.equal(W.qrFromLoginOutput('扫码 data:image/png;base64,AAAA==').kind, 'data');
  assert.deepEqual(W.qrFromLoginOutput('二维码已保存到 C:\\Users\\x\\AppData\\qr.png ，请扫码'), { kind: 'file', value: 'C:\\Users\\x\\AppData\\qr.png' });
  assert.equal(W.qrFromLoginOutput('打开 https://example.invalid/qr?id=1 扫码').kind, 'url');
  assert.equal(W.qrFromLoginOutput('请稍候'), null);
});

// 一份固定时间的快照：2026-10-14（周三）10:00。
const NOW = new Date(2026, 9, 14, 10, 0).getTime();
const at = (h, m = 0) => new Date(2026, 9, 14, h, m).getTime();
function snapshotAt() {
  const meetings = D.meetings({ meetings: [
    { meetingId: 'm1', subject: '方案评审', location: '会议室A', meetingStartTime: at(10, 10), meetingEndTime: at(11), meetingUsers: [{}, {}] },
    { meetingId: 'm2', subject: '周例会', meetingStartTime: at(13), meetingEndTime: at(14, 30) },
    { meetingId: 'm3', subject: '对齐会', meetingStartTime: at(14, 30), meetingEndTime: at(16) },
    { meetingId: 'm4', subject: '一对一', meetingStartTime: at(15, 30), meetingEndTime: at(16, 30) },
    { meetingId: 'old', subject: '昨天的会', meetingStartTime: at(10) - 86400000, meetingEndTime: at(11) - 86400000 },
  ] });
  const conversations = D.conversations({ conversation_info: [
    { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: '同事甲', target_account: 'a' },
    { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: 'g1', group_name: '项目群' },
  ] });
  const messages = {
    a: D.messages({ messages: [{ msg_id: 'p1', sender_account: 'me', send_time: at(9) - 86400000, content: '好的，我周五前发你' }, { msg_id: 'p2', sender_account: 'a', sender_name: '同事甲', send_time: at(5), content: '材料能先帮我看下吗' }] }, conversations[0], 'me'),
    g1: D.messages({ messages: [{ msg_id: 'g1', sender_account: 'b', sender_name: '同事乙', send_time: at(9, 30), content: '转测时间定在下周一' }] }, conversations[1], 'me'),
  };
  const mails = D.mails({ mails: [{ id: 'x1', subject: '材料征集', from: { name: '秘书' }, importance: 'High', receivedTime: at(8) }] });
  return { at: NOW, login: { ok: true, uid: 'me' }, meetings, calendar: [], conversations, messages, mails };
}

test('数据整理：会议只取今天、单聊最后一句不是我说的算「等你回复」', () => {
  const snap = snapshotAt();
  assert.deepEqual(D.todaysMeetings(snap, '2026-10-14').map(m => m.id), ['m1', 'm2', 'm3', 'm4']);
  const wait = D.awaiting(snap, {});
  assert.equal(wait.length, 1);
  assert.equal(wait[0].sender, '同事甲');
  assert.equal(snap.messages.a[0].mine, true);
});

test('简报：清单版五栏、空栏不显示；AI 版出处不在原始数据里的删掉并计数；处理过的不再出现；首屏最多 10 条', () => {
  const snap = snapshotAt();
  const settings = { keywords: ['转测'] }; // 2026-10-18：不再手动勾关注群，群里提到关注词就算「群里和你相关」
  const list = B.fallbackBrief(snap, { day: '2026-10-14', now: NOW, settings });
  assert.deepEqual(list.sections.map(s => s.key), ['meetings', 'awaiting', 'groups', 'mail']);
  assert.equal(list.by, 'list');
  const reply = '```json\n' + JSON.stringify({
    meetings: [{ text: '10:10 方案评审，先看材料', source: 'meeting:m1' }, { text: '编出来的会', source: 'meeting:nope' }],
    awaiting: [{ text: '同事甲等你看材料', source: 'msg:a:p2' }],
    commitments: [{ text: '周五前发报告', source: 'msg:a:p1', due: '2026-10-16', guess: true }],
    groups: [{ text: '没出处', source: '' }],
    mail: [{ text: '材料征集今天截止', source: '[mail:x1]' }],
  }) + '\n```';
  const ai = B.parseAgentBrief(reply, snap, { day: '2026-10-14', now: NOW });
  assert.equal(ai.by, 'ai');
  assert.equal(ai.dropped, 2);
  assert.equal(ai.total, 4);
  assert.deepEqual(ai.sections.find(s => s.key === 'commitments').items[0].due, '2026-10-16');
  assert.equal(ai.sections.find(s => s.key === 'commitments').items[0].guess, true);
  assert.equal(B.parseAgentBrief('我没法整理', snap, { day: '2026-10-14' }), null);
  const done = B.parseAgentBrief(reply, snap, { day: '2026-10-14', done: new Set(['msg:a:p2']) });
  assert.equal(done.sections.some(s => s.key === 'awaiting'), false);
  const many = { meetings: Array.from({ length: 14 }, () => ({ text: '会', source: 'meeting:m1' })), mail: Array.from({ length: 3 }, () => ({ text: '信', source: 'mail:x1' })) };
  const capped = B.parseAgentBrief(JSON.stringify(many), snap, { day: '2026-10-14' });
  assert.equal(capped.total, 2, '同一出处同一栏只留一条');
  const crowded = { ...snap, meetings: D.meetings({ meetings: Array.from({ length: 12 }, (_, i) => ({ meetingId: 'c' + i, subject: '会' + i, meetingStartTime: at(8, i * 30), meetingEndTime: at(9, i * 30) })) }) };
  const full = B.fallbackBrief(crowded, { day: '2026-10-14', now: NOW });
  assert.ok(full.total > 10);
  assert.equal(full.sections.flatMap(s => s.items).filter(i => i.top).length, 10, '首屏最多 10 条');
  const commits = B.mergeCommitments([], ai, '2026-10-14');
  assert.equal(commits.length, 1);
  assert.equal(B.mergeCommitments(commits, null, '2026-10-20').length, 0, '过期两天以上的承诺清掉');
  assert.match(B.briefPrompt(snap, { day: '2026-10-14', now: NOW }), /\[meeting:m1\][\s\S]*\[msg:a:p2\][\s\S]*\[mail:x1\]/);
});

test('提醒：会前准备、会议太满、等你回复、关注词、答应的事、下班小结各自按条件触发；周末不发', () => {
  const snap = snapshotAt();
  const settings = { waitHours: 4, prepMinutes: 15, keywords: ['转测'], keywordSince: at(9), briefTime: '08:20', summaryTime: '18:00' };
  const commitments = [{ source: 'msg:a:p1', text: '周五前发报告', due: '2026-10-15' }, { source: 's2', text: '今天交材料', due: '2026-10-14' }];
  const kinds = R.dueNotices({ snapshot: snap, settings, now: NOW, commitments }).map(n => n.id);
  assert.ok(kinds.includes('prep:meeting:m1:2026-10-14'));
  assert.ok(kinds.includes('overbooked:2026-10-14'));
  assert.ok(kinds.includes('await:a:p2'));
  assert.ok(kinds.includes('kw:g1:g1'));
  assert.ok(kinds.includes('commit:s2:2026-10-14:day'));
  assert.ok(!kinds.includes('commit:msg:a:p1:2026-10-15:eve'), '前一天的提醒要到 17:00 后');
  assert.ok(!kinds.some(k => k.startsWith('summary:')));
  assert.equal(kinds[0], 'prep:meeting:m1:2026-10-14', '会前准备排最前');
  const evening = R.dueNotices({ snapshot: snap, settings, now: at(18, 5), commitments }).map(n => n.id);
  assert.ok(evening.includes('summary:2026-10-14'));
  assert.ok(evening.includes('commit:msg:a:p1:2026-10-15:eve'));
  assert.ok(!evening.includes('prep:meeting:m1:2026-10-14'));
  assert.deepEqual(R.dueNotices({ snapshot: snap, settings, now: new Date(2026, 9, 17, 10).getTime(), commitments }), [], '周六不发');
  assert.equal(R.dueNotices({ snapshot: snap, settings: { ...settings, keywordSince: at(9, 40) }, now: NOW }).some(n => n.kind === 'keyword'), false, '关注词只看新消息');
  const busy = R.overbooked(D.todaysMeetings(snap, '2026-10-14'));
  assert.equal(busy.overlaps.length, 1);
  assert.ok(busy.long && busy.long.items.length === 3);
  assert.equal(R.quota([NOW - 10 * 60000, NOW - 20 * 60000, NOW - 2 * 3600000], NOW, 3), 1);
});

test('小标签的动作名和桌宠右键菜单一致（hub-pet:open-assistant 的 action）', () => {
  const { BUILTIN_CHIPS } = require('../core/company-assistant/service');
  assert.deepEqual(BUILTIN_CHIPS.map(c => c.action), ['meetings-today', 'meeting-prep', 'awaiting-reply', 'group-summary', 'mail-triage', 'weekly-report']);
  assert.equal(BUILTIN_CHIPS.find(c => c.action === 'group-summary').fill, true);
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(page, /window\.addEventListener\('hub-pet:open-assistant'/);
});

test('发行版开关：只有公司版（或隔离测试显式打开）启用助理页', () => {
  assert.equal(companyAssistantEnabled({}, { target: 'company', featureEnabled: () => true }), true);
  assert.equal(companyAssistantEnabled({}, { target: 'company', featureEnabled: n => n !== 'companyAssistant' }), false);
  assert.equal(companyAssistantEnabled({}, { target: null, featureEnabled: () => true }), false);
  assert.equal(companyAssistantEnabled({ CLAUDE_HUB_COMPANY_ASSISTANT: '1' }, { target: null, featureEnabled: () => true }), false, '没有隔离数据目录不认');
  assert.equal(companyAssistantEnabled({ CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_DATA_DIR: 'x' }, { target: null, featureEnabled: () => true }), true);
  const target = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'community', 'targets', 'company', 'target.json'), 'utf8'));
  assert.equal(target.features.companyAssistant, true);
});

test('服务：WeLink 账号里读不到邮箱时标出要配置，同一天不反复自动试；用户在设置里填邮箱后邮件和日历都通', async () => {
  const dir = tmp(), log = path.join(dir, 'calls.log');
  const f = fakeDeps(dir, log, { WELINK_STANDIN_NO_EMAIL: '1' });
  const svc = new CompanyAssistant({ ...f.deps, bus: new NoticeBus() });
  svc.start();
  let snap = await svc.refresh({ force: true });
  assert.equal(snap.calendarNeedsSetup, true);
  assert.equal(snap.mailSetup.reason, 'no-email');
  assert.equal(snap.mails.length, 0);
  assert.equal(svc.status().mailSetup.reason, 'no-email', '界面能据此请用户填一次邮箱');
  const r = await svc.setupCalendar('someone@example.com');
  assert.equal(r.ok, true);
  snap = svc.snapshot();
  assert.equal(snap.calendarNeedsSetup, false);
  assert.equal(snap.mails.length, 2);
  assert.equal(svc.settings().email, 'someone@example.com');
  assert.equal(svc.settings().emailFrom, 'settings');
  svc.close();
});

// 假会话：记下发出的提示词，回答由测试塞进 finals。
function fakeDeps(dataDir, log, extraEnv = {}) {
  const sessions = new Map(), finals = new Map(), sent = [];
  return {
    sessions, finals, sent,
    deps: {
      dataDir, noTimer: true,
      welinkRun: (args, opts) => W.run(args, { ...opts, cli: STANDIN, env: { ...process.env, ...extraEnv, WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: path.join(dataDir, 'welink-state') } }),
      createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle' }); finals.set(opts.id, []); return { id: opts.id }; },
      sendPrompt: async (id, text) => { sent.push({ id, text }); return { ok: true }; },
      getSession: id => sessions.get(id) || null,
      getSessionMetadata: id => sessions.get(id) || null,
      resumeSession: async () => null,
      isAgentTurnActive: () => false,
      readFinals: meta => finals.get(meta.id) || [],
    },
  };
}

test('服务端到端：取数 → 清单简报 → 交给助理会话 → 核对出处后换成 AI 简报；提问走同一会话；只调了查询命令', async () => {
  const dir = tmp(), log = path.join(dir, 'calls.log');
  const f = fakeDeps(dir, log);
  const bus = new NoticeBus();
  const got = [];
  bus.on('notice', n => got.push(n));
  const svc = new CompanyAssistant({ ...f.deps, bus });
  svc.start();
  svc.setSettings({ workdays: [0, 1, 2, 3, 4, 5, 6], watchGroups: [{ id: 'g-100', name: '项目群A' }], keywords: ['转测'] });
  assert.equal(svc.settings().workdays.length, 7);
  const first = await svc.generateBrief();
  assert.equal(first.by, 'list');
  assert.equal(first.organizing, true);
  assert.ok(first.sections.find(x => x.key === 'meetings').items.length >= 1);
  const snap = svc.snapshot();
  // 2026-10-17：邮件、日历报 Exchange 未配置时，Hub 从 WeLink 账号读出本人邮箱自动配好，不先问用户。
  assert.equal(snap.calendarNeedsSetup, false, '自动配置后日历能用');
  assert.equal(snap.mailSetup.ok, true);
  assert.equal(snap.mailSetup.email, 'user001@example.com');
  assert.equal(snap.mailSetup.from, 'welink');
  assert.equal(svc.settings().email, 'user001@example.com', '读到的邮箱存进设置');
  assert.ok(snap.calendar.length === 1 && snap.mails.length === 2, '配好后重查到了日程，邮件也取到了');
  assert.ok(fs.existsSync(path.join(svc.workspace, 'data', 'today.json')));
  assert.ok(fs.existsSync(path.join(svc.workspace, 'welink-ro.cmd')));
  await new Promise(r => setTimeout(r, 20));
  assert.equal(f.sent.length, 1);
  const sid = svc.state().sessionId;
  assert.equal(f.sessions.get(sid).purpose, 'company-assistant');
  assert.equal(f.sessions.get(sid).cwd, svc.workspace);
  assert.match(f.sent[0].text, /只读[\s\S]*welink-ro\.cmd[\s\S]*\[meeting:m-soon\]/);
  // 助理答完：一条真出处、一条编造的
  f.finals.get(sid).push({ id: 'r1', text: '```json\n{"meetings":[{"text":"10 分钟后方案评审","source":"meeting:m-soon"}],"awaiting":[{"text":"假的","source":"msg:zzz:1"}],"commitments":[],"groups":[],"mail":[]}\n```' });
  await svc.collectJob();
  const brief = svc.brief();
  assert.equal(brief.by, 'ai');
  assert.equal(brief.dropped, 1);
  assert.match(brief.note, /1 条找不到出处/);
  assert.ok(got.some(n => n.kind === 'brief'), '简报生成后发一条提醒');
  // 提问：第二次发送不再带说明
  const item = svc.ask('今天的会');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(f.sent.length, 2);
  assert.equal(f.sent[1].text, '今天的会');
  f.finals.get(sid).push({ id: 'r2', text: '今天有 4 场会。' });
  await svc.collectJob();
  assert.equal(svc.chat().find(c => c.id === item.id).a, '今天有 4 场会。');
  // 提醒：每小时最多 3 条（简报已占 1 条），同一件事只一次
  svc.remind(); svc.remind();
  const kinds = got.map(n => n.id);
  assert.equal(new Set(kinds).size, kinds.length, '同一件事只提醒一次');
  assert.ok(got.length <= 3);
  assert.ok(kinds.some(k => k.startsWith('prep:meeting:m-soon')), '10 分钟后的会出准备卡');
  // 处理了：从简报里拿掉
  svc.markDone('meeting:m-soon');
  assert.equal(svc.brief().sections.some(x => x.items.some(i => i.source === 'meeting:m-soon')), false);
  // 只调用了查询命令
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  for (const c of calls) W.checkArgs(c, { allowSetup: c[0] === 'mail' && c[1] === 'autodiscover' });
  assert.ok(!calls.some(c => c[0] === 'auth' && c[1] === 'login'), '没有自己去扫码登录');
  assert.equal(calls.filter(c => c[1] === 'autodiscover').length, 1, '自动配置只跑一次');
  assert.ok(calls.some(c => c[0] === 'im' && c[1] === 'query-history-message' && c.includes('g-100')), '关注的群取了历史消息');
  svc.close();
});

test('服务：WeLink 登录过期时简报提示扫码；扫码登录拿到二维码，登录后状态变为已登录', async () => {
  const dir = tmp(), log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'welink-state'), 'expired');
  const f = fakeDeps(dir, log);
  const svc = new CompanyAssistant({ ...f.deps, bus: new NoticeBus() });
  svc.start();
  const brief = await svc.generateBrief();
  assert.equal(brief.by, 'none');
  assert.match(brief.note, /扫码登录/);
  assert.equal(svc.status().login.ok, false);
  const flow = await svc.login();
  assert.equal(flow.qr?.kind, 'data');
  for (let i = 0; i < 50 && svc.status().login?.ok !== true; i += 1) await new Promise(r => setTimeout(r, 200));
  assert.equal(svc.status().login.ok, true);
  const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.ok(calls.some(c => c[0] === 'auth' && c[1] === 'login'));
  svc.close();
});
