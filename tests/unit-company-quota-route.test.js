'use strict';
// 额度感知路由（2026-10-18 田哥：「最好能识别出 API 用量到达上限了……然后自动避让」）：
// 识别规则（真实样本 + 标点空格变体）、避让标记与过期、挑号跳过避让号、全部避让时排队、撞额度后换号重做（只一次）、
// 追问换号、account 参数与代称、隐私、远程 pause/resume、直查 errors 段脱敏与条数上限。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Q = require('../core/codeagent-quota');
const route = require('../core/codeagent-model-route');
const { apiErrorEntry } = require('../core/company-bridge/quota-watch');
const { rig, pair } = require('./helpers/company-bridge-rig');

const GLM = 'GLM-5.2-WX-Auto', DS = 'deepseek-v4-0731';
const MIN = 60000, HOUR = 3600000;
// 真实样本（2026-10-18 田哥转述，公司 Hub 会话卡片视图里看到的 CodeAgent 报错；标点和空格是转述的）
const SAMPLE = 'API Error token消耗过快， 已达到4亿上限';
const VARIANTS = [
  SAMPLE,
  'API Error token消耗过快,已达到4亿上限',
  'API Error: token消耗过快，已达到4亿上限',
  'API Error：token 消耗过快 ，已达到 4 亿上限',
  'API Error token消耗过快',
  'API Error 已达到 4.0 亿上限',
  'API Error: 429 {"type":"error","error":{"message":"token消耗过快，已达到4亿上限"}}',
];
function tmp(t) { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-quota-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; }
const apiErrorLine = (text, at, { structured = true } = {}) => JSON.stringify({ type: 'assistant', uuid: 'u-' + Math.random().toString(16).slice(2), timestamp: new Date(at).toISOString(),
  ...(structured ? { isApiErrorMessage: true } : {}), message: { role: 'assistant', model: structured ? '<synthetic>' : 'glm', content: [{ type: 'text', text }] } }) + '\n';

test('识别规则：真实样本与标点、空格变体都命中；没有 API Error 开头、用户消息、普通回答正文不命中', t => {
  const { rules } = Q.loadRules(tmp(t));
  assert.ok(rules.some(r => r.id === 'codeagent-token-cap-v1' && r.builtin), '内置规则来自真实样本');
  for (const text of VARIANTS) {
    const hit = Q.matchText(text, rules, 'transcript');
    assert.ok(hit, '应命中：' + text);
    assert.equal(hit.rule.kind, 'quota');
    assert.ok(Q.matchText('  ⎿  ' + text, rules, 'screen'), '屏幕上也认：' + text);
  }
  for (const text of ['token消耗过快，已达到4亿上限', '我们来看 API Error 的处理逻辑', 'API Error: 500 internal server error', 'rate limit 的实现在 sched.c']) {
    assert.equal(Q.matchText(text, rules, 'transcript'), null, '不应命中：' + text);
  }
  // 原生记录：结构化标记、正文以 API Error 开头的回答都算 API 错误消息；用户消息（问题里引用了报错）和普通回答不算
  const at = Date.now();
  assert.equal(apiErrorEntry(JSON.parse(apiErrorLine(SAMPLE, at))).structured, true);
  assert.equal(apiErrorEntry(JSON.parse(apiErrorLine(SAMPLE, at, { structured: false }))).structured, false);
  assert.equal(apiErrorEntry({ type: 'user', message: { content: '报错是 ' + SAMPLE + '，什么意思？' } }), null);
  assert.equal(apiErrorEntry({ type: 'assistant', message: { content: [{ type: 'text', text: '这个报错（' + SAMPLE + '）表示额度用完' }] } }), null);
});

