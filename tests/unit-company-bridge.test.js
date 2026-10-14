'use strict';
// 家里联动：加密、配对换钥、提问 → 公司开 CodeAgent 会话 → 回执 → 送回家里会话 → 追问进同一会话；
// 成段源码先请改写再兜底删除；放行页（代理返回网页）时发件箱保留、放行后补发；MCP 挂载规则。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridgeCrypto = require('../core/company-bridge/crypto');
const { CompanyBridge, bigCodeBlocks, stripBigBlocks } = require('../core/company-bridge/company');
const { HomeBridge } = require('../core/company-bridge/home');

const BASE = 'https://relay.example.test/drop/tok/api';

// 内存版通道服务：语义与 relay_server.py 的 /bridge/<通道>/msg 一致。gate=true 时像公司代理一样返回网页。
function fakeRelay() {
  const relay = { channels: new Map(), gate: false, offline: false, posts: 0 };
  relay.fetch = async (url, init = {}) => {
    if (relay.offline) throw new Error('ECONNRESET');
    const page = body => ({ ok: true, status: 200, type: 'basic', headers: new Map([['content-type', 'text/html']]), text: async () => body });
    if (relay.gate) return page('<html>请点击允许访问</html>');
    const u = new URL(url);
    const m = u.pathname.match(/\/bridge\/([a-f0-9]{32})\/msg$/);
    const json = (status, body) => ({ ok: status < 400, status, type: 'basic', headers: new Map([['content-type', 'application/json']]), text: async () => JSON.stringify(body) });
    if (!m) return json(404, { ok: false, error: { code: 'not_found' } });
    const ch = relay.channels.get(m[1]) || { next: 1, rows: [], seen: {} };
    relay.channels.set(m[1], ch);
    if ((init.method || 'GET') === 'POST') {
      relay.posts += 1;
      const body = JSON.parse(init.body);
      const dup = ch.rows.find(r => r.mid === body.mid);
      if (dup) return json(200, { ok: true, seq: dup.seq, duplicate: true });
      const row = { seq: ch.next++, to: body.to, mid: body.mid, blob: body.blob };
      ch.rows.push(row);
      return json(200, { ok: true, seq: row.seq, duplicate: false });
    }
    const to = u.searchParams.get('to'), after = Number(u.searchParams.get('after')), who = u.searchParams.get('who');
    if (who) ch.seen[who] = new Date(relay.now ? relay.now() : Date.now()).toISOString();
    return json(200, { ok: true, messages: ch.rows.filter(r => r.to === to && r.seq > after).map(r => ({ seq: r.seq, blob: r.blob })), seen: ch.seen, more: false });
  };
  // Map 当 headers 用：补一个 get
  return relay;
}
Map.prototype.get = Map.prototype.get; // headers.get 直接用 Map#get

function sessions() {
  const s = { map: new Map(), busy: new Set(), finals: new Map(), sent: [], created: [], resumed: [], stored: new Map() };
  s.deps = {
    createSession: async (kind, opts) => { const x = { id: opts.id, kind, status: 'idle', title: opts.title, opts }; s.map.set(opts.id, x); s.created.push({ kind, opts }); return x; },
    sendPrompt: async (id, text) => { if (!s.map.has(id)) return { ok: false, error: 'closed' }; s.sent.push({ id, text }); return { ok: true }; },
    getSession: id => s.map.get(id) || null,
    getSessionMetadata: id => s.map.get(id) || s.stored.get(id) || null,
    resumeSession: async id => { const m = s.stored.get(id); if (m) { s.map.set(id, { ...m, status: 'idle' }); s.resumed.push(id); } },
    isAgentTurnActive: id => s.busy.has(id),
    readFinals: meta => s.finals.get(meta.id) || [],
  };
  s.answer = (id, text) => { const list = s.finals.get(id) || []; list.push({ id: 'f' + (list.length + 1), text }); s.finals.set(id, list); };
  return s;
}

