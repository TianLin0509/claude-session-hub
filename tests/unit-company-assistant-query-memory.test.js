'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AssistantQuery, queryRange } = require('../core/company-assistant/query-tool');
const { AssistantMemory, MAX_CONTEXT } = require('../core/company-assistant/memory');
const { collectCalendar } = require('../core/company-assistant/queries');
const { CompanyAssistant } = require('../core/company-assistant/service');
const D = require('../core/company-assistant/data');
const NOW = Date.parse('2026-10-21T10:00:00+08:00');
function rig(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-query-memory-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let now = NOW, owner = 'owner-a';
  const data = new Map();
  const a = { dir, now: () => now, read: (f, d) => data.get(f) ?? d, write: (f, v) => data.set(f, JSON.parse(JSON.stringify(v))),
    snapshot: () => ({ login: { uid: owner } }), job: { type: 'chat', chatId: 'chat-current' }, chat: () => [{ id: 'chat-current', q: '记住：人甲是直属领导', askedAt: now }],
    setOwner: x => { owner = x; }, setNow: x => { now = x; } };
  a.memory = new AssistantMemory(a); a.query = new AssistantQuery(a);
  return a;
}
const message = (i, patch = {}) => ({ sourceId: `msg:private:${i}`, conv: 'private', convName: '同事甲', key: String(i), group: false, at: NOW - 100000 + i,
  sender: '同事甲', account: 'a', text: `消息${i}`, mine: false, atMe: false, atAll: false, ...patch });