test('识别规则可配置：数据文件里加规则、停用内置规则；写错的规则不生效并报出来', t => {
  const dataDir = tmp(t);
  fs.mkdirSync(path.join(dataDir, 'codeagent-pool'), { recursive: true });
  fs.writeFileSync(Q.rulesFile(dataDir), JSON.stringify({ disabled: ['codeagent-token-cap-v1'], rules: [
    { id: 'my-rate', kind: 'rate-limit', where: ['transcript'], pattern: 'API Error.*请求过于频繁', reset: { pattern: '(\\d+)\\s*分钟后', type: 'duration' } },
    { id: 'bad', pattern: '(' }, { id: 'off', pattern: 'x', enabled: false }, { id: 'redos', pattern: 'API Error (a+)+$' },
    { id: 'redos2', pattern: 'API Error', reset: { pattern: '(\\d*)*分钟', type: 'duration' } }] }));
  const loaded = Q.loadRules(dataDir);
  assert.deepEqual(loaded.rules.map(r => r.id), ['my-rate']);
  assert.match(loaded.errors.join(), /bad：正则写错了/);
  assert.match(loaded.errors.join(), /redos：pattern 里有嵌套量词/);
  assert.match(loaded.errors.join(), /redos2：reset 正则太长或有嵌套量词/);
  assert.equal(Q.parseReset('API Error 请 999 小时后再试', { re: /(\d+)\s*小时后/, type: 'duration' }, 1000), 1000 + Q.MAX_RESET_MS, '恢复时间最多 24 小时后');
  assert.equal(Q.matchText(SAMPLE, loaded.rules, 'transcript'), null, '内置规则已停用');
  const now = 1_800_000_000_000;
  const hit = Q.matchText('API Error 请求过于频繁，请 5 分钟后再试', loaded.rules, 'transcript', now);
  assert.equal(hit.rule.kind, 'rate-limit');
  assert.equal(hit.resetAt, now + 5 * MIN, '按规则读出重置时间');
  assert.equal(Q.matchText('API Error 请求过于频繁', loaded.rules, 'screen'), null, 'where 只写了原生记录');
});

test('避让标记与过期：默认 1 小时；手动暂停不被自动标记覆盖；Credit 读数变了且为正时提前解除（限流不解除）', t => {
  const dataDir = tmp(t);
  let now = 1_800_000_000_000;
  Q.recordCredit(dataDir, 'ds01', { remaining: 0, pct: 0, bucket: '今日忙时' }, { floor: 0 }, now);
  let a = Q.activeAvoid(dataDir, now);
  assert.equal(a.ds01.source, 'credit', 'Credit 不高于阈值也避让');
  assert.equal(a.ds01.until, now + HOUR);
  // 同一读数再读一次：不解除（屏幕上的读数还是那一轮的）
  Q.recordCredit(dataDir, 'ds01', { remaining: 0, pct: 0 }, { floor: 0 }, now + MIN);
  assert.ok(Q.activeAvoid(dataDir, now + MIN).ds01);
  // 读数变成正的：提前解除
  const r = Q.recordCredit(dataDir, 'ds01', { remaining: 1500, pct: 60 }, { floor: 0 }, now + 2 * MIN);
  assert.equal(r.cleared, true);
  assert.equal(Q.activeAvoid(dataDir, now + 2 * MIN).ds01, undefined);
  // 报错避让：默认 1 小时；读数没变（标记时就是 1500）不解除；变了才解除
  Q.markAvoid(dataDir, 'ds01', { source: 'error', kind: 'quota', reason: '额度上限', sample: SAMPLE }, now);
  assert.equal(Q.activeAvoid(dataDir, now).ds01.until, now + HOUR);
  assert.equal(Q.recordCredit(dataDir, 'ds01', { remaining: 1500, pct: 60 }, { floor: 0 }, now + MIN).cleared, false);
  assert.equal(Q.recordCredit(dataDir, 'ds01', { remaining: 1200, pct: 48 }, { floor: 0 }, now + MIN).cleared, false, '读数下降不解除');
  assert.equal(Q.recordCredit(dataDir, 'ds01', { remaining: 1800, pct: 70 }, { floor: 0 }, now + 2 * MIN).cleared, true, '比标记时回升才解除');
  // 标记时没有读数（creditAtMark 为空）：首次读到正数也不解除
  Q.markAvoid(dataDir, 'nocredit', { source: 'error', kind: 'quota' }, now);
  assert.equal(Q.recordCredit(dataDir, 'nocredit', { remaining: 2000, pct: 80 }, { floor: 0 }, now + MIN).cleared, false);
  assert.ok(Q.activeAvoid(dataDir, now + MIN).nocredit);
  // 同一个号多个会话：比已记下的（另一个会话、活动更晚的）读数更旧的不用
  Q.recordCredit(dataDir, 'multi', { remaining: 0, pct: 0 }, { floor: 0, session: 'sessionA1', observedAt: now + 5000 }, now);
  const stale = Q.recordCredit(dataDir, 'multi', { remaining: 3000, pct: 90 }, { floor: 0, session: 'sessionB1', observedAt: now + 1000 }, now + MIN);
  assert.equal(stale.stale, true); assert.ok(Q.activeAvoid(dataDir, now + MIN).multi, '旧会话屏幕上的高读数不解除');
  // 限流：Credit 为正也不解除，到点过期
  Q.markAvoid(dataDir, 'personal', { source: 'error', kind: 'rate-limit', reason: '限流' }, now);
  Q.recordCredit(dataDir, 'personal', { remaining: 99, pct: 50 }, { floor: 0 }, now + MIN);
  Q.recordCredit(dataDir, 'personal', { remaining: 98, pct: 49 }, { floor: 0 }, now + 2 * MIN);
  assert.ok(Q.activeAvoid(dataDir, now + 2 * MIN).personal, '限流不因 Credit 解除');
  assert.equal(Q.activeAvoid(dataDir, now + HOUR + 1).personal, undefined, '到点过期');
  // 手动暂停（直到手动恢复）：自动标记不覆盖，Credit 也不解除
  Q.markAvoid(dataDir, 'ds01', { source: 'manual', reason: '手动', until: null }, now);
  Q.markAvoid(dataDir, 'ds01', { source: 'error', kind: 'quota' }, now + MIN);
  assert.equal(Q.activeAvoid(dataDir, now + 10 * HOUR).ds01.source, 'manual');
  Q.recordCredit(dataDir, 'ds01', { remaining: 5000, pct: 90 }, { floor: 0 }, now + 2 * MIN);
  assert.ok(Q.activeAvoid(dataDir, now + 10 * HOUR).ds01);
  assert.equal(Q.clearAvoid(dataDir, 'ds01', {}, now).cleared, true);
  assert.equal(Q.activeAvoid(dataDir, now).ds01, undefined);
});