function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bridge-'));
  t.after(() => { try { home.close(); company.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const relay = fakeRelay();
  const clock = { now: 1_800_000_000_000 };
  relay.now = () => clock.now;
  const hs = sessions(), cs = sessions();
  const notices = [];
  const home = new HomeBridge({ dataDir: path.join(root, 'home'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, relayBaseUrl: () => BASE.replace(/\/api$/, ''),
    onNotify: n => notices.push(n), ...hs.deps });
  const company = new CompanyBridge({ dataDir: path.join(root, 'company'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, fallbackCwd: root,
    isDirectory: () => true, onNotify: n => notices.push(n), ...cs.deps });
  return { root, relay, clock, hs, cs, home, company, notices };
}

async function pair(r) {
  const { code } = r.home.createPairing();
  await r.company.pair(code);
  await r.home.checkNow();
  await r.company.checkNow();
  await r.home.checkNow();
  assert.equal(r.home.status().link.state, 'paired');
  assert.equal(r.company.status().link.state, 'paired');
}

test('加密：同钥能解、换钥或换收件方都解不开；配对码往返', () => {
  const secret = bridgeCrypto.newSecret(), link = bridgeCrypto.derive(secret);
  const blob = bridgeCrypto.seal(link, 'company', { type: 'ask', question: '你好' });
  assert.equal(bridgeCrypto.open(link, 'company', blob).question, '你好');
  assert.throws(() => bridgeCrypto.open(link, 'home', blob));
  assert.throws(() => bridgeCrypto.open(bridgeCrypto.derive(bridgeCrypto.newSecret()), 'company', blob));
  assert.match(link.channel, /^[a-f0-9]{32}$/);
  const code = bridgeCrypto.makePairingCode(BASE, secret);
  assert.deepEqual(bridgeCrypto.parsePairingCode('请粘贴：' + code + ' 谢谢'), { baseUrl: BASE, secret });
  assert.throws(() => bridgeCrypto.makePairingCode('http://evil.example/api', secret), /https/);
  assert.throws(() => bridgeCrypto.parsePairingCode('AIHUB-LINK-1.abc'), /配对码/);
});

test('配对：公司换钥后两端只用新通道，旧配对码作废', async t => {
  const r = rig(t);
  const { code } = r.home.createPairing();
  const initial = bridgeCrypto.parsePairingCode(code).secret;
  await pair(r);
  const homeSecret = r.home.link.config().secret, companySecret = r.company.link.config().secret;
  assert.equal(homeSecret, companySecret);
  assert.notEqual(homeSecret, initial);
  assert.ok(r.notices.some(n => /已和公司接通/.test(n.title)) && r.notices.some(n => /已和家里接通/.test(n.title)));
  assert.ok(r.home.status().peer.companyOnline);
});

test('完整往返：提问 → 公司新开 CodeAgent 会话 → 回执送回提问会话 → 追问进同一会话', async t => {
  const r = rig(t);
  await pair(r);
  r.company.setSettings({ codeRoots: 'D:/code/l2\nD:/code/common', model: 'GLM-5.2-WX-Auto' });
  const asker = { id: 'home-s1', kind: 'codex', status: 'idle', title: 'SuperRAN PF 调度' };
  r.hs.map.set(asker.id, asker);
  const asked = await r.home.invoke({ name: 'ask_company', callerSessionId: 'home-s1', arguments: { question: '## 目的\n对齐 PF 调度\n## 问题\n1. 遗忘因子怎么取？', title: 'PF 遗忘因子' } });
  assert.match(asked.thread, /^Q-\d{4}-01$/);
  assert.match(asked.next, /结束本轮/);

  await r.company.checkNow();
  assert.equal(r.cs.created.length, 1);
  const created = r.cs.created[0];
  assert.equal(created.kind, 'codeagent');
  assert.equal(created.opts.cwd, 'D:/code/l2');
  assert.deepEqual(created.opts.addDirs, ['D:/code/common']);
  assert.equal(created.opts.model, 'GLM-5.2-WX-Auto');
  assert.equal(created.opts.purpose, 'company-bridge');
  const companySession = created.opts.id;
  assert.match(r.cs.sent[0].text, /只读代码/);
  assert.match(r.cs.sent[0].text, /D:\/code\/l2/);
  assert.match(r.cs.sent[0].text, /遗忘因子/);

  // 家里先收到「公司在读代码」
  await r.home.checkNow();
  assert.equal(r.home.thread(asked.thread).rounds[0].status, 'running');

  // CodeAgent 还在忙：不收
  r.cs.busy.add(companySession); r.cs.answer(companySession, '半截');
  await r.company.checkNow();
  assert.equal(r.company.thread(asked.thread).state, 'running');
  r.cs.busy.delete(companySession);
  r.cs.finals.set(companySession, [{ id: 'f1', text: '## 结论\n每 TTI 更新，系数 0.01。\n把握程度：高' }]);
  await r.company.checkNow();
  assert.equal(r.company.thread(asked.thread).state, 'replied');

  // 家里：提问会话在忙就等，停下再送
  r.hs.busy.add('home-s1');
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 0);
  r.hs.busy.delete('home-s1');
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
  assert.equal(r.hs.sent[0].id, 'home-s1');
  assert.match(r.hs.sent[0].text, new RegExp(`【公司回执 ${asked.thread} · 第 1 轮】`));
  assert.match(r.hs.sent[0].text, /followup_company/);
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1, '同一份回执只送一次');

  // 别的会话不能追问这个编号
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'other', arguments: { thread: asked.thread, question: '再看看' } }), /另一个会话/);
  // 追问：进同一个公司会话，不新开
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread, question: '初值怎么给？请读初始化部分' } });
  await r.company.checkNow();
  assert.equal(r.cs.created.length, 1);
  assert.equal(r.cs.sent.at(-1).id, companySession);
  assert.match(r.cs.sent.at(-1).text, /第 2 轮/);
  // 第 2 轮没回执前不能再追问
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread, question: '再看看初始化' } }), /还没回执/);
  r.cs.answer(companySession, '初值按宽带 CQI 估算。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, /第 2 轮/);
  assert.match(r.hs.sent.at(-1).text, /宽带 CQI/);
  const view = await r.home.invoke({ name: 'company_thread', callerSessionId: 'home-s1', arguments: {} });
  assert.equal(view.threads[0].rounds.length, 2);
});

