'use strict';
// 公司助理的手机对话（2026-10-18）：只往选定的群发、只认本人发的、Hub 自己的话不当指令、旧消息不执行；
// 助理的会话工具（列出、发话、盯着、按键）只给助理会话用；盯着的会话答完或卡住推到群里。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const W = require('../core/company-assistant/welink');
const { CompanyAssistant, TOOLS_VERSION } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { PREFIX, PHONE_NOTE, plain, chunks } = require('../core/company-assistant/phone');

const STANDIN = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'company-phone-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = 3000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(20); } throw new Error('timeout: ' + label); };

function rig({ idle = 9999 } = {}) {
  const dir = tmp(), log = path.join(dir, 'calls.log'), stateFile = path.join(dir, 'welink-state');
  const env = { ...process.env, WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: stateFile };
  const sessions = new Map(), finals = new Map(), sent = [], keys = [], busy = new Set();
  const say = (text, extra = []) => { const r = spawnSync(process.execPath, [STANDIN, '__test', 'say', '--text', text, ...extra], { env, encoding: 'utf8' }); assert.equal(r.status, 0, r.stderr); };
  const groupFile = path.join(dir, 'welink-phone-group.jsonl');
  const group = () => (fs.existsSync(groupFile) ? fs.readFileSync(groupFile, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : []);
  const deps = {
    dataDir: dir, noTimer: true, nodeExecutable: process.execPath,
    welinkRun: (args, opts) => W.run(args, { ...opts, cli: STANDIN, env }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, title: opts.title, ...opts, status: 'idle' }); finals.set(opts.id, []); return { id: opts.id, cwd: opts.cwd || dir }; },
    sendPrompt: async (id, text) => { sent.push({ id, text }); return { ok: true }; },
    getSession: id => sessions.get(id) || null,
    getSessionMetadata: id => sessions.get(id) || null,
    getAllSessions: () => [...sessions.values()],
    listKnownSessions: () => [],
    resumeSession: async () => null,
    isAgentTurnActive: id => busy.has(id),
    readFinals: meta => finals.get(meta.id) || [],
    readTerminalScreen: async () => null,
    sessionKeys: (id, data) => keys.push({ id, data }),
    systemIdleSeconds: () => idle,
  };
  const svc = new CompanyAssistant({ ...deps, bus: new NoticeBus() });
  return { dir, log, env, sessions, finals, sent, keys, busy, say, group, svc, calls: () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l)) };
}

test('发消息只放行选定的群：别的群、没传群号、助理会话的只读包装都发不出去', () => {
  const send = ['im', 'send-to-group', '--group-id', 'g-phone', '--text', '第一行\n第二行'];
  assert.deepEqual(W.checkArgs(send, { sendGroup: 'g-phone' }), send, '选定的群可以发，文字可以换行');
  assert.throws(() => W.checkArgs(send), e => e.code === 'WELINK_NOT_ALLOWED');
  assert.throws(() => W.checkArgs(send, { sendGroup: 'g-100' }), e => e.code === 'WELINK_NOT_ALLOWED');
  assert.throws(() => W.checkArgs(['im', 'send-to-group', '--group-id', 'g-phone', '--image', 'a.png'], { sendGroup: 'g-phone' }), /拒绝/);
  assert.throws(() => W.checkArgs(['im', 'send-to-user', '--receiver', 'x', '--text', 'hi'], { sendGroup: 'g-phone' }), /拒绝/);
  assert.throws(() => W.checkArgs(['im', 'send-to-group', '--group-id', 'g-phone', '--text', 'a', '--group-id', 'g-100'], { sendGroup: 'g-phone' }), /拒绝/);
  const dir = tmp(), log = path.join(dir, 'calls.log');
  const ro = spawnSync(process.execPath, [path.join(__dirname, '..', 'core', 'company-assistant', 'welink-ro.js'), 'im', 'send-to-group', '--group-id', 'g-phone', '--text', 'hi'],
    { env: { ...process.env, CLAUDE_HUB_WELINK_CLI: STANDIN, WELINK_STANDIN_LOG: log }, encoding: 'utf8' });
  assert.equal(ro.status, 2);
  assert.ok(!fs.existsSync(log), '只读包装在调用 welink-cli 之前就拒绝了');
});