test('挑号：避让中的号不挑；全部避让时报 avoid 和最早恢复时间；指定号只在它里面挑', () => {
  const a = (key, models, extra = {}) => ({ key, pool: key !== 'personal', models, defaultModel: models[0], activeSessions: 0, lastAssignedAt: 0, ...extra });
  const avoid = until => ({ source: 'error', kind: 'quota', until });
  let p = route.pickAnyRoute([a('personal', [GLM], { activeSessions: 3 }), a('ds01', [DS], { avoid: avoid(5000) })]);
  assert.equal(p.account.key, 'personal', '号池号在避让中：会话再多也挑个人账号');
  p = route.pickAnyRoute([a('personal', [GLM], { avoid: avoid(9000) }), a('ds01', [DS], { avoid: avoid(5000) })]);
  assert.deepEqual(p, { ok: false, reason: 'avoid', until: 5000 });
  p = route.pickRoute([a('personal', [GLM]), a('ds01', [DS], { avoid: avoid(5000) })], DS);
  assert.equal(p.reason, 'avoid'); assert.equal(p.until, 5000); assert.equal(p.model, DS);
  assert.equal(route.pickRoute([a('personal', [GLM]), a('ds01', [DS])], 'MiniMax').reason, 'none');
  assert.equal(route.pickAnyRoute([a('personal', [GLM]), a('ds01', [DS])], { only: 'personal' }).account.key, 'personal');
  assert.deepEqual(route.servableNow([a('ds01', [DS], { avoid: avoid(5000) })]), []);
  // 模型表：每个号一行，只有代称；避让中的号还能并行 0
  const table = route.modelTable([a('personal', [GLM]), a('ds01', [DS], { avoid: { ...avoid(5000), reason: 'x' } })], { cap: 3, aliases: new Map([['personal', '个人'], ['ds01', '号 1']]), describe: e => '额度上限，预计恢复' });
  assert.deepEqual(table.accountRows.map(r => [r.alias, r.free, r.avoid && r.avoid.reason]), [['个人', 3, null], ['号 1', 0, '额度上限，预计恢复']]);
  assert.equal(table.models.find(m => m.id === DS).free, 0);
  assert.equal(table.models.find(m => m.id === DS).avoided, 1);
  assert.ok(!JSON.stringify(table).includes('ds01') && !JSON.stringify(table).includes('personal'), '不含号池编号和内部键');
});