test('成段源码：先请 CodeAgent 改写，改写后仍有就删掉那几段再发', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'claude', status: 'idle' });
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '请说明重传合并的逻辑' } });
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  const code = '```c\n' + Array.from({ length: 20 }, (_, i) => `x${i} = y${i};`).join('\n') + '\n```';
  r.cs.answer(sid, '结论如下\n' + code);
  await r.company.checkNow();
  assert.match(r.cs.sent.at(-1).text, /重写/);
  assert.equal(r.cs.sent.at(-1).id, sid);
  r.cs.answer(sid, '改写稿\n' + code + '\n结尾');
  await r.company.checkNow();
  await r.home.checkNow();
  const reply = r.home.thread(thread).rounds[0].reply;
  assert.ok(!reply.includes('x10 = y10'));
  assert.match(reply, /此处原有 20 行代码/);
  assert.equal(bigCodeBlocks('```\na\nb\n```').length, 0);
  assert.match(stripBigBlocks('前\n' + code), /按规则不回传/);
});

test('放行页：公司代理返回网页时记为待放行、回执留在发件箱，放行后补发', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '请说明 HARQ 进程数怎么定' } });
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.answer(sid, '8 个进程。把握程度：高');
  r.relay.gate = true;
  await r.company.checkNow();
  const st = r.company.status();
  assert.equal(st.net.gate && st.net.lastError.code, 'gate');
  assert.ok(st.net.gate.url.endsWith('/drop/tok/'));
  assert.ok(st.link.outbox >= 1);
  r.relay.gate = false;
  await r.company.checkNow();
  assert.equal(r.company.status().net.gate, null);
  assert.equal(r.company.status().link.outbox, 0);
  await r.home.checkNow();
  assert.equal(r.home.thread(thread).rounds[0].reply, '8 个进程。把握程度：高');
});

test('公司没能开会话：家里收到报错消息，可在公司页重试', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const original = r.company.deps.createSession;
  r.company.deps.createSession = async () => { throw new Error('codeagent 不在 PATH'); };
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '请说明 HARQ 进程数怎么定' } });
  await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'failed');
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, /没答上/);
  assert.match(r.hs.sent.at(-1).text, /codeagent 不在 PATH/);
  r.company.deps.createSession = original;
  r.company.retry(thread);
  await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running');
});

