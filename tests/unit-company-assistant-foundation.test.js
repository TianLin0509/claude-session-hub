'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { resolveNames, applyNames } = require('../core/company-assistant/identity');
const { runReadOnly } = require('../core/company-assistant/welink-ro');
const { readJson, collectMeetings, meetingArgs } = require('../core/company-assistant/queries');
const W = require('../core/company-assistant/welink');

const now = new Date(2026, 9, 19, 10).getTime();
const conv = { id: 'demo-group', name: '示例项目群', group: true };
const msg = (i, text = '正文') => ({ msgId: String(99000000000000000n + BigInt(i)), sender: 'demo-a', serverSendTime: now - (200 - i) * 1000, content: text, contentType: 'TEXT_MSG' });

test('完整原文：持久化和备用全文均保留末尾决策、换行及空格，内联预览明确指向全文', () => {
  const original = '第一段  保留空格\n' + '背景'.repeat(230) + '\n最终结论：周三交付。';
  const messages = D.messages({ chatInfo: [msg(1, original)] }, conv, 'me');
  assert.equal(messages[0].text, original);
  const snap = { conversations: [conv], messages: { [conv.id]: messages }, meetings: [], calendar: [], mails: [] };
  assert.ok(B.briefInputFile(snap, { now, day: D.dayKey(now) }).includes(original));
  assert.match(B.briefPrompt(snap, { now, day: D.dayKey(now) }), /全文|原文文件/);
});

test('翻页基于原始 100 条：空正文不能让第 2 页消失，非文字记录可回查', async () => {
  const service = Object.create(CompanyAssistant.prototype);
  const pages = [Array.from({ length: 100 }, (_, i) => msg(101 + i, i === 50 ? '' : '正文')), [msg(100, '上一页的决策')]];
  let calls = 0;
  const result = await service.conversationHistory(conv, null, now - 3600000, 'me', '', async () => ({ chatInfo: pages[calls++] || [] }));
  assert.equal(calls, 2);
  assert.equal(result.messages.length, 101);
  assert.ok(result.messages.some(m => m.text === '上一页的决策'));
  assert.equal(result.coverage.status, 'complete');
});

const jsonResponse = data => ({ code: 0, stdout: JSON.stringify(data), stderr: '' });
const user = (account, name) => ({ w3Account: account, personAccount: account, chineseName: name, workId: '00000001', employeeNumber: '12345678912345678' });
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ca-foundation-'));

test('批量姓名按账号而非返回顺序匹配；同名区分，工号不代替账号，缓存按登录身份隔离', async () => {
  const cacheDir = temp();
  let calls = 0;
  const run = async args => { calls += 1; assert.deepEqual(args, ['contact', 'detail', 'demo-a', 'demo-b']); return jsonResponse({ code: '0', users: [user('demo-b', '示例同事'), user('demo-a', '示例同事')] }); };
  const input = { run, cacheDir, identity: 'login-a', accounts: ['demo-a', 'demo-b', 'demo-a'], now };
  const resolved = await resolveNames(input);
  assert.equal(calls, 1);
  assert.equal(resolved.entries.get('demo-a').displayName, '示例同事（demo-a）');
  assert.equal(resolved.entries.get('demo-b').workId, '00000001');
  assert.equal(resolved.entries.get('demo-b').employeeNumber, undefined);
  const rows = applyNames([{ account: 'demo-a', sender: 'demo-a', mine: false }, { account: 'demo-b', mine: true }], resolved);
  assert.equal(rows[0].account, 'demo-a'); assert.equal(rows[1].sender, '我');
  await resolveNames(input); assert.equal(calls, 1, '未过期账号复用缓存');
  await resolveNames({ ...input, identity: 'login-b' }); assert.equal(calls, 2, '换账号不复用其他登录身份的资料');
});

test('字段冲突、缺键和错误大小写不猜姓名；无效账号拆批后不影响有效用户', async () => {
  const result = await resolveNames({ identity: 'me', accounts: ['demo-a', 'bad'], now,
    run: async args => args.length > 3 || args[2] === 'bad' ? jsonResponse({ code: '47111', users: [] }) : jsonResponse({ code: '0', users: [user('demo-a', '示例甲')] }) });
  assert.equal(result.entries.get('demo-a').name, '示例甲');
  assert.equal(result.entries.get('bad').status, 'not-found');
  assert.equal(result.stats.calls, 3);
  const ambiguous = await resolveNames({ identity: 'me', accounts: ['demo-a', 'demo-b', 'demo-c'], now,
    run: async () => jsonResponse({ code: '0', users: [
      { w3Account: 'demo-a', personAccount: 'demo-b', chineseName: '不能误配' },
      { w3account: 'demo-c', employeeNumber: 'demo-c', chineseName: '不能猜字段' },
    ] }) });
  assert.equal(ambiguous.stats.resolved, 0);
  assert.ok([...ambiguous.entries.values()].every(e => !e.name));
});