// ---- 通道：两端 + 假会话（会话带原生记录文件，通道被动读取） ----
function setup(t) {
  const box = { active: {} };
  const fake = (key, models) => ({ key, pool: key !== 'personal', models, defaultModel: models[0], activeSessions: box.active[key] || 0, lastAssignedAt: 0 });
  const r = rig(t, { companyDeps: { routeAccounts: ({ usePool = true } = {}) => [fake('personal', [GLM]), fake('ds01', [DS])].filter(a => usePool || !a.pool), poolLanes: () => 1 } });
  const create = r.company.deps.createSession;
  r.company.deps.createSession = async (kind, opts) => {
    const x = await create(kind, opts);
    if (opts.codeagentPoolPick) x.codeagentPoolAccount = opts.codeagentPoolPick;
    x.purpose = opts.purpose;
    x.transcriptPath = path.join(r.root, 'tx-' + opts.id + '.jsonl');
    return x;
  };
  r.company.deps.listSessionIds = () => [...r.cs.map.keys()];
  r.hs.map.set('home-s', { id: 'home-s', kind: 'claude', status: 'idle' });
  const created = () => r.cs.created.map(c => c.opts);
  const inject = (sid, text = SAMPLE) => fs.appendFileSync(r.cs.map.get(sid).transcriptPath, apiErrorLine(text, r.clock.now));
  const account = opts => opts.codeagentPoolPick || 'personal';
  return Object.assign(r, { box, created, inject, account });
}
const step = async (r, ms = 20000) => { r.clock.now += ms; await r.company.checkNow(); await r.home.checkNow(); };

test('撞额度：原生记录里出现额度报错 → 这个号标避让 → 这一轮自动换到另一个号新开会话重做，回执写明换号；新问题不再派给它', async t => {
  const r = setup(t); await pair(r);
  const asked = await r.home.ask('home-s', { question: 'AirView 里 RSRP 统计的入口在哪个文件？请给出相对路径' });
  await r.company.checkNow(); await r.company.checkNow();
  const first = r.created()[0];
  assert.equal(r.account(first), 'ds01', '同等条件下号池优先');
  // 号 1 在作答中撞到额度
  r.inject(first.id);
  await step(r, 2000);
  assert.ok(Q.activeAvoid(path.join(r.root, 'company'), r.clock.now).ds01, '号 1 标避让');
  const second = r.created()[1];
  assert.ok(second, '换号新开了会话');
  assert.equal(r.account(second), 'personal', '换到个人账号');
  const prompt = r.cs.sentTo(second.id).at(-1).text;
  assert.match(prompt, new RegExp(`编号 ${asked.thread}`));
  assert.match(prompt, /那个会话所用的号（号 1）因额度上限中断，现换到新会话重做/);
  assert.match(prompt, /RSRP 统计的入口/);
  const ct = r.company.thread(asked.thread);
  assert.equal(ct.sessionId, second.id); assert.equal(ct.rounds[0].rehomed, 1);
  assert.equal(ct.prevSessions[0].sessionId, first.id, '旧会话记在 prevSessions，不动它');
  r.cs.answer(second.id, '入口在 stats/rsrp.cpp。');
  await step(r); await step(r, 1000);
  const hr = r.home.thread(asked.thread).rounds[0];
  assert.match(hr.reply, /stats\/rsrp\.cpp/);
  assert.equal(hr.meta.rehomedFrom, '号 1'); assert.equal(hr.meta.accountAlias, '个人'); assert.equal(hr.meta.rehomeKind, 'quota');
  assert.match(require('../core/company-bridge/home').replyMessage(r.home.thread(asked.thread), hr), /原先的号（号 1）撞到额度上限，公司自动换到个人新开会话重做了这一轮/);
  // 新问题：号 1 还在避让，平局也不给它
  await r.home.ask('home-s', { question: '第二个问题：HARQ 合并逻辑在哪里实现' });
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.account(r.created().at(-1)), 'personal');
  // 家里模型表：号 1 避让中，原因带报错原文
  await step(r, 31000);
  const rows = r.home.companyModels().table.accountRows;
  const row1 = rows.find(x => x.alias === '号 1');
  assert.ok(row1.avoid && /额度上限/.test(row1.avoid.reason) && /token消耗过快/.test(row1.avoid.reason), JSON.stringify(row1));
  assert.ok(!JSON.stringify(rows).includes('ds01'), '号表不含号池编号');
});

test('只换号重做一次：重做的那次又撞到额度就如实报失败，不循环', async t => {
  const r = setup(t); await pair(r);
  const asked = await r.home.ask('home-s', { question: '查一下 L2 调度器 PF 权重的更新位置' });
  await r.company.checkNow(); await r.company.checkNow();
  r.inject(r.created()[0].id);
  await step(r, 2000);
  const second = r.created()[1];
  r.inject(second.id);
  await step(r, 2000);
  assert.equal(r.created().length, 2, '没有第三个会话');
  const hr = r.home.thread(asked.thread).rounds[0];
  assert.match(hr.error, /已经因额度换过一次号，换到个人重做后，个人也撞到了额度上限.*只换号重做一次，这一轮不再换号/);
});