test('群消息解析：长整数 msgId 不丢精度、按大小排序；群成员取账号和名字', () => {
  const list = W.groupMessages('{"data":{"msgList":[{"msgId":7300000000000000014,"sender":"u1","content":"b","contentType":"TEXT_MSG","serverSendTime":1792000000000},{"msgId":7300000000000000007,"sender":"u2","content":"a"}]}}');
  assert.deepEqual(list.map(m => m.id), ['7300000000000000007', '7300000000000000014']);
  assert.equal(list[1].at, 1792000000000);
  assert.equal(W.groupMessages('不是 JSON'), null);
  assert.deepEqual(W.groupMessages('{"msgTotalCount":0}'), []);
  assert.deepEqual(W.groupMembers('{"data":{"memberList":[{"account":"a","name":"甲"},{"account":"b"}]}}'), [{ account: 'a', name: '甲' }, { account: 'b', name: 'b' }]);
});

test('回答发到手机前去掉 Markdown 符号，长回答按段落切开', () => {
  assert.equal(plain('## 结论\n**两个**会话在跑，见 `a.md`'), '结论\n两个会话在跑，见 a.md');
  const parts = chunks(Array.from({ length: 30 }, (_, i) => `第 ${i} 段` + '字'.repeat(100)).join('\n'), 1500);
  assert.ok(parts.length >= 2 && parts.every(p => p.length <= 1500));
  assert.equal(parts.join('\n').split('\n').length, 30, '段落一段不少');
});

test('手机对话全流程：接通 → 只认本人的新消息 → 交给助理 → 回答发回群里；Hub 自己的话、小微助手、旧消息都不当指令', async () => {
  const r = rig();
  r.svc.start();
  await r.svc.refresh({ force: true });
  r.say('接通之前说的话');
  const set = await r.svc.setPhone({ enabled: true, groupId: 'g-phone', groupName: '助理 CodeAgent' });
  assert.equal(set.welcome, true);
  assert.ok(r.group().at(-1).content.startsWith(PREFIX + '手机对话已接通'), '接通时往群里发一句');
  await r.svc.phone.poll();
  assert.equal(r.svc.chat().length, 0, '接通之前的话、Hub 自己的话都不处理');
  r.say('小微助手的自动回复', ['--sender', 'xiaowei_bot']);
  // 「过期」单独验证：把开启时间往前拨 10 分钟，5 分钟前发的那条晚于开启、但超过 120 秒
  const s = r.svc.settings(); r.svc.write('settings.json', { ...s, phone: { ...s.phone, since: Date.now() - 10 * 60000 } });
  r.say('两分钟前的旧消息', ['--at', String(Date.now() - 5 * 60000)]);
  r.say('现在有哪些会话在跑？');
  await r.svc.phone.poll();
  assert.deepEqual(r.svc.chat().map(c => [c.q, c.via]), [['现在有哪些会话在跑？', 'phone']]);
  assert.ok(r.svc.phone.status().log.some(x => x.kind === 'stale'), '旧消息记在往来里，标「过期没执行」');
  await until(() => r.sent.length === 1, 'prompt sent');
  const sid = r.svc.state().sessionId;
  assert.ok(r.sent[0].text.includes(PHONE_NOTE) && r.sent[0].text.endsWith('现在有哪些会话在跑？'), '告诉助理这句来自手机');
  assert.match(r.sent[0].text, /hub_sessions/, '第一句带着说明：管会话用 hub_sessions 工具');
  assert.equal(r.svc.state().toolsVersion, TOOLS_VERSION);
  r.finals.get(sid).push({ id: 'f1', text: '**结论**：现在没有会话在跑。' });
  await r.svc.collectJob();
  await r.svc.phone.outbox;
  assert.equal(r.group().at(-1).content, PREFIX + '结论：现在没有会话在跑。');
  await r.svc.phone.poll();
  assert.equal(r.svc.chat().length, 1, 'Hub 发回去的回答不会被当成新问题');
  const writes = r.calls().filter(a => !W.READ_ONLY[a[0]]?.includes(a[1]) && !W.SETUP[a[0]]?.includes(a[1]) && a[0] !== '__test');
  assert.ok(writes.length >= 2 && writes.every(a => a[1] === 'send-to-group' && a[3] === 'g-phone'), '写命令只有往选定的群发消息');
  r.svc.close();
});