test('姓名超时不吞消息；负缓存避免反复查，预算耗尽仍明确标记未完成', async () => {
  const cacheDir = temp(); let calls = 0;
  const input = { identity: 'me', accounts: ['demo-a'], cacheDir, now, run: async () => { calls += 1; throw new Error('timeout'); } };
  const failed = await resolveNames(input);
  assert.equal(applyNames([{ account: 'demo-a', text: '保留正文' }], failed)[0].text, '保留正文');
  assert.equal(failed.entries.get('demo-a').status, 'error');
  await resolveNames(input); assert.equal(calls, 1);
  await resolveNames({ ...input, now: now + 11 * 60000 }); assert.equal(calls, 2);
  const pending = await resolveNames({ ...input, cacheDir: null, maxCalls: 0 });
  assert.equal(pending.entries.get('demo-a').status, 'pending');
  const noLogin = await resolveNames({ ...input, cacheDir: null, identity: null });
  assert.equal(noLogin.entries.get('demo-a').status, 'unresolved'); assert.equal(calls, 2);
});

test('只读包装补姓名但保留原始 sender、长消息编号和 stderr；与自动采集共享缓存', async () => {
  const cacheDir = temp(), seen = [];
  const run = async args => {
    seen.push(args);
    if (args[0] === 'auth') return { code: 0, stdout: 'UID: login-a\nToken: VALID', stderr: '' };
    if (args[0] === 'contact') return jsonResponse({ code: '0', users: [user('demo-a', '示例甲')] });
    return { code: 0, stdout: '{"chatInfo":[{"msgId":99000000000000001,"sender":"demo-a","content":"完整正文","serverSendTime":1792000000000}],"maxMsgId":99000000000000001,"resultCode":"0"}', stderr: 'CLI 提示' };
  };
  const args = ['im', 'query-history-message', '--group-id', 'demo-group'];
  const result = await runReadOnly(args, { run, cacheDir, cli: 'standin' });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.chatInfo[0].sender, 'demo-a'); assert.equal(parsed.chatInfo[0].senderName, '示例甲');
  assert.equal(parsed.chatInfo[0].msgId, '99000000000000001'); assert.equal(parsed.maxMsgId, '99000000000000001');
  assert.equal(W.groupMessages(result.stdout)[0].sender, 'demo-a', '手机本人识别仍看账号');
  assert.equal(result.stderr, 'CLI 提示');
  const shared = await resolveNames({ run, cacheDir, identity: 'login-a', accounts: ['demo-a'] });
  assert.equal(shared.entries.get('demo-a').name, '示例甲'); assert.equal(seen.filter(a => a[0] === 'contact').length, 1);
  const error = { code: 106, stdout: '{"chatInfo":[]}', stderr: 'missing' };
  assert.deepEqual(await runReadOnly(args, { run: async () => error }), error);
});

test('查询成功判定：退出码、业务码分别检查，参数错误不盲目追加 format 重试', async () => {
  let calls = 0;
  await assert.rejects(readJson(async () => { calls += 1; return { code: 106, stdout: '{}', stderr: '--page is required' }; }, ['meeting', 'query-list']), /page is required/);
  assert.equal(calls, 1);
  await assert.rejects(readJson(async () => jsonResponse({ resultCode: '123', resultContext: '权限不足' }), ['im', 'query-history-message']), /权限不足/);
  assert.equal((await readJson(async () => jsonResponse({ code: 200, data: { data: [] } }), ['meeting', 'query-list'])).code, 200);
  await assert.rejects(readJson(async () => jsonResponse({ code: '47111', users: [] }), ['contact', 'detail']), /47111/);
});

test('部分分页失败保留已有内容，下次补齐旧页；重复游标有界停止并标部分结果', async () => {
  const service = Object.create(CompanyAssistant.prototype);
  const page = Array.from({ length: 100 }, (_, i) => msg(101 + i));
  let calls = 0;
  const first = await service.conversationHistory(conv, null, now - 3600000, 'me', '', async () => ++calls === 1 ? { chatInfo: page } : null);
  assert.equal(first.messages.length, 100); assert.equal(first.coverage.status, 'partial'); assert.equal(first.coverage.failedPage, 2);
  const queried = [];
  const second = await service.conversationHistory(conv, first.cache, now - 3600000, 'me', '', async (_label, args) => { queried.push(args); return { chatInfo: queried.length === 1 ? page : [msg(100)] }; });
  assert.equal(second.messages.length, 101); assert.equal(second.coverage.status, 'complete');
  assert.ok(!queried[0].includes('--query-direction'), '不只向前增量而漏掉旧页');
  const repeated = await service.conversationHistory(conv, null, now - 3600000, 'me', '', async () => ({ chatInfo: page }));
  assert.equal(repeated.coverage.pages, 2); assert.equal(repeated.coverage.reason, 'repeated-cursor');
});