test('提问会话已关闭：先恢复再送回执；会话不在了就留在列表里', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '请说明 HARQ 进程数怎么定' } });
  await r.company.checkNow();
  r.cs.answer(r.cs.created[0].opts.id, '回答');
  await r.company.checkNow();
  r.hs.stored.set('h', r.hs.map.get('h')); r.hs.map.delete('h');
  await r.home.checkNow();
  assert.deepEqual(r.hs.resumed, ['h']);
  assert.equal(r.hs.sent.at(-1).id, 'h');
  assert.ok(r.home.thread(thread).rounds[0].delivered);
});

test('未配对时工具报清楚的错；问题太短被挡', async t => {
  const r = rig(t);
  await assert.rejects(r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '这是一个足够长的问题吗' } }), /还没配对/);
  await pair(r);
  await assert.rejects(r.home.invoke({ name: 'ask_company', callerSessionId: 'h', arguments: { question: '短' } }), /太短/);
  await assert.rejects(r.home.invoke({ name: 'ask_company', callerSessionId: '', arguments: { question: '这是一个足够长的问题吗' } }), /无法识别/);
});

test('MCP 挂载范围：配对后只给 SuperRAN 相关的 Codex / Claude 会话；可改为全部', async t => {
  const r = rig(t);
  assert.equal(r.home.wantsMcp({ kind: 'codex', opts: { purpose: 'wireless-proposal' } }), false, '未配对不挂');
  await pair(r);
  assert.equal(r.home.wantsMcp({ kind: 'codex', opts: { purpose: 'wireless-proposal' } }), true);
  assert.equal(r.home.wantsMcp({ kind: 'claude', opts: { cwd: 'D:/AIWork/20261015-superran-pf' } }), true);
  assert.equal(r.home.wantsMcp({ kind: 'codex', opts: { cwd: 'D:/AIWork/20261015-ppt' } }), false);
  assert.equal(r.home.wantsMcp({ kind: 'gemini', opts: { purpose: 'wireless-proposal' } }), false);
  assert.equal(r.home.wantsMcp({ kind: 'claude', opts: { purpose: 'hub-assistant', cwd: 'C:/x/superran' } }), false);
  r.home.setSettings({ attach: 'all' });
  assert.equal(r.home.wantsMcp({ kind: 'codex', opts: { cwd: 'D:/AIWork/20261015-ppt' } }), true);
  const entry = r.home.getMcpEntry('sess-1');
  assert.equal(entry.name, 'company_bridge');
  assert.equal(entry.env.HUB_BRIDGE_SESSION_ID, 'sess-1');
  assert.ok(fs.existsSync(entry.args[0]));
});

test('会话管理器：Codex 固定挂载不受 none 档影响；Claude 并进 --mcp-config 配置', t => {
  const { SessionManager } = require('../core/session-manager');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-extra-mcp-'));
  const old = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sm = Object.create(SessionManager.prototype);
  const entry = { name: 'company_bridge', command: 'node', args: ['x.js'], env: { A: '1' } };
  assert.deepEqual(sm._withExtraMcp('codex', { id: 'a' }), { id: 'a' }, '没有提供者时原样');
  sm.setExtraMcpProvider(() => entry);
  const codex = sm._withExtraMcp('codex', { id: 'a', mcpProfile: 'none' });
  assert.deepEqual(codex.codexPinnedMcpEntries, [entry]);
  const existing = path.join(dataDir, 'assistant.json');
  fs.writeFileSync(existing, JSON.stringify({ mcpServers: { hub_assistant: { command: 'node', args: ['a.js'] } } }));
  const claude = sm._withExtraMcp('claude', { id: 'b', mcpConfigFile: existing });
  const merged = JSON.parse(fs.readFileSync(claude.mcpConfigFile, 'utf8'));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['company_bridge', 'hub_assistant']);
  assert.equal(sm._withExtraMcp('gemini', { id: 'c' }).codexPinnedMcpEntries, undefined);
  sm.setExtraMcpProvider(() => null);
  assert.deepEqual(sm._withExtraMcp('codex', { id: 'd' }), { id: 'd' });
});