function snapshot(rows, patch = {}) {
  return { login: { ok: true, uid: 'owner-a' }, messages: { private: rows }, errors: [],
    scope: { listed: 1, fetched: 1, known: 1, partial: 0, listFull: false, conversations: [{ status: 'complete' }] }, ...patch };
}
test('窗口按上海自然日与过去24小时区分，拒绝无时区custom与倒置窗口', () => {
  assert.equal(queryRange({ period: 'today' }, NOW).start, Date.parse('2026-10-21T00:00:00+08:00'));
  assert.equal(queryRange({ period: 'last24h' }, NOW).start, NOW - 86400000);
  assert.throws(() => queryRange({ period: 'custom', start: '2026-10-21 00:00', end: '2026-10-22 00:00' }, NOW), /时区/);
  assert.throws(() => queryRange({ period: 'custom', start: '2026-10-22T00:00:00+08:00', end: '2026-10-21T00:00:00+08:00' }, NOW), /起点/);
});
test('250条私聊全部可分页读完：后页沿用同一快照，长文可读到末尾与上下文', async t => {
  const a = rig(t); let calls = 0;
  const rows = Array.from({ length: 250 }, (_, i) => message(i, i === 0 ? { text: '长'.repeat(6500) + '最后结论' } : {}));
  a.collectQuery = async () => { calls += 1; return snapshot(rows); };
  let result = await a.query.inbox({ hours: 24 }), count = 0;
  const id = result.queryId;
  assert.match(result.text, /私聊 250 条/);
  do { count += (result.text.match(/\[msg:private:/g) || []).length; result = result.nextCursor ? await a.query.inbox({ cursor: result.nextCursor }) : null; } while (result);
  assert.equal(count, 250); assert.equal(calls, 1);
  const first = await a.query.message({ ids: [rows[0].sourceId], queryId: id });
  assert.equal(first.items[0].nextOffset, 6000); assert.equal(first.items[0].context.length, 3);
  const tail = await a.query.message({ ids: [rows[0].sourceId], queryId: id, offset: 6000 });
  assert.match(tail.items[0].text, /最后结论/); assert.equal(tail.items[0].nextOffset, null);
});
test('服务端会话目录封顶或某页失败时不声称查全；保留过去24h半开区间', async t => {
  const a = rig(t);
  a.collectQuery = async () => snapshot([message(1), message(2, { at: NOW }), message(3, { at: NOW - 86400001 })],
    { scope: { listed: 50, fetched: 61, known: 61, listCap: 50, listFull: true, partial: 1, conversations: [{ unknownTime: 1 }] } });
  const result = await a.query.inbox({});
  assert.equal(result.total, 1); assert.match(result.text, /可能不全/); assert.match(result.text, /从未发现/); assert.match(result.text, /61 个会话/);
});
test('分页过期、换身份和不合法cursor明确失败，不能读旧账号消息', async t => {
  const a = rig(t); a.collectQuery = async () => snapshot([message(1), message(2)]);
  const result = await a.query.inbox({ limit: 1 });
  a.setOwner('owner-b'); await assert.rejects(a.query.inbox({ cursor: result.nextCursor }), /身份/);
  a.setOwner('owner-a'); a.setNow(NOW + 3600001); await assert.rejects(a.query.inbox({ cursor: result.nextCursor }), /过期/);
  await assert.rejects(a.query.inbox({ cursor: '../private' }), /游标/);
});
test('会议工具只输出确定的上海时间；一个数据源失败不说没有会议', async t => {
  const a = rig(t);
  a.collectQuery = async () => ({ login: { ok: true, uid: 'owner-a' }, meetings: D.meetings({ data: { data: [{ meetingId: 'm1', subject: 'UTC会议', meetingStartTime: '2026-10-21T09:00:00Z', meetingEndTime: '2026-10-21T10:00:00Z' }] } }), calendar: [],
    meetingCoverage: { status: 'complete' }, calendarCoverage: { status: 'failed', reasonLabel: '模拟日程错误' }, errors: [{ label: '日程', text: '模拟日程错误' }] });
  const result = await a.query.meetings({ date: '今天' });
  assert.match(result.text, /17:00/); assert.match(result.text, /18:00/); assert.match(result.text, /模拟日程错误/); assert.doesNotMatch(result.text, /1792\d{9}/);
});

test('会议逐条保留来源，范围明确为待参加，跨源总数按记录而非场数', async t => {
  const a = rig(t);
  a.collectQuery = async () => ({ login: { ok: true, uid: 'owner-a' },
    meetings: D.meetings([{ meetingId: 'm1', subject: '跨区评审', meetingStartTime: '2026-10-21T09:00:00Z', meetingEndTime: '2026-10-21T10:00:00Z' }]),
    calendar: D.calendarEvents([{ id: 'c1', subject: '中国区对齐会', start: '2026-10-21T14:00:00+08:00', end: '2026-10-21T15:00:00+08:00' }]),
    meetingCoverage: { status: 'complete', queryType: '1' }, calendarCoverage: { status: 'complete' }, errors: [] });
  const result = await a.query.meetings({ date: '今天' });
  const lines = result.text.split('\n');
  assert.match(lines.find(line => line.includes(' · 跨区评审 · ')), / · WeLink 待参加会议 \[meeting:/);
  assert.match(lines.find(line => line.includes(' · 中国区对齐会 · ')), / · Exchange 日程 \[cal:/);
  assert.match(result.text, /范围说明：WeLink 当前只查询待参加会议（类型 1）/);
  assert.match(result.text, /2 条记录：WeLink 1 条、Exchange 1 条/);
  assert.doesNotMatch(result.text, /该类型能覆盖哪些会议仍待核实/);
});
test('真实会议MCP取数链同时查询待参加和已结束，逐条来源准确；已结束失败时公开缺口', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  let failEnded = false;
  const types = [];
  svc.welink = async args => {
    const json = body => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: owner-a\nToken: VALID', stderr: '' };
    if (args[0] === 'calendar') return json([]);
    if (args[0] === 'meeting') {
      const type = args[args.indexOf('--type') + 1]; types.push(type);
      if (type === '2' && failEnded) return { code: 1, stdout: '', stderr: '合成已结束查询故障' };
      const ended = type === '2';
      return json({ code: 200, data: { total: 1, data: [{ meetingId: ended ? 'past' : 'future', subject: ended ? '上午复盘' : '下午评审',
        meetingStartTime: `2026-10-21T${ended ? '08' : '17'}:00:00+08:00`, meetingEndTime: `2026-10-21T${ended ? '09' : '18'}:00:00+08:00` }] } });
    }
    throw new Error('未预期命令：' + args.slice(0, 2).join(' '));
  };
  const result = await svc.query.meetings({ date: '今天' });
  assert.deepEqual(types, ['1', '2']);
  assert.equal(result.total, 2);
  assert.match(result.text, /当前只查询待参加及已结束会议（类型 1、2）/);
  assert.match(result.text.split('\n').find(x => x.includes(' · 上午复盘 · ')), /08:00.*09:00.*WeLink 已结束会议/);
  assert.match(result.text.split('\n').find(x => x.includes(' · 下午评审 · ')), /17:00.*18:00.*WeLink 待参加会议/);
  assert.equal(svc.query.load(result.queryId).coverage.meeting.byType['2'].status, 'complete');
  failEnded = true;
  const partial = await svc.query.meetings({ date: '今天' });
  assert.equal(partial.total, 1);
  assert.match(partial.text, /WeLink 会议：未取全/);
  assert.match(partial.text, /已结束：会议查询失败/);
  assert.match(partial.text, /合成已结束查询故障/);
  assert.equal(svc.query.load(partial.queryId).coverage.meeting.byType['2'].status, 'failed');
});
test('两类会议都返回未知结构时，日常简报仍收到具体取数失败原因', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  svc.setSettings({ email: 'fixture@example.com' });
  svc.welink = async args => {
    const json = body => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: owner-a\nToken: VALID', stderr: '' };
    if (args[0] === 'meeting') return json({ code: 200, data: { total: 0, unknown: [] } });
    if (args[0] === 'calendar') return json([]);
    if (args[0] === 'mail') return json({ mails: [] });
    if (args[1] === 'query-recent-conversation') return json({ error: { error_code: 'IM.0000' }, conversation_info: [] });
    throw new Error('未预期命令：' + args.slice(0, 2).join(' '));
  };
  const snap = await svc.collect();
  assert.equal(snap.meetingCoverage.status, 'failed');
  assert.equal(snap.meetingCoverage.byType['1'].reason, 'invalid-shape');
  assert.equal(snap.meetingCoverage.byType['2'].reason, 'invalid-shape');
  const reason = snap.errors.find(x => x.label === '会议')?.text;
  assert.match(reason || '', /待参加：会议返回结构.*已结束：会议返回结构/);
  const prompt = require('../core/company-assistant/brief').briefPrompt(snap, { day: D.dayKey(NOW), now: NOW });
  assert.match(prompt, /查询有 1 项失败或不完整/);
  assert.ok(prompt.includes(reason));
});
test('同日复用已收到v6说明的助理会话时，下一问收到待参加及已结束的新说明', async t => {
  const base = rig(t), sent = [];
  const svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW,
    sendPrompt: async (id, prompt) => { sent.push({ id, prompt }); return { ok: true }; } });
  t.after(() => svc.close());
  svc.ensureSession = async () => 'existing'; svc.sessionBusy = () => false; svc.lastFinal = () => null;
  svc.saveState({ sessionId: 'existing', primed: 'existing', instructionsVersion: 6, instructionsDay: D.dayKey(NOW) });
  svc.queue.push({ id: 'upgrade-query', type: 'brief', prompt: '今天有哪些会议' });
  await svc.pump();
  assert.equal(sent.length, 1); assert.equal(sent[0].id, 'existing');
  assert.match(sent[0].prompt, /当前 WeLink 分别查询待参加及已结束会议/);
  assert.ok(svc.state().instructionsVersion > 6);
});
test('日程按下一天作为结束边界；错误结构与更多页不会被算作空成功', async () => {
  const range = queryRange({ period: 'today' }, NOW); let call;
  const good = await collectCalendar(async (label, args) => { call = args; return { events: [] }; }, range);
  assert.equal(call[call.indexOf('--end') + 1], '2026-10-22'); assert.equal(good.coverage.status, 'complete');
  const bad = await collectCalendar(async () => ({ unexpected: [] }), range); assert.equal(bad.coverage.status, 'failed');
  const partial = await collectCalendar(async () => ({ events: [], total: 5 }), range); assert.equal(partial.coverage.status, 'partial');
  const nested = await collectCalendar(async () => ({ data: { value: [], '@odata.nextLink': 'more' } }), range); assert.equal(nested.coverage.status, 'partial');
});
test('记忆保存后重新实例仍能查、同key更新且保留出处；上下文不超过1200字', t => {
  const a = rig(t);
  const first = a.memory.execute({ op: 'add', kind: 'person', key: '人甲', text: '直属领导，消息优先' });
  const reopened = new AssistantMemory(a);
  assert.equal(reopened.search('人甲是谁')[0].text, '直属领导，消息优先');
  const changed = reopened.execute({ op: 'update', kind: 'person', key: '人甲', text: '项目负责人' });
  assert.equal(changed.item.id, first.item.id); assert.equal(changed.updated, true); assert.equal(changed.item.source.ref, 'chat-current');
  assert.ok(reopened.context('人甲').length <= MAX_CONTEXT);
  reopened.execute({ op: 'remove', id: first.item.id }); assert.equal(reopened.search('人甲').length, 0);
});
test('每类第16条淘汰最久未用，其他类别和最近用过的保留，并回执被淘汰条目', t => {
  const a = rig(t);
  for (let i = 0; i < 15; i += 1) { a.setNow(NOW + i); a.memory.execute({ op: 'add', kind: 'group', key: `群${i}`, text: '日常协作群' }); }
  a.setNow(NOW + 100); a.memory.touch('群0');
  a.memory.execute({ op: 'add', kind: 'preference', key: '格式', text: '少讲术语' });
  const next = a.memory.execute({ op: 'add', kind: 'group', key: '群15', text: '新群' });
  assert.equal(next.evicted.key, '群1'); assert.ok(a.memory.active().some(x => x.key === '群0'));
  assert.equal(a.memory.active().filter(x => x.kind === 'group').length, 15); assert.equal(a.memory.active().length, 16);
});
test('记忆不可从无用户轮次自动学习，UI可显式编辑，身份改变不混用', t => {
  const a = rig(t); a.job = null;
  assert.throws(() => a.memory.execute({ op: 'add', key: '事实', text: '不自动学' }), /当前用户对话/);
  a.memory.execute({ op: 'add', kind: 'preference', key: '表述', text: '使用私聊一词' }, { fromSettings: true });
  assert.equal(a.memory.active().length, 1); a.setOwner('owner-b'); assert.equal(a.memory.active().length, 0);
});
test('记忆UI按id改称呼和类别仍是同一条，不留下旧内容或覆盖其他key', t => {
  const a = rig(t), input = { op: 'add', kind: 'person', key: '人甲', text: '项目负责人' };
  const before = a.memory.execute(input);
  const after = a.memory.execute({ op: 'update', id: before.item.id, kind: 'group', key: '项目组', text: '项目协作群' }, { fromSettings: true });
  assert.equal(after.item.id, before.item.id); assert.equal(a.memory.active().length, 1); assert.equal(a.memory.search('项目组')[0].kind, 'group');
  assert.throws(() => a.memory.execute({ ...input, op: 'update', id: 'unknown' }), /找不到/);
});
test('消息读取校验当前登录身份，邻近上下文的出处也能继续读取', async t => {
  const a = rig(t), rows = [message(1, { group: true, atMe: true }), message(2, { group: true })];
  a.collectQuery = async () => snapshot(rows);
  const found = await a.query.inbox({ scope: ['@我'] });
  const read = await a.query.message({ ids: [rows[1].sourceId], queryId: found.queryId });
  assert.match(read.items[0].text, /消息2/);
  a.auth = { status: () => ({ login: { uid: 'other-owner' } }) };
  await assert.rejects(a.query.message({ ids: [rows[0].sourceId] }), /身份/);
});
test('给模型的会议快照不暴露原始时间戳，但内部快照不改动', () => {
  const snap = { meetings: [{ sourceId: 'meeting:1', start: NOW, end: NOW + 3600000, timeEvidence: { raw: NOW } }], calendar: [] };
  const output = CompanyAssistant.prototype.agentSnapshot(snap);
  assert.equal(output.meetings[0].start, undefined); assert.equal(output.meetings[0].timeEvidence, undefined);
  assert.match(output.meetings[0].startDisplay, /10:00/); assert.equal(snap.meetings[0].start, NOW);
});
test('真实取数器：历史已知第60个群仍补查；250条私聊翻3页；二次只增量且不虚报目录完整', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  const catalog = Array.from({ length: 80 }, (_, i) => ({ id: i === 0 ? 'p0' : `g${i}`, name: `会话${i}`, group: i !== 0, seenAt: NOW - 3600000 }));
  svc.write('conversation-catalog.json', { identity: 'owner-a', conversations: catalog });
  let history = 0;
  const rows = Array.from({ length: 250 }, (_, i) => ({ msgId: String(99000000000000000n + BigInt(i)), sender: 'colleague', content: `全文${i}`, serverSendTime: NOW - 250000 + i * 100, contentType: 'TEXT_MSG' }));
  svc.welink = async args => {
    const json = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: owner-a\nToken: VALID', stderr: '' };
    if (args[1] === 'query-recent-conversation') return json({ conversation_info: catalog.slice(0, 50).map(c => c.group ? { group_id: c.id, group_name: c.name, recent_conversation_type: 'CHAT_TYPE_GROUP_MSG' } : { target_account: c.id, native_name: c.name, group_id: '0', recent_conversation_type: 'CHAT_TYPE_P2P_MSG' }) });
    if (args[1] === 'query-history-message') {
      const target = args[3], at = name => args.includes(name) ? args[args.indexOf(name) + 1] : null, cursor = at('--message-id');
      if (target === 'p0') { history += 1; return json({ chatInfo: rows.filter(x => !cursor || (at('--query-direction') === '1' ? BigInt(x.msgId) > BigInt(cursor) : BigInt(x.msgId) < BigInt(cursor))).slice(-100) }); }
      if (target === 'g60') return json({ chatInfo: cursor ? [] : [{ msgId: '99000000010000000', sender: 'colleague', content: '请核实此事', serverSendTime: NOW - 1000, atself: true }] });
      return json({ chatInfo: [] });
    }
    if (args[0] === 'contact') return json({ code: 0, users: [] });
    throw new Error('未预期的命令：' + args.join(' '));
  };
  const first = await svc.query.inbox({});
  assert.equal(first.total, 251); assert.match(first.text, /可能不全/); assert.match(first.text, /80 个会话/); assert.equal(history, 3);
  const stored = svc.query.load(first.queryId); assert.ok(stored.items.some(x => x.conv === 'g60' && x.atMe));
  const second = await svc.query.inbox({}); assert.equal(second.total, 251); assert.equal(history, 4, '第二次从缓存最新游标增量补拉一页');
});