test('关掉手机对话后不再收发；换群时只认换群之后的消息', async () => {
  const r = rig();
  r.svc.start();
  await r.svc.setPhone({ enabled: true, groupId: 'g-phone' });
  await r.svc.setPhone({ enabled: false });
  const real = () => r.calls().filter(a => a[0] !== '__test').length, before = real();
  r.say('关掉以后说的');
  await r.svc.phone.poll();
  await r.svc.phone.watchTick();
  assert.equal(real(), before, '关掉后一次 welink-cli 都不调');
  assert.equal(r.svc.chat().length, 0);
  await new Promise(res => setTimeout(res, 5));
  await r.svc.setPhone({ enabled: true, groupId: 'g-phone' });
  await r.svc.phone.poll();
  assert.equal(r.svc.chat().length, 0, '重新开启后，关掉期间发的不补执行');
  r.say('重新开启以后说的');
  await r.svc.phone.poll();
  assert.deepEqual(r.svc.chat().map(c => c.q), ['重新开启以后说的']);
  r.svc.close();
});

test('会话工具：只有助理会话能调；不管特殊会话；发话后自动盯着，答完推到手机；运行中不发、卡住时按键', async () => {
  const r = rig();
  r.svc.start();
  await r.svc.toolsReady;
  await r.svc.setPhone({ enabled: true, groupId: 'g-phone' });
  await r.svc.ensureSession();
  const me = r.svc.state().sessionId;
  r.sessions.set('s-work', { id: 's-work', kind: 'codeagent', title: '信道仿真', cwd: 'D:/work', status: 'idle' }); r.finals.set('s-work', [{ id: 'old', text: '上一轮的回答' }]);
  r.sessions.set('s-bridge', { id: 's-bridge', kind: 'codeagent', title: '家里联动', purpose: 'company-bridge', status: 'idle' });
  r.sessions.set('s-group', { id: 's-group', kind: 'codeagent', title: '群聊成员', meetingId: 'm1', status: 'idle' });
  const call = (name, args, caller = me) => r.svc.tools.invoke({ name, arguments: args, callerSessionId: caller });
  await assert.rejects(call('list_sessions', {}, 'someone-else'), /只有公司助理会话/);
  const list = await call('list_sessions', {});
  assert.deepEqual(list.sessions.map(s => s.id), ['s-work'], '助理自己、家里联动、群聊成员都不在列表里');
  await assert.rejects(call('send_session', { sessionId: 's-bridge', text: 'x' }), /找不到这个会话/);
  r.busy.add('s-work');
  await assert.rejects(call('send_session', { sessionId: 's-work', text: '接着做' }), /正在运行/);
  r.busy.delete('s-work');
  const res = await call('send_session', { sessionId: 's-work', text: '接着做下一步' });
  assert.equal(res.watched, true);
  assert.deepEqual(r.sent.at(-1), { id: 's-work', text: '接着做下一步' });
  await r.svc.phone.watchTick();
  assert.ok(!r.group().some(m => m.content.includes('答完了')), '还是旧回答时不推');
  r.finals.get('s-work').push({ id: 'new', text: '## 完成\n仿真跑完了，吞吐提升 3%。' });
  await r.svc.phone.watchTick(); await r.svc.phone.outbox;
  assert.equal(r.group().at(-1).content, '【助理】「信道仿真」这一轮答完了：\n完成\n仿真跑完了，吞吐提升 3%。', '推送保留换行，手机上分段好读');
  assert.equal(r.svc.phone.status().watching.length, 0, '推过一次就不再盯');
  // 卡住：按键只在卡住时放行
  await assert.rejects(call('press_keys', { sessionId: 's-work', keys: ['1'] }), /没有卡在/);
  Object.assign(r.sessions.get('s-work'), { needsUserInput: true, waitingText: '要覆盖文件吗？1. 是 2. 否' }); r.busy.add('s-work');
  await assert.rejects(call('send_session', { sessionId: 's-work', text: 'x' }), /press_keys/);
  await assert.rejects(call('press_keys', { sessionId: 's-work', keys: ['rm'] }), /按键只能是/);
  const pressed = await call('press_keys', { sessionId: 's-work', keys: ['2', 'enter'] });
  assert.deepEqual(r.keys.map(k => k.data), ['2', '\r']);
  assert.deepEqual(pressed.pressed, ['2', 'enter']);
  r.svc.close();
});