test('所有号都在避让：新问题排队、回执写明预计恢复时间，不硬派；远程 resume-account 后照常派活', async t => {
  const r = setup(t); await pair(r);
  const dataDir = path.join(r.root, 'company');
  Q.markAvoid(dataDir, 'personal', { source: 'error', kind: 'quota', reason: '额度上限' }, r.clock.now);
  Q.markAvoid(dataDir, 'ds01', { source: 'manual', reason: '手动', until: r.clock.now + 2 * HOUR }, r.clock.now);
  const asked = await r.home.ask('home-s', { question: '这个问题要排队，等号恢复后再派' });
  await step(r, 1000); await step(r, 1000);
  assert.equal(r.created().length, 0, '不开会话');
  const note = r.home.thread(asked.thread).rounds[0].note;
  assert.match(note, /所有号都在避让中.*预计 \d\d-\d\d \d\d:\d\d 恢复；恢复后自动派发/);
  assert.ok(!/ds01|personal/.test(note));
  // 远程恢复号 1（和公司页签上的「恢复派活」同一个状态）
  await step(r, 31000);
  const sent = await r.home.hubAdmin({ op: 'act', action: 'resume-account', params: { account: '号1' } });
  await step(r, 1000); await step(r, 1000);
  const v = r.home.actView(sent.id);
  assert.equal(v.status, '已执行', JSON.stringify(v));
  assert.match(v.note, /号 1：手动暂停.*→ 可用/);
  await step(r, 1000);
  assert.equal(r.created().length, 1);
  assert.equal(r.account(r.created()[0]), 'ds01', '恢复后派给号 1');
  // 远程暂停：参数核对（代称写法、时长范围）
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'pause-account', params: { account: 'w00111111' } }), /代称/);
  await assert.rejects(r.home.hubAdmin({ op: 'act', action: 'pause-account', params: { account: '号 1', hours: 100 } }), /0\.25–72/);
  await step(r, 11000);
  const p = await r.home.hubAdmin({ op: 'act', action: 'pause-account', params: { account: '号 1', hours: 1 } });
  await step(r, 1000); await step(r, 1000);
  assert.match(r.home.actView(p.id).note, /号 1：可用 → 手动暂停，预计/);
  assert.equal(Q.activeAvoid(dataDir, r.clock.now).ds01.source, 'manual');
  assert.equal(Q.activeAvoid(dataDir, r.clock.now + HOUR + 1).ds01, undefined, '到点自动恢复');
});

test('追问落在避让中的号上：换号新开会话，带上前几轮问答，不再撞墙', async t => {
  const r = setup(t); await pair(r);
  const asked = await r.home.ask('home-s', { question: '第一轮：AirView 的 Geometry 统计入口在哪里' });
  await r.company.checkNow(); await r.company.checkNow();
  const first = r.created()[0];
  assert.equal(r.account(first), 'ds01');
  r.cs.answer(first.id, '第一轮回答：在 geometry/stat.cpp 的 Collect 函数。');
  await step(r); await step(r, 1000);
  assert.ok(r.home.thread(asked.thread).rounds[0].reply);
  // 号 1 之后被识别到额度用完
  Q.markAvoid(path.join(r.root, 'company'), 'ds01', { source: 'error', kind: 'quota', reason: '额度上限', sample: SAMPLE }, r.clock.now);
  await r.home.followup('home-s', { thread: asked.thread, question: '第二轮：Collect 里怎么处理越界的 UE？' });
  await step(r, 1000); await step(r, 1000);
  const second = r.created()[1];
  assert.ok(second, '新开了会话');
  assert.equal(r.account(second), 'personal');
  const prompt = r.cs.sentTo(second.id).at(-1).text;
  assert.match(prompt, /此前各轮问答/); assert.match(prompt, /geometry\/stat\.cpp/); assert.match(prompt, /第二轮：Collect 里怎么处理越界/);
  assert.equal(r.cs.sentTo(first.id).length, 1, '原会话没再收到追问');
});