test('最近会话请求100个：首次使用没有历史目录也能发现第60个群提及', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  const counts = [], catalog = Array.from({ length: 80 }, (_, i) => ({ group_id: `g${i}`, group_name: `合成群${i}`, recent_conversation_type: 'CHAT_TYPE_GROUP_MSG' }));
  svc.welink = async args => {
    const json = body => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: owner-a\nToken: VALID', stderr: '' };
    if (args[1] === 'query-recent-conversation') {
      const count = Number(args[args.indexOf('--count') + 1]); counts.push(count);
      return json({ error: { error_code: 'IM.0000', error_msg: 'success' }, conversation_info: catalog.slice(0, count) });
    }
    if (args[1] === 'query-history-message') return json({ resultCode: '0', respData: { chatInfo: args[3] === 'g60'
      ? [{ msgId: '99000000010000000', sender: 'other', content: '合成任务', serverSendTime: NOW - 1000, atAccountList: ['owner-a'] }] : [] } });
    return json({ code: 0, users: [] });
  };
  const page = await svc.query.inbox({});
  assert.deepEqual(counts, [100]);
  const stored = svc.query.load(page.queryId);
  assert.equal(stored.coverage.knownConversations, 80);
  assert.equal(page.total, 1);
  assert.equal(stored.items[0].conv, 'g60');
  assert.equal(stored.items[0].atMe, true);
});