test('老缓存重新取全文；正文为空的附件及原始内容都保留', async () => {
  const service = Object.create(CompanyAssistant.prototype), long = '内容'.repeat(300) + '结尾';
  const old = { since: now - 3600000, newest: msg(1).msgId, messages: [{ key: msg(1).msgId, at: now - 199000, text: '截断…' }] };
  const args = [];
  const result = await service.conversationHistory(conv, old, now - 3600000, 'me', '', async (_label, a) => { args.push(a); return { chatInfo: [msg(1, long), { ...msg(2, ''), content: { fileName: 'demo.pdf', fileId: 'demo' }, contentType: 'FILE_MSG' }] }; });
  assert.ok(!args[0].includes('--message-id')); assert.equal(result.messages[0].text, long);
  assert.equal(result.messages[1].content.fileName, 'demo.pdf'); assert.match(result.messages[1].preview, /FILE_MSG/);
  assert.equal(result.cache.version, 2); assert.equal(result.coverage.incompleteText, 0);
});

test('出处查看给出完整原文和前后各两条，不泄入其他会话；过期/无效出处有明确说明', () => {
  const service = Object.create(CompanyAssistant.prototype); service.now = () => now;
  const rows = D.messages({ chatInfo: Array.from({ length: 7 }, (_, i) => msg(i, '原文'.repeat(300))) }, conv, 'me');
  service.snapshot = () => ({ at: now, messages: { [conv.id]: rows }, meetings: [], calendar: [], mails: [], scope: { conversations: [{ id: conv.id, status: 'complete' }] } });
  const source = rows[3].sourceId;
  const got = service.sourceContext(source);
  assert.equal(got.context.length, 5); assert.equal(got.context[2].sourceId, source); assert.equal(got.entry.item.text.length, 600);
  assert.throws(() => service.sourceContext(source, '../../wrong'), /参数无效/);
  assert.throws(() => service.sourceContext('msg:missing:1'), /没有这条原文/);
});

test('会议取数传齐全部参数，用毫秒时间窗并按 total 分页；缺参/部分失败不会变成没有会议', async () => {
  const seen = [];
  const sample = id => ({ meetingId: id, subject: '示例会议', meetingStartTime: now + id * 60000, meetingEndTime: now + (id + 30) * 60000 });
  const got = await collectMeetings(async (_label, args) => {
    seen.push(args); const page = Number(args[args.indexOf('--page') + 1]);
    return { code: 200, data: { data: page === 1 ? [sample(1), sample(2)] : [sample(3)], total: 3 } };
  }, now, { size: 2 });
  assert.equal(got.meetings.length, 3); assert.equal(got.coverage.status, 'complete'); assert.equal(seen.length, 2);
  for (const args of seen) {
    for (const key of ['--page', '--size', '--meeting-start-time', '--meeting-end-time', '--type', '--meeting-sort']) assert.ok(args.includes(key));
    const start = args[args.indexOf('--meeting-start-time') + 1], end = args[args.indexOf('--meeting-end-time') + 1];
    assert.match(start, /^\d{13}$/); assert.match(end, /^\d{13}$/); assert.ok(Number(start) <= now && Number(end) > now);
  }
  let count = 0;
  const partial = await collectMeetings(async () => ++count === 1 ? { data: { data: [sample(1), sample(2)], total: 3 } } : null, now, { size: 2 });
  assert.equal(partial.meetings.length, 2); assert.equal(partial.coverage.status, 'partial');
  const empty = await collectMeetings(async () => ({ data: { data: [], total: 0 } }), now);
  assert.equal(empty.coverage.status, 'complete');
  const failed = await collectMeetings(async () => null, now);
  assert.equal(failed.coverage.status, 'failed');
});

test('升级查询说明包含完整会议命令，保留现有助理会话且包装指向统一姓名缓存', async () => {
  const dataDir = temp(), svc = new CompanyAssistant({ dataDir, noTimer: true, noTools: true, now: () => now, getSession: id => ({ id }) });
  svc.saveState({ sessionId: 'existing', toolsVersion: 1, primed: 'existing' });
  assert.equal(await svc.ensureSession(), 'existing');
  const doc = fs.readFileSync(path.join(svc.workspace, 'CLAUDE.md'), 'utf8');
  assert.ok(doc.includes(meetingArgs(now).join(' ')));
  assert.ok(!doc.includes('meeting query-list --type 1；'));
  assert.ok(fs.readFileSync(path.join(svc.workspace, 'welink-ro.cmd'), 'utf8').includes('CLAUDE_HUB_ASSISTANT_DIR=' + svc.dir));
});