test('卡住推送：盯着的会话卡住一定推；其他会话卡住只在电脑前没人时推，同一次卡住只推一次', async () => {
  for (const [idle, expect] of [[30, 0], [600, 1]]) {
    const r = rig({ idle });
    r.svc.start();
    await r.svc.setPhone({ enabled: true, groupId: 'g-phone' });
    r.sessions.set('s-x', { id: 's-x', kind: 'codeagent', title: '写周报', status: 'running', needsUserInput: true, waitingText: '选择格式：1. Word 2. Markdown' }); r.finals.set('s-x', []);
    await r.svc.phone.watchTick(); await r.svc.phone.watchTick(); await r.svc.phone.outbox;
    assert.equal(r.group().filter(m => m.content.includes('「写周报」卡住了')).length, expect, `键鼠 ${idle} 秒没动`);
    r.svc.close();
  }
  const r = rig({ idle: 10 });
  r.svc.start();
  await r.svc.setPhone({ enabled: true, groupId: 'g-phone' });
  r.sessions.set('s-y', { id: 's-y', kind: 'codeagent', title: '跑仿真', status: 'idle' }); r.finals.set('s-y', []);
  r.svc.phone.watch('s-y', { title: '跑仿真' });
  Object.assign(r.sessions.get('s-y'), { status: 'running', needsUserInput: true, waitingText: '允许运行 python 吗？' });
  await r.svc.phone.watchTick(); await r.svc.phone.outbox;
  assert.match(r.group().at(-1).content, /「跑仿真」卡住了，在等你：\n允许运行 python 吗？/, '盯着的会话：人在电脑前也推');
  r.svc.close();
});

test('助理会话挂工具：只给 purpose=company-assistant；旧版本的助理会话换新的', async () => {
  const r = rig();
  r.svc.start();
  await r.svc.toolsReady;
  assert.equal(r.svc.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-forum', id: 'a' } }), null);
  assert.equal(r.svc.sessionPlan({ kind: 'codeagent', opts: { id: 'a' } }), null);
  const plan = r.svc.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-assistant', id: 'abc' } });
  assert.equal(plan.mcp.name, 'hub_sessions');
  assert.equal(plan.mcp.env.HUB_COMPANY_ASSISTANT_SESSION_ID, 'abc');
  r.svc.saveState({ sessionId: 'old-session', toolsVersion: undefined });
  r.sessions.set('old-session', { id: 'old-session', kind: 'codeagent', purpose: 'company-assistant', status: 'idle' });
  const id = await r.svc.ensureSession();
  assert.notEqual(id, 'old-session', '旧会话没挂工具，换一个');
  assert.equal(await r.svc.ensureSession(), id, '新会话之后一直用');
  r.svc.close();
});

test('MCP：列出 7 个工具；带对会话编号能调通，编号不对被拒', async () => {
  const r = rig();
  r.svc.start();
  await r.svc.toolsReady;
  await r.svc.ensureSession();
  const me = r.svc.state().sessionId;
  r.sessions.set('s-work', { id: 's-work', kind: 'codeagent', title: '信道仿真', status: 'idle' }); r.finals.set('s-work', []);
  const rpc = async sessionId => {
    const entry = r.svc.tools.mcpEntry(sessionId);
    const child = spawn(entry.command, entry.args, { env: { ...process.env, ...entry.env }, stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = ''; const replies = new Map();
    child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); const m = JSON.parse(line); replies.set(m.id, m); } });
    const ask = async (id, method, params) => { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); await until(() => replies.has(id), method, 5000); return replies.get(id); };
    try {
      const tools = await ask(1, 'tools/list', {});
      const listed = await ask(2, 'tools/call', { name: 'list_sessions', arguments: {} });
      return { tools: tools.result.tools.map(t => t.name), listed: listed.result };
    } finally { child.kill(); }
  };
  const ok = await rpc(me);
  assert.deepEqual(ok.tools, ['list_sessions', 'read_session', 'send_session', 'create_session', 'watch_session', 'press_keys', 'stop_session']);
  assert.equal(ok.listed.isError, false);
  assert.deepEqual(JSON.parse(ok.listed.content[0].text).sessions.map(s => s.title), ['信道仿真']);
  const bad = await rpc('not-the-assistant');
  assert.equal(bad.listed.isError, true);
  assert.match(bad.listed.content[0].text, /只有公司助理会话/);
  r.svc.close();
});
