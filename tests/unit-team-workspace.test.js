'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createTeamWorkspace } = require('../core/team-workspace');

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-team-'));
  const now = Date.parse('2026-10-23T12:00:00Z');
  const fixture = { owner: 'owner-a', online: true, rows: [], calls: [], chats: [], now, coverage: { status: 'complete', scanned: 2, errors: [] } };
  const assistant = {
    auth: { status: () => ({ state: fixture.online ? 'online' : 'unknown', login: { ok: fixture.online, uid: fixture.owner } }) },
    rawWelink: async args => {
      fixture.calls.push(args);
      return { code: 0, stdout: JSON.stringify({ code: '0', users: fixture.users || [{ w3Account: 'member-a', personAccount: 'member-a', chineseName: '示例同事', workId: '1001' }] }) };
    },
    query: {
      execute: async args => {
        fixture.calls.push(args);
        if (fixture.queryHook) await fixture.queryHook(args);
        if (args.op === 'read') {
          const row = fixture.rows.find(r => r.sourceId === args.sourceId), offset = args.offset || 0;
          return { item: { ...row, text: row.text.slice(offset, offset + 6000) }, nextOffset: offset + 6000 < row.text.length ? offset + 6000 : null };
        }
        const offset = args.cursor ? Number(args.cursor.split(':')[1]) : 0;
        return { queryId: 'query-1', coverage: fixture.coverage, items: fixture.rows.slice(offset, offset + 50), nextCursor: offset + 50 < fixture.rows.length ? 'query-1:' + (offset + 50) : null };
      },
      message: async ({ ids }) => ({ items: ids.map(sourceId => ({ sourceId, contextRefs: [], context: [] })) }),
    },
    ask: prompt => { const item = { id: 'chat-' + fixture.chats.length, state: 'queued', q: prompt }; fixture.chats.push(item); return item; },
    chat: () => fixture.chats,
  };
  fixture.assistant = assistant;
  fixture.team = createTeamWorkspace({ dataDir: dir, getAssistant: () => assistant, now: () => fixture.now });
  fixture.call = args => fixture.team.execute({ expectedOwner: fixture.owner, ...args });
  fixture.dir = dir;
  fixture.add = async () => {
    const result = await fixture.call({ op: 'resolve', input: '1001' });
    const state = await fixture.call({ op: 'follow', resolutionId: result.resolutionId, account: 'member-a', confirmed: true });
    return state.members[0];
  };
  fixture.row = (i, fields = {}) => ({ sourceId: 'msg:g:' + i, account: 'member-a', sender: '示例同事', at: now - 1000 - i, text: '有阻塞，需要协调 ' + i, convName: '示例群', group: true, ...fields });
  t.after(() => { fixture.team.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  return fixture;
}

test('身份必须精确查询并人工确认，ID 注入在执行 CLI 前拒绝', async t => {
  const f = setup(t);
  for (const input of ['--help', '../x', 'a;whoami', 'a\nwhoami', '同事']) await assert.rejects(f.call({ op: 'resolve', input }), /完整 WeLink/);
  assert.equal(f.calls.length, 0);
  const resolved = await f.call({ op: 'resolve', input: '1001' });
  assert.deepEqual(f.calls[0], ['contact', 'detail', '1001']);
  await assert.rejects(f.call({ op: 'follow', resolutionId: resolved.resolutionId, account: 'member-a' }), /确认/);
  await assert.rejects(f.call({ op: 'follow', resolutionId: resolved.resolutionId, account: 'another', confirmed: true }), /核对/);
  const state = await f.call({ op: 'follow', resolutionId: resolved.resolutionId, account: 'member-a', confirmed: true });
  assert.equal(state.members.length, 1);
  await assert.rejects(f.call({ op: 'resolve', input: 'member' }), /精确核对/);
});

test('不把同名或冲突账号当身份，工号有多个精确候选供用户选择', async t => {
  const f = setup(t);
  f.users = [{ w3Account: 'member-a', personAccount: 'other', chineseName: '同名', workId: '1001' }];
  await assert.rejects(f.call({ op: 'resolve', input: '1001' }), /精确核对/);
  f.users = ['member-a', 'member-b'].map(account => ({ w3Account: account, chineseName: '同名', workId: '1001' }));
  assert.equal((await f.call({ op: 'resolve', input: '1001' })).candidates.length, 2);
});

test('未登录和换号不暴露资料，跨账号确认和取数写回均失败', async t => {
  const f = setup(t); await f.add();
  f.online = false;
  assert.equal(f.team.state().available, false); assert.equal(f.team.state().members.length, 0);
  await assert.rejects(f.call({ op: 'weekly.draft' }), /登录/);
  f.online = true;
  const resolved = await f.call({ op: 'resolve', input: '1001' });
  f.owner = 'owner-b'; assert.equal(f.team.state().members.length, 0);
  await assert.rejects(f.call({ op: 'follow', resolutionId: resolved.resolutionId, account: 'member-a', confirmed: true }), /失效/);
  f.owner = 'owner-a'; f.rows = [f.row(1)];
  f.queryHook = async () => { f.owner = 'owner-b'; };
  await assert.rejects(f.call({ op: 'refresh' }), /账号已改变/);
  assert.equal(f.team.state().evidence.length, 0);
  f.owner = 'owner-a'; assert.equal(f.team.state().lastRefresh, null);
});

test('七天查询翻完全部分页、精确 sender 账号、全文分页和重复去除', async t => {
  const f = setup(t); await f.add();
  f.rows = Array.from({ length: 53 }, (_, i) => f.row(i));
  f.rows[0].text = '甲'.repeat(13000) + '最后已解决';
  f.rows[10].account = 'member-a-extra';
  f.rows[11].account = ''; f.rows[11].sender = 'member-a';
  f.rows[12].at = NaN;
  f.rows.push(f.rows[1]);
  const state = await f.call({ op: 'refresh' });
  assert.equal(state.evidence.length, 50); assert.equal(state.lastRefresh.pages, 2);
  assert.equal(state.lastRefresh.range.end - state.lastRefresh.range.start, 7 * 86400000);
  assert.equal(state.evidence[0].text, f.rows[0].text);
  assert.equal(state.evidence[0].context.length, 0);
  const query = f.calls.find(c => c.op === 'list');
  assert.equal(query.scope, 'all'); assert.equal(Object.hasOwn(query, 'person'), false);
});

test('分页失败保留已取得证据并标覆盖不足，零消息不作状态判断', async t => {
  const f = setup(t); await f.add(); f.rows = Array.from({ length: 51 }, (_, i) => f.row(i));
  f.queryHook = async args => { if (args.cursor) throw new Error('第二页网络失败'); };
  let state = await f.call({ op: 'refresh' });
  assert.equal(state.evidence.length, 50); assert.equal(state.lastRefresh.coverage.status, 'partial');
  assert.match(state.lastRefresh.error, /第二页/);
  f.queryHook = null; f.rows = [];
  state = await f.call({ op: 'refresh' });
  assert.equal(state.evidence.length, 0); assert.match(state.lastRefresh.coverage.reasons.join(''), /不能据此/);
  await assert.rejects(f.call({ op: 'analyze' }), /没有消息/);
});

test('AI 走现有助理且批量共用一个任务，结果须绑定请求和真实出处', async t => {
  const f = setup(t); await f.add(); f.rows = [f.row(1)];
  await f.call({ op: 'refresh' });
  let state = await f.call({ op: 'analyze' });
  assert.equal(f.chats.length, 1); assert.match(f.chats[0].q, /本机证据文件/);
  const analysis = state.analyses[0];
  await assert.rejects(f.call({ op: 'analyze' }), /已有团队分析/);
  Object.assign(f.chats[0], { state: 'done', a: JSON.stringify({ requestId: analysis.id, findings: [{ kind: 'fact', text: '需要协调', sourceIds: ['msg:g:1'] }] }) });
  state = await f.call({ op: 'analysis.sync' });
  assert.equal(state.analyses[0].state, 'done'); assert.match(state.analyses[0].text, /出处/);
  state = await f.call({ op: 'analyze' });
  Object.assign(f.chats[1], { state: 'done', a: JSON.stringify({ requestId: state.analyses[1].id, findings: [{ kind: 'fact', text: '捏造', sourceIds: ['msg:fake'] }] }) });
  state = await f.call({ op: 'analysis.sync' });
  assert.equal(state.analyses[1].state, 'error'); assert.match(state.analyses[1].error, /无效出处/);
  state = await f.call({ op: 'analyze' });
  Object.assign(f.chats[2], { state: 'done', a: JSON.stringify({ requestId: 'another-request', findings: [] }) });
  assert.equal((await f.call({ op: 'analysis.sync' })).analyses[2].state, 'error');
});

test('承诺确认、去重、更正与撤销保留证据；周报只含确认事项且可保存', async t => {
  const f = setup(t), member = await f.add(); f.rows = [f.row(1)]; await f.call({ op: 'refresh' });
  const add = { op: 'commitment.add', title: '协调资源', memberId: member.id, sourceIds: ['msg:g:1'] };
  await assert.rejects(f.call(add), /确认/);
  let state = await f.call({ ...add, confirmed: true });
  state = await f.call({ ...add, sourceIds: ['msg:g:1', 'msg:g:1'], confirmed: true });
  assert.equal(state.commitments.length, 1);
  const id = state.commitments[0].id;
  state = await f.call({ op: 'commitment.update', id, title: '已协调资源', status: 'done' });
  assert.equal(state.commitments[0].revisions.length, 1);
  f.rows = []; await f.call({ op: 'refresh' });
  state = await f.call({ op: 'weekly.draft' });
  assert.equal(state.commitments[0].evidence[0].text, '有阻塞，需要协调 1');
  assert.match(state.weeklyDrafts[0].text, /已协调资源/); assert.doesNotMatch(state.weeklyDrafts[0].text, /有阻塞，需要协调 1/);
  state = await f.call({ op: 'weekly.update', id: state.weeklyDrafts[0].id, text: '本人修改的周报' });
  const second = createTeamWorkspace({ dataDir: f.dir, getAssistant: () => f.assistant });
  assert.equal(second.state().weeklyDrafts[0].text, '本人修改的周报');
  await f.call({ op: 'commitment.update', id, status: 'cancelled' });
  await assert.rejects(f.call({ op: 'weekly.draft' }), /尚无已确认/);
});

test('取消关注可恢复，自动刷新默认关闭、按账号串行、不重叠', async t => {
  const f = setup(t), member = await f.add();
  assert.equal(f.team.state().settings.autoRefresh, false);
  await f.team.tick(); assert.equal(f.calls.filter(c => c.op === 'list').length, 0);
  await assert.rejects(f.call({ op: 'unfollow', memberId: member.id }), /确认/);
  let state = await f.call({ op: 'unfollow', memberId: member.id, confirmed: true }); assert.equal(state.members[0].active, false);
  state = await f.call({ op: 'restore', memberId: member.id }); assert.equal(state.members[0].active, true);
  await f.call({ op: 'settings', autoRefresh: true });
  f.rows = [f.row(1)]; await f.team.tick(); await f.team.tick();
  assert.equal(f.calls.filter(c => c.op === 'list').length, 1);
  let release;
  f.queryHook = () => new Promise(resolve => { release = resolve; });
  const pending = f.call({ op: 'refresh' });
  await assert.rejects(f.call({ op: 'refresh' }), /上一项/);
  f.queryHook = null; release(); await pending;
});

test('损坏资料不会静默清空或覆盖，离线助理不回退到快照身份', async t => {
  const f = setup(t); await f.add();
  const file = f.team.file('owner-a'); fs.writeFileSync(file, '{broken', 'utf8');
  assert.throws(() => f.team.state(), /不会覆盖/);
  await assert.rejects(f.call({ op: 'settings', autoRefresh: true }), /不会覆盖/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
  const offline = createTeamWorkspace({ dataDir: f.dir, getAssistant: () => ({ snapshot: () => ({ login: { uid: 'owner-a', ok: true } }) }) });
  assert.equal(offline.state().available, false);
});

test('真实 AssistantQuery 上下文契约：全文分页保留相邻消息末尾的已解决反转', async t => {
  const { AssistantQuery } = require('../core/company-assistant/query-tool');
  const f = setup(t); await f.add();
  const first = f.row(1, { conv: 'g', text: '阻塞尚需协调' });
  const reversal = f.row(2, { conv: 'g', account: 'manager', sender: '负责人', at: first.at + 1, text: '协调过程'.repeat(3500) + '最终确认：问题已解决，无需继续跟进。' });
  f.assistant.dir = path.join(f.dir, 'company-assistant');
  f.assistant.now = () => f.now;
  f.assistant.collectQuery = async () => ({ login: { ok: true, uid: f.owner }, messages: { g: [first, reversal] }, scope: { fetched: 1 }, errors: [] });
  f.assistant.query = new AssistantQuery(f.assistant);
  const state = await f.call({ op: 'refresh' });
  assert.equal(state.lastRefresh.coverage.status, 'complete');
  assert.equal(state.evidence.length, 1);
  assert.equal(state.evidence[0].contextEvidence[0].text, reversal.text);
  assert.match(state.evidence[0].context[0], /最终确认：问题已解决，无需继续跟进。/);
  const page = await f.assistant.query.execute({ op: 'list', kind: 'messages', scope: 'all', period: 'last24h' });
  const message = await f.assistant.query.message({ queryId: page.queryId, ids: [first.sourceId] });
  assert.equal(message.items[0].contextRefs[0].sourceId, reversal.sourceId);
  assert.ok(message.items[0].context[0].length < reversal.text.length, '保留旧摘要接口，团队通过结构化出处读取全文');
  let analyzed = await f.call({ op: 'analyze' });
  const request = analyzed.analyses[0];
  assert.deepEqual(new Set(request.sourceIds), new Set([first.sourceId, reversal.sourceId]));
  assert.match(f.chats[0].q, /contextEvidence/);
  Object.assign(f.chats[0], { state: 'done', a: JSON.stringify({ requestId: request.id, findings: [{ kind: 'fact', text: '负责人已确认解决', sourceIds: [reversal.sourceId] }] }) });
  // Validation uses the frozen capture, even when a later refresh drops the row.
  f.assistant.collectQuery = async () => ({ login: { ok: true, uid: f.owner }, messages: {}, scope: { fetched: 1 }, errors: [] });
  await f.call({ op: 'refresh' });
  analyzed = await f.call({ op: 'analysis.sync' });
  assert.equal(analyzed.evidence.length, 0);
  assert.equal(analyzed.analyses[0].state, 'done');
  assert.equal(analyzed.analyses[0].findings[0].sourceIds[0], reversal.sourceId);
});

test('相邻上下文全文失败时保留主体证据并明确覆盖不足', async t => {
  const f = setup(t); await f.add(); f.rows = [f.row(1)];
  f.assistant.query.message = async () => ({ items: [{ contextRefs: [{ sourceId: 'msg:missing', account: 'manager' }] }] });
  const state = await f.call({ op: 'refresh' });
  assert.equal(state.evidence.length, 1);
  assert.equal(state.lastRefresh.coverage.status, 'partial');
  assert.ok(state.lastRefresh.error);
});

test('旧 A 页面在后端切 B 后无法写入草稿、承诺或设置，缺少 expectedOwner 同样拒绝', async t => {
  const f = setup(t);
  const oldOwner = f.team.state().owner;
  f.owner = 'owner-b';
  const staleRequests = [
    { op: 'commitment.add', title: 'A 页面尚未保存的敏感承诺', confirmed: true },
    { op: 'weekly.update', id: 'old-draft', text: 'A 的旧周报' },
    { op: 'settings', autoRefresh: true },
    { op: 'resolve', input: '1001' },
    { op: 'analysis.sync' },
  ];
  for (const request of staleRequests) {
    await assert.rejects(f.team.execute({ ...request, expectedOwner: oldOwner }), /页面的登录账号已过期或改变/);
    await assert.rejects(f.team.execute(request), /页面的登录账号已过期或改变/);
  }
  assert.equal(f.team.state().commitments.length, 0);
  assert.equal(f.team.state().settings.autoRefresh, false);
  assert.equal(fs.existsSync(f.team.file('owner-b')), false);
  assert.equal(f.calls.length, 0);
  const result = await f.team.execute({ op: 'commitment.add', expectedOwner: 'owner-b', title: 'B 本人新建', confirmed: true });
  assert.equal(result.commitments[0].title, 'B 本人新建');
});

test('持久化 A 登录重启后必须先实查，五分钟旧缓存不得暴露 A，查到 B 后仅显示 B', async t => {
  const { CompanyAssistant } = require('../core/company-assistant/service');
  const f = setup(t); await f.add();
  const assistantDir = path.join(f.dir, 'company-assistant'); fs.mkdirSync(assistantDir, { recursive: true });
  const saved = { state: 'online', login: { ok: true, uid: 'owner-a' }, lastCheckAt: f.now - 1000, lastAttemptAt: 100, lastRenewAt: 200, scanAttempts: 1 };
  const authFile = path.join(assistantDir, 'auth.json'); fs.writeFileSync(authFile, JSON.stringify(saved), 'utf8');
  const calls = [];
  const restarted = new CompanyAssistant({ dataDir: f.dir, noTimer: true, noTools: true, now: () => f.now,
    welinkRun: async args => { calls.push(args); return { code: 0, stdout: 'UID: owner-b\nUser Token: VALID (expires in 29m11s)', stderr: '' }; },
  });
  t.after(() => restarted.close());
  const team = createTeamWorkspace({ dataDir: f.dir, getAssistant: () => restarted, now: () => f.now });
  assert.equal(restarted.auth.status().state, 'unknown');
  assert.equal(restarted.auth.status().login, null);
  assert.equal(restarted.auth.status().lastCheckAt, 0);
  assert.equal(restarted.auth.status().scanAttempts, 1);
  assert.equal(restarted.auth.status().lastAttemptAt, 100);
  assert.equal(restarted.auth.status().lastRenewAt, 200);
  assert.deepEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')), saved, '构造时不删改已有凭据或诊断文件');
  assert.equal(team.state().available, false); assert.equal(team.state().owner, null); assert.equal(team.state().members.length, 0);
  await restarted.auth.check();
  assert.deepEqual(calls, [['auth', 'status']], '不强制也必须立即实查，不能复用上个进程五分钟缓存');
  assert.equal(team.state().owner, 'owner-b'); assert.equal(team.state().members.length, 0);
  assert.equal(f.team.load('owner-a').members.length, 1, 'A 资料保留但不对 B 展示');
});