test('account 参数：家里按号表核对（代称、避让中直接报错不发出）；公司按代称开会话；追问指定别的号就换号新开会话', async t => {
  const r = setup(t); await pair(r);
  await step(r, 1000);
  assert.deepEqual(r.home.companyModels().table.accountRows.map(x => x.alias), ['个人', '号 1']);
  await assert.rejects(r.home.ask('home-s', { question: '指定一个写法不对的号试试看', account: 'ds01' }), /只认代称/);
  await assert.rejects(r.home.ask('home-s', { question: '指定一个不存在的号试试看', account: '号 5' }), /没有「号 5」/);
  const a = await r.home.ask('home-s', { question: '在号 1 上查一下 HARQ 合并逻辑', account: '号1' });
  assert.equal(a.account, '号 1');
  await r.company.checkNow(); await r.company.checkNow();
  assert.equal(r.account(r.created()[0]), 'ds01', '公司按代称开在号 1');
  r.cs.answer(r.created()[0].id, 'HARQ 合并在 harq/combine.c。');
  await step(r); await step(r, 1000);
  assert.equal(r.home.thread(a.thread).rounds[0].meta.accountAlias, '号 1');
  await r.home.followup('home-s', { thread: a.thread, question: '换到个人账号再核对一遍', account: '个人' });
  await step(r, 1000); await step(r, 1000);
  assert.equal(r.account(r.created()[1]), 'personal');
  assert.match(r.cs.sentTo(r.created()[1].id).at(-1).text, /harq\/combine\.c/);
  // 号 1 进避让：家里看到后指定它直接报错，不发出
  Q.markAvoid(path.join(r.root, 'company'), 'ds01', { source: 'error', kind: 'quota', reason: '额度上限', sample: SAMPLE }, r.clock.now);
  await step(r, 31000); await step(r, 1000);
  const posts = r.relay.posts;
  await assert.rejects(r.home.ask('home-s', { question: '这次还想在号 1 上问一个问题', account: '号 1' }), e => e.code === 'account-avoided' && /号 1 在避让中.*现在可用：个人/.test(e.message));
  assert.equal(r.relay.posts, posts, '没发出');
  // 家里号表还没更新时（直接发到公司）：公司同样拒绝，回报原因和可用的号
  const raw = await r.home.link.send('ask', { thread: 'Q-1018-77', gen: r.home.link.gen(), round: 1, title: 't', question: '绕过家里核对直接指定号 1', account: '号 1' });
  void raw;
  await step(r, 1000); await step(r, 1000);
  const ct = r.company.thread('Q-1018-77');
  assert.match(ct.rounds[0].error, /指定的号 1在避让中.*没有发出.*现在可用：个人/);
});

test('隐私：模型表、回执、排队说明里只有代称，不含号池编号、工号、备注', async t => {
  const r = setup(t); await pair(r);
  r.company.deps.accountSecrets = () => ['ds01', 'w001****11', '同事张三'];
  const asked = await r.home.ask('home-s', { question: '隐私测试：请随便回答一句' });
  await r.company.checkNow(); await r.company.checkNow();
  r.inject(r.created()[0].id, 'API Error token消耗过快，已达到4亿上限（账号 w00111111 同事张三）');
  await step(r, 2000);
  r.cs.answer(r.created()[1].id, '好的。');
  await step(r); await step(r, 31000);
  const text = JSON.stringify([r.home.thread(asked.thread), r.home.companyModels()]);
  for (const s of ['ds01', 'w00111111', 'w001****11', '同事张三']) assert.ok(!text.includes(s), '家里看不到 ' + s);
});