test('旧CLI50个上限兼容：100请求失败后回退50，仍明确可能不全', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  const counts = [], catalog = Array.from({ length: 50 }, (_, i) => ({ group_id: `g${i}`, group_name: `合成群${i}`, recent_conversation_type: 'CHAT_TYPE_GROUP_MSG' }));
  svc.welink = async args => {
    const json = body => ({ code: 0, stdout: JSON.stringify(body), stderr: '' });
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: owner-a\nToken: VALID', stderr: '' };
    if (args[1] === 'query-recent-conversation') {
      const count = Number(args[args.indexOf('--count') + 1]); counts.push(count);
      return count > 50 ? { code: 1, stdout: '', stderr: '--count must be <= 50 (synthetic old CLI)' }
        : json({ error: { error_code: 'IM.0000', error_msg: 'success' }, conversation_info: catalog });
    }
    return json({ resultCode: '0', respData: { chatInfo: [] } });
  };
  const page = await svc.query.inbox({});
  assert.deepEqual(counts, [100, 50]);
  const stored = svc.query.load(page.queryId);
  assert.equal(stored.coverage.knownConversations, 50);
  assert.equal(stored.coverage.status, 'partial');
  assert.match(page.text, /可能不全/);
});
test('自动刷新与工具查询共用串行取数队列，失败不锁死下一次任务', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  const order = []; let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const first = svc.withCollection(async () => { order.push('first:start'); await barrier; order.push('first:end'); throw new Error('合成故障'); });
  const second = svc.withCollection(async () => { order.push('second'); return 2; });
  await new Promise(resolve => setImmediate(resolve)); assert.deepEqual(order, ['first:start']); release();
  await assert.rejects(first, /合成故障/); assert.equal(await second, 2); assert.deepEqual(order, ['first:start', 'first:end', 'second']);
});
test('Agent只读包装拒绝邮箱初始化，Hub自身初始化权限保持', async () => {
  const { runReadOnly } = require('../core/company-assistant/welink-ro'), W = require('../core/company-assistant/welink');
  let called = false;
  await assert.rejects(runReadOnly(['mail', 'autodiscover', '--email', 'example@example.com'], { cli: 'fixture', run: async () => { called = true; } }), /拒绝/);
  assert.equal(called, false); assert.deepEqual(W.checkArgs(['mail', 'autodiscover'], { allowSetup: true }), ['mail', 'autodiscover']);
});
test('Agent会议列表须走统一MCP，原始包装不接受同日零长度查询', async () => {
  const { runReadOnly } = require('../core/company-assistant/welink-ro');
  let called = false;
  for (const args of [['calendar', 'list', '--start', '2026-10-21', '--end', '2026-10-21'], ['meeting', 'query-list']])
    await assert.rejects(runReadOnly(args, { cli: 'fixture', run: async () => { called = true; } }), /welink_meetings/);
  assert.equal(called, false);
});
test('取数途中切号首屏即拒绝，登录身份未知不能继续读旧分页', async t => {
  const a = rig(t);
  a.collectQuery = async () => { a.setOwner('owner-b'); return snapshot([message(1)]); };
  await assert.rejects(a.query.inbox({}), /身份/);
  a.setOwner('owner-a'); a.collectQuery = async () => snapshot([message(1), message(2)]);
  const first = await a.query.inbox({ limit: 1 });
  a.auth = { status: () => ({ login: null }) };
  await assert.rejects(a.query.inbox({ cursor: first.nextCursor }), /身份/);
});
test('明确优先关系在分页前排序，普通及非重点记忆不改变顺序', async t => {
  const a = rig(t);
  a.memory.execute({ op: 'add', kind: 'person', key: '负责人乙', text: '项目负责人，消息优先' });
  const rows = [message(1), message(2, { sender: '负责人乙', senderName: '负责人乙', convName: '负责人乙', account: 'b' })];
  a.collectQuery = async () => snapshot(rows);
  let page = await a.query.inbox({ limit: 1 }); assert.match(page.text, /★ 私聊「负责人乙」/); assert.equal(page.total, 2);
  a.memory.execute({ op: 'update', kind: 'person', key: '负责人乙', text: '普通协作同事，不优先' });
  page = await a.query.inbox({ limit: 1 }); assert.match(page.text, /私聊「同事甲」/); assert.doesNotMatch(page.text, /★/);
});
test('编辑带期限的记忆保留期限，显式null才改为长期', t => {
  const a = rig(t), expiresAt = new Date(NOW + 3600000).toISOString();
  const created = a.memory.execute({ op: 'add', kind: 'routine', key: '临时值班', text: '今天值班', expiresAt });
  a.memory.execute({ op: 'update', id: created.item.id, kind: 'routine', key: '临时值班', text: '今天下午值班' }, { fromSettings: true });
  a.setNow(NOW + 7200000); assert.equal(new AssistantMemory(a).active().length, 0);
  a.memory.execute({ op: 'update', id: created.item.id, kind: 'routine', key: '临时值班', text: '每周值班', expiresAt: null }, { fromSettings: true });
  assert.equal(new AssistantMemory(a).active().length, 1);
});
test('无效日历日期明确拒绝，带until的24小时从所选终点回推', async t => {
  const a = rig(t); let range;
  a.collectQuery = async (_kind, found) => { range = found; return snapshot([]); };
  await assert.rejects(a.query.meetings({ date: '2026-02-30' }), /日期无效/);
  await assert.rejects(a.query.inbox({ since: '2026-02-30', until: '2026-03-02' }), /查询范围/);
  await a.query.inbox({ hours: 24, until: '2026-10-20 18:00' });
  assert.equal(range.start, Date.parse('2026-10-19T18:00:00+08:00'));
  assert.equal(range.end, Date.parse('2026-10-20T18:00:00+08:00'));
});
test('坏目录行不当作空成功，最近50条的封顶判断保留原始条数', async t => {
  const base = rig(t), svc = new CompanyAssistant({ dataDir: base.dir, noTimer: true, noTools: true, now: () => NOW });
  t.after(() => svc.close());
  const snap = { login: { ok: true, uid: 'owner-a' }, errors: [], messages: {} };
  svc.setConversationDirectory(snap, { conversation_info: Array.from({ length: 50 }, () => ({ group_id: '0', recent_conversation_type: 'CHAT_TYPE_P2P_MSG' })) });
  await svc.collectMessages(snap, svc.settings(), NOW, async () => { throw new Error('坏目录不能发历史请求'); });
  assert.equal(snap.scope.listed, 50); assert.equal(snap.scope.directoryInvalid, 50); assert.equal(snap.scope.listFull, true);
  base.collectQuery = async () => snap;
  const page = await base.query.inbox({}); assert.equal(page.total, 0); assert.match(page.text, /可能不全/); assert.match(page.text, /50 条会话目录记录无法识别/);
});
test('实际取数范围由Hub固定放在回答前，分页不重复，后一个任务不串前次范围', async t => {
  const a = rig(t); a.job.id = 'job-1'; a.query.beginTask('job-1');
  a.collectQuery = async () => snapshot([message(1), message(2)], { scope: { listed: 50, fetched: 50, listCap: 50, listFull: true } });
  const page = await a.query.inbox({ limit: 1 }); await a.query.inbox({ cursor: page.nextCursor, limit: 1 });
  const answer = a.query.finishAnswer('job-1', '模型遗漏覆盖说明');
  assert.ok(answer.text.startsWith('> **Hub 核实的查询范围**'));
  assert.match(answer.text, /从未发现的会话无法保证覆盖/); assert.equal((answer.text.match(/覆盖：/g) || []).length, 1);
  assert.equal(answer.coverage.length, 2); assert.ok(answer.text.endsWith('模型遗漏覆盖说明'));
  a.job.id = 'job-2'; a.query.beginTask('job-2');
  assert.deepEqual(a.query.finishAnswer('job-2', '普通回答'), { text: '普通回答', coverage: [] });
});