test('终端屏幕只留样本、不避让：第一次读屏只记基线；用户回显「> API Error…」、列表行「- API Error…」不算；Credit 不高于阈值避让、回升后解除', async t => {
  const r = setup(t); await pair(r);
  await r.home.ask('home-s', { question: '屏幕识别测试：随便回答一句' });
  await r.company.checkNow(); await r.company.checkNow();
  const sid = r.created()[0].id;
  let rows = ['● 正在读取', '  ⎿  API Error：token 消耗过快，已达到 4 亿上限', 'Credit 1,954.7 (78.2%)'];
  let n = 0;
  r.company.deps.readTerminalScreen = async id => (id === sid ? { text: id + (n++) + rows.join('\n'), cols: 120, rows: 30 } : null);
  r.company.deps.renderRows = async () => rows;
  await step(r, 2000);
  const dataDir = path.join(r.root, 'company');
  assert.equal(r.company.quota.errors().length, 0, '第一次读屏只记基线');
  // 田哥把报错贴给 CodeAgent 问原因：回显行、回答里的列表行都不算；新出现的 ⎿ 报错行只留样本
  rows = ['> API Error token消耗过快，已达到4亿上限 这是什么意思？', '- API Error token消耗过快：额度用完', '* API Error 已达到 4 亿上限',
    '  ⎿  API Error：token 消耗过快，已达到 4 亿上限', '⎿  API Error 已达到 4.0 亿上限', 'Credit 1,954.7 (78.2%)'];
  await step(r, 21000);
  const errors = r.company.quota.errors();
  assert.deepEqual(errors.map(e => [e.source, e.ruleId, /已达到 4\.0 亿上限/.test(e.text)]), [['screen', 'codeagent-token-cap-v1', true]], JSON.stringify(errors));
  assert.equal(Q.activeAvoid(dataDir, r.clock.now).ds01, undefined, '屏幕命中不避让');
  assert.equal(r.created().length, 1, '不换号');
  await step(r, 21000);
  assert.equal(r.company.quota.errors().length, 1, '同一行留在屏幕上不重复记');
  // Credit：个人账号的会话屏幕读到 0 → 避让；读数回升 → 解除
  r.cs.answer(sid, '好的。'); await step(r);
  r.box.active.ds01 = 1;
  await r.home.ask('home-s', { question: '第二个问题：随便回答一句' });
  await r.company.checkNow(); await r.company.checkNow();
  const psid = r.created()[1].id;
  assert.equal(r.account(r.created()[1]), 'personal');
  r.company.deps.readTerminalScreen = async id => ({ text: id + (id === psid ? 'p' : 'd') + rows.join('|'), cols: 120, rows: 30 });
  r.company.deps.renderRows = async raw => (raw.text.startsWith(psid) ? ['Credit 0.0 (0%)'] : ['Credit 2,000.0 (80.0%)']);
  await step(r, 21000);
  assert.equal(Q.activeAvoid(dataDir, r.clock.now).personal.source, 'credit');
  r.company.deps.renderRows = async raw => (raw.text.startsWith(psid) ? ['Credit 2,400.0 (96.0%)'] : ['Credit 2,000.0 (80.0%)']);
  r.company.deps.readTerminalScreen = async id => ({ text: id + 'changed' + Math.random(), cols: 120, rows: 30 });
  await step(r, 21000);
  assert.equal(Q.activeAvoid(dataDir, r.clock.now).personal, undefined, 'Credit 恢复为正，提前解除');
});

test('直查 errors 段：最近 N 条、号换成代称、令牌 / 路径 / 工号脱敏；pool 段带避让状态', async t => {
  const r = setup(t); await pair(r);
  await r.home.ask('home-s', { question: '直查 errors 段测试：随便回答一句' });
  await r.company.checkNow(); await r.company.checkNow();
  const sid = r.created()[0].id;
  r.inject(sid, 'API Error: 401 token sk-abcdefghijklmnopqrstuvwxyz0123 无效 C:\\Users\\someone\\proj\\a.txt w00123456 zhang.san@corp-mail.cn 10.12.34.56:8080 api.intra-gw.example.com/v1');
  r.inject(sid);
  // 人自己开的会话（不是通道会话）里的报错：没命中规则的不收（编译错误一类）
  const own = path.join(r.root, 'tx-own.jsonl');
  fs.writeFileSync(own, apiErrorLine('API Error: 500 编译失败 src/main.cpp:12', r.clock.now));
  r.cs.map.set('own-1', { id: 'own-1', kind: 'codeagent', status: 'idle', transcriptPath: own });
  await step(r, 2000);
  assert.ok(!r.company.quota.errors().some(e => /编译失败/.test(e.text)), '个人会话里没命中规则的报错不收');
  const D = require('../core/company-bridge/diag');
  const out = await D.collect({ bridge: r.company, sections: ['errors', 'pool'], errorsLimit: 1, sys: { ...D.defaultSys(), clock: () => r.clock.now } });
  assert.equal(out.errors.list.length, 1, '条数上限');
  const all = await D.collect({ bridge: r.company, sections: ['errors'], errorsLimit: 50, sys: { ...D.defaultSys(), clock: () => r.clock.now } });
  assert.equal(all.errors.list.length, 2);
  const text = JSON.stringify(all.errors);
  assert.ok(!/sk-abcdefghij|someone|w00123456|ds01|zhang\.san|corp-mail|10\.12\.34|intra-gw/.test(text), text);
  assert.match(text, /<路径>/); assert.match(text, /<工号>/); assert.match(text, /<邮箱>/); assert.match(text, /<IP>/); assert.match(text, /<域名>/);
  assert.ok(all.errors.list.some(e => e.matched === 'codeagent-token-cap-v1' && e.structured && e.source === '原生记录'));
  assert.equal(D.parseErrorsLimit(500), 50); assert.equal(D.parseErrorsLimit(undefined), 20);
  assert.ok(D.SECTIONS.includes('errors'));
});

test('换号前确认旧会话停下：还在忙就等宽限期；等的时候它自己答出来就不换号；换号后旧会话停下来就被休眠', async t => {
  const r = setup(t); await pair(r);
  const suspended = [];
  r.company.deps.suspendSession = (id, opts) => { suspended.push({ id, reason: opts.reason }); return { ok: true }; };
  // A：撞额度时旧会话还在忙（CodeAgent 在自己重试）→ 宽限期内不换号；它重试成功写出回答 → 不换号，照常回执
  const a = await r.home.ask('home-s', { question: 'A：旧会话撞额度后自己重试成功的情况' });
  await r.company.checkNow(); await r.company.checkNow();
  const sa = r.created()[0].id;
  r.cs.busy.add(sa);
  r.inject(sa);
  await step(r, 2000); await step(r, 20000);
  assert.equal(r.created().length, 1, '旧会话还在忙：宽限期内不换号');
  r.cs.answer(sa, 'A 的回答：重试后成功。'); r.cs.finals.get(sa).at(-1).timestamp = r.clock.now + 1000;
  r.cs.busy.delete(sa);
  await step(r); await step(r, 1000);
  assert.equal(r.created().length, 1, '旧会话自己答出来了：不换号');
  assert.match(r.home.thread(a.thread).rounds[0].reply, /重试后成功/);
  // B：撞额度、旧会话一直忙过了宽限期 → 换号；旧会话停下后被休眠
  Q.clearAvoid(path.join(r.root, 'company'), 'ds01');
  const b = await r.home.ask('home-s', { question: 'B：旧会话撞额度后一直在忙的情况' });
  await r.company.checkNow(); await r.company.checkNow();
  const sb = r.created()[1].id;
  assert.equal(r.account(r.created()[1]), 'ds01');
  r.cs.busy.add(sb);
  r.inject(sb);
  await step(r, 2000);
  assert.equal(r.created().length, 2);
  await step(r, 61000);
  assert.equal(r.created().length, 3, '过了宽限期仍在忙：换号');
  assert.equal(r.company.thread(b.thread).prevSessions[0].sessionId, sb);
  assert.ok(!suspended.some(x => x.id === sb), '旧会话还在忙：不休眠');
  r.cs.busy.delete(sb);
  await step(r, 61000);
  assert.ok(suspended.some(x => x.id === sb && x.reason === 'company-bridge-rehomed'), '旧会话停下后被休眠');
  assert.ok(!suspended.some(x => x.id === r.created()[2].id), '新会话不动');
});

test('代称固定：删掉一个号后，其余号的代称不变；新号不复用旧序号', t => {
  const dataDir = tmp(t);
  const pool = require('../core/codeagent-pool');
  const a = pool.addAccount(dataDir, { note: 'a' }), b = pool.addAccount(dataDir, { note: 'b' });
  assert.deepEqual([...Q.aliasMap(dataDir)].filter(([k]) => k !== 'personal').map(([k, v]) => [k === a ? 'a' : 'b', v]), [['a', '号 1'], ['b', '号 2']]);
  pool.removeAccount(dataDir, a);
  const c = pool.addAccount(dataDir, { note: 'c' });
  const m = Q.aliasMap(dataDir);
  assert.equal(m.get(b), '号 2', '删号后「号 2」仍指同一个号');
  assert.equal(m.get(c), '号 3', '新号不复用「号 1」');
  assert.equal(Q.keyForAlias(m, '号2'), b);
  const D = require('../core/company-bridge/diag');
  assert.equal(D.poolAliases({ accounts: [{ id: b }, { id: c }] }, dataDir).get(c), '号 3', '直查用同一份固定代称');
});

test('原生记录尾部读取按字节找行：第一次只读尾部时多字节字符被切开也不丢下一行', () => {
  const { completeLines } = require('../core/company-bridge/quota-watch');
  const lines = ['{"a":"甲乙丙"}', '{"b":"丁"}', '{"c":"戊"}'];
  const buf = Buffer.from(lines.join('\n') + '\n', 'utf8');
  const cut = buf.subarray(5); // 从「甲」的中间切开
  const r = completeLines(cut, false);
  assert.equal(r.text, lines.slice(1).join('\n'));
  assert.equal(r.consumed, cut.length);
  assert.equal(completeLines(buf, true).text, lines.join('\n'));
});
