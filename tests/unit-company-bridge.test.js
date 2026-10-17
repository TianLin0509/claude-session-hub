'use strict';
// 家里联动：加密、密钥协商配对、提问 → 公司开 CodeAgent 会话 → 回执 → 送回家里会话 → 追问进同一会话；
// 源码检查（围栏 / 无围栏 / 压成一行）先请改写再兜底删除；放行页时发件箱保留、放行后补发；
// 解除配对后旧任务作废；重试与追问不串轮；重复回执不重投；发件箱不丢关键消息；通道重建后游标归零；
// 本机接口按会话通行证认身份；MCP 与通行证的挂载规则；会话管理器把它们并进启动参数。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bridgeCrypto = require('../core/company-bridge/crypto');
const { CompanyBridge, sourceVerdict, stripCode, DEFAULT_INSTRUCTIONS, V1_INSTRUCTIONS, V2_INSTRUCTIONS, V3_INSTRUCTIONS } = require('../core/company-bridge/company');
const { HomeBridge } = require('../core/company-bridge/home');

const BASE = 'https://relay.example.test/drop/tok/api';

// 内存版通道服务：语义与 relay_server.py 的 /bridge/<通道>/msg 一致（GET 不建通道、带代次）。gate=true 时像公司代理一样返回网页。
function fakeRelay() {
  const relay = { channels: new Map(), seen: new Map(), gate: false, offline: false, posts: 0 };
  const headers = type => ({ get: k => (String(k).toLowerCase() === 'content-type' ? type : null) });
  relay.fetch = async (url, init = {}) => {
    if (relay.offline) throw new Error('ECONNRESET');
    if (relay.gate) return { ok: true, status: 200, type: 'basic', headers: headers('text/html'), text: async () => '<html>请点击允许访问</html>' };
    const u = new URL(url);
    const m = u.pathname.match(/\/bridge\/([a-f0-9]{32})\/msg$/);
    const json = (status, body) => ({ ok: status < 400, status, type: 'basic', headers: headers('application/json'), text: async () => JSON.stringify(body) });
    if (!m) return json(404, { ok: false, error: { code: 'not_found' } });
    if ((init.method || 'GET') === 'POST') {
      relay.posts += 1;
      const ch = relay.channels.get(m[1]) || { next: 1, rows: [], epoch: Math.random().toString(16).slice(2, 10) };
      relay.channels.set(m[1], ch);
      const body = JSON.parse(init.body);
      const dup = ch.rows.find(r => r.mid === body.mid);
      if (dup) return json(200, { ok: true, seq: dup.seq, duplicate: true });
      const row = { seq: ch.next++, to: body.to, mid: body.mid, blob: body.blob };
      ch.rows.push(row);
      return json(200, { ok: true, seq: row.seq, duplicate: false });
    }
    const to = u.searchParams.get('to'), after = Number(u.searchParams.get('after')), who = u.searchParams.get('who');
    if (who) relay.seen.set(m[1], { ...(relay.seen.get(m[1]) || {}), [who]: new Date(relay.now()).toISOString() });
    const ch = relay.channels.get(m[1]);
    return json(200, { ok: true, messages: ch ? ch.rows.filter(r => r.to === to && r.seq > after).map(r => ({ seq: r.seq, blob: r.blob })) : [], seen: relay.seen.get(m[1]) || {}, more: false, epoch: ch ? ch.epoch : null });
  };
  return relay;
}

function sessions() {
  const s = { map: new Map(), busy: new Set(), finals: new Map(), sent: [], created: [], resumed: [], stored: new Map(), receipt: null };
  s.deps = {
    createSession: async (kind, opts) => { const x = { id: opts.id, kind, status: 'idle', title: opts.title, opts }; s.map.set(opts.id, x); s.created.push({ kind, opts }); return x; },
    sendPrompt: async (id, text) => { if (!s.map.has(id)) return { ok: false, notSent: true, error: 'closed' }; s.sent.push({ id, text }); return s.receipt || { ok: true }; },
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
  let home, company;
  t.after(() => { try { home.close(); company.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const relay = fakeRelay();
  const clock = { now: 1_800_000_000_000 };
  relay.now = () => clock.now;
  const hs = sessions(), cs = sessions();
  const notices = [];
  home = new HomeBridge({ dataDir: path.join(root, 'home'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, relayBaseUrl: () => BASE.replace(/\/api$/, ''),
    onNotify: n => notices.push(n), ...hs.deps });
  company = new CompanyBridge({ dataDir: path.join(root, 'company'), noTimer: true, fetchImpl: relay.fetch, now: () => clock.now, fallbackCwd: root,
    isDirectory: () => true, onNotify: n => notices.push(n), ...cs.deps });
  return { root, relay, clock, hs, cs, home, company, notices };
}

async function pair(r) {
  const { code } = r.home.createPairing();
  await r.company.pair(code);
  await r.home.checkNow();
  await r.company.checkNow();
  await r.home.checkNow();
  await r.company.checkNow(); // 公司在正式通道上报一次在线
  await r.home.checkNow();
  assert.equal(r.home.status().link.state, 'paired');
  assert.equal(r.company.status().link.state, 'paired');
  return code;
}
const ask = (r, sid, question, title) => r.home.invoke({ name: 'ask_company', callerSessionId: sid, arguments: { question, ...(title ? { title } : {}) } });

test('加密：同钥能解、换钥或换收件方都解不开；配对码往返；密钥协商两端一致', () => {
  const secret = bridgeCrypto.newSecret(), link = bridgeCrypto.derive(secret);
  const blob = bridgeCrypto.seal(link, 'company', { type: 'ask', question: '你好' });
  assert.equal(bridgeCrypto.open(link, 'company', blob).question, '你好');
  assert.throws(() => bridgeCrypto.open(link, 'home', blob));
  assert.throws(() => bridgeCrypto.open(bridgeCrypto.derive(bridgeCrypto.newSecret()), 'company', blob));
  assert.match(link.channel, /^[a-f0-9]{32}$/);
  const code = bridgeCrypto.makePairingCode(BASE, secret, 'PUB');
  assert.deepEqual(bridgeCrypto.parsePairingCode('请粘贴：' + code + ' 谢谢'), { baseUrl: BASE, secret, homePublicKey: 'PUB' });
  assert.throws(() => bridgeCrypto.makePairingCode('http://evil.example/api', secret), /https/);
  assert.throws(() => bridgeCrypto.parsePairingCode('AIHUB-LINK-1.abc'), /配对码/);
  const a = bridgeCrypto.newKeyPair(), b = bridgeCrypto.newKeyPair();
  assert.equal(bridgeCrypto.agree(a.privateKey, b.publicKey, secret), bridgeCrypto.agree(b.privateKey, a.publicKey, secret));
});

test('配对：密钥协商后两端只用正式通道；拿到配对码的人解不出正式密钥，也冒充不了家里', async t => {
  const r = rig(t);
  const code = await pair(r);
  const initial = bridgeCrypto.parsePairingCode(code).secret;
  const homeSecret = r.home.link.config().secret, companySecret = r.company.link.config().secret;
  assert.equal(homeSecret, companySecret);
  assert.notEqual(homeSecret, initial);
  assert.equal(r.home.link.gen(), r.company.link.gen());
  // 旁观者：用配对码派生初始通道，解开上面所有消息——只有公司公钥和证明，没有正式密钥
  const leak = bridgeCrypto.derive(initial), rows = r.relay.channels.get(leak.channel).rows;
  const opened = rows.map(row => bridgeCrypto.open(leak, row.to, row.blob));
  assert.deepEqual(opened.map(m => m.type), ['hello']);
  assert.ok(!JSON.stringify(opened).includes(homeSecret));
  assert.ok(r.notices.some(n => /已和公司接通/.test(n.title)) && r.notices.some(n => /AI特战队 · 配对已完成/.test(n.title)));
  assert.ok(r.home.status().peer.companyOnline);
});

test('冒充：拿到配对码的人抢在家里前面发 welcome，公司不认；配对后再出现第二个 hello，家里解除配对', async t => {
  const r = rig(t);
  const { code } = r.home.createPairing();
  await r.company.pair(code);
  const { baseUrl, secret: initial } = bridgeCrypto.parsePairingCode(code);
  // 攻击者知道初始密钥：往初始通道发 welcome，也往猜测的通道发——公司只在正式通道收，且要家里私钥才产生得了
  const forged = bridgeCrypto.derive(initial);
  await r.relay.fetch(baseUrl + `/bridge/${forged.channel}/msg`, { method: 'POST', body: JSON.stringify({ to: 'company', mid: 'forged-0001', blob: bridgeCrypto.seal(forged, 'company', { type: 'welcome', proof: 'x', mid: 'forged-0001' }) }) });
  await r.company.checkNow();
  assert.equal(r.company.status().link.state, 'waiting-welcome', '假 welcome 不被接受');
  await r.home.checkNow(); await r.company.checkNow();
  assert.equal(r.company.status().link.state, 'paired');
  // 另一台设备拿同一个配对码又来配：家里发现第二个 hello，解除配对
  const intruder = new CompanyBridge({ dataDir: path.join(r.root, 'intruder'), noTimer: true, fetchImpl: r.relay.fetch, now: () => r.clock.now, ...sessions().deps });
  await intruder.pair(code);
  intruder.close();
  r.clock.now += 60000;
  await r.home.checkNow();
  assert.equal(r.home.status().link.state, 'none');
  assert.ok(r.notices.some(n => /已解除配对/.test(n.title)));
});

test('完整往返：提问 → 公司新开 CodeAgent 会话 → 回执送回提问会话 → 追问进同一会话', async t => {
  const r = rig(t);
  await pair(r);
  r.company.setSettings({ codeRoots: 'D:/code/l2\nD:/code/common', model: 'GLM-5.2-WX-Auto' });
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle', title: 'SuperRAN PF 调度' });
  r.hs.map.set('other', { id: 'other', kind: 'codex', status: 'idle' });
  const asked = await ask(r, 'home-s1', '## 目的\n对齐 PF 调度\n## 问题\n1. 遗忘因子怎么取？', 'PF 遗忘因子');
  assert.match(asked.thread, /^Q-\d{4}-01$/);
  assert.match(asked.next, /结束本轮/);

  await r.company.checkNow();
  assert.equal(r.cs.created.length, 1);
  const created = r.cs.created[0];
  assert.equal(created.kind, 'codeagent');
  assert.equal(created.opts.cwd, 'D:/code/l2');
  assert.deepEqual(created.opts.addDirs, ['D:/code/common']);
  assert.equal(created.opts.model, undefined, '模型用 CodeAgent 默认，不传给会话（否则会走 /model 菜单）');
  assert.equal(created.opts.purpose, 'company-bridge');
  // 会话名一眼对上家里那一个（2026-10-18）：Q-MMDD-01 由家里 Codex 发问 → MMDD-Q1-codex
  const [, mmdd] = asked.thread.match(/^Q-(\d{4})-01$/);
  assert.equal(created.opts.title, `${mmdd}-Q1-codex`);
  const companySession = created.opts.id;
  assert.match(r.cs.sent[0].text, /保持公司电脑原样/);
  assert.match(r.cs.sent[0].text, /不回传源码/);
  assert.match(r.cs.sent[0].text, /D:\/code\/l2/);
  assert.match(r.cs.sent[0].text, /遗忘因子/);

  await r.home.checkNow();
  assert.equal(r.home.thread(asked.thread).rounds[0].status, 'running');
  // 通道串的进度线要用：公司第一次说收到、开始处理的时间（2026-10-16）
  const firstRound = r.home.thread(asked.thread).rounds[0];
  assert.ok(firstRound.ackAt >= firstRound.sentAt && firstRound.startedAt >= firstRound.ackAt, '记下 ackAt 与 startedAt');
  // 界面从 bridge:status 读这两个时间：要原样带出
  assert.ok(r.home.status().threads.find(t => t.id === asked.thread).rounds[0].startedAt);

  r.cs.busy.add(companySession); r.cs.answer(companySession, '半截');
  await r.company.checkNow();
  assert.equal(r.company.thread(asked.thread).state, 'running');
  r.cs.busy.delete(companySession);
  r.cs.finals.set(companySession, [{ id: 'f1', text: '## 结论\n每 TTI 更新，系数 0.01。\n把握程度：高' }]);
  await r.company.checkNow();
  assert.equal(r.company.thread(asked.thread).state, 'replied');

  r.hs.map.get('home-s1').status = 'running';
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 0, '提问会话在忙就等');
  r.hs.map.get('home-s1').status = 'idle';
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
  assert.equal(r.hs.sent[0].id, 'home-s1');
  assert.match(r.hs.sent[0].text, new RegExp(`【公司回执 ${asked.thread} · 第 1 轮】`));
  assert.match(r.hs.sent[0].text, /followup_company/);
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1, '同一份回执只送一次');

  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'other', arguments: { thread: asked.thread, question: '再看看' } }), /另一个会话/);
  await assert.rejects(r.home.invoke({ name: 'company_thread', callerSessionId: 'other', arguments: { thread: asked.thread } }), /找不到本会话/);
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread, question: '初值怎么给？请读初始化部分' } });
  await r.company.checkNow();
  assert.equal(r.cs.created.length, 1, '追问不新开会话');
  assert.equal(r.cs.sent.at(-1).id, companySession);
  assert.match(r.cs.sent.at(-1).text, /第 2 轮/);
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread, question: '再看看初始化' } }), /还没回执/);
  r.cs.answer(companySession, '初值按宽带 CQI 估算。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, /第 2 轮/);
  assert.match(r.hs.sent.at(-1).text, /宽带 CQI/);
  const view = await r.home.invoke({ name: 'company_thread', callerSessionId: 'home-s1', arguments: {} });
  assert.equal(view.threads[0].rounds.length, 2);
});

test('源码检查：围栏、~~~、无围栏代码行、压成一行都算；先请改写，改写后仍超就删掉再发', async t => {
  const lines = n => Array.from({ length: n }, (_, i) => `x${i} = y${i} + z;`).join('\n');
  assert.equal(sourceVerdict('结论：遗忘因子 1/64。\n- 每 TTI 更新\n- 未调度按 0 衰减').tooMuch, false);
  assert.equal(sourceVerdict('```c\n' + lines(13) + '\n```').tooMuch, true, '围栏成段');
  assert.equal(sourceVerdict('~~~\n' + lines(13) + '\n~~~').tooMuch, true, '~~~ 围栏');
  assert.equal(sourceVerdict('说明如下\n' + lines(13)).tooMuch, true, '无围栏代码行');
  assert.equal(sourceVerdict(['A', '```', lines(10), '```', 'B', '```', lines(10), '```', 'C', '```', lines(11), '```'].join('\n')).tooMuch, true, '多块累计');
  assert.equal(sourceVerdict('一行：' + Array.from({ length: 40 }, (_, i) => `a${i}=b${i};`).join(' ')).tooMuch, true, '压成一行');
  assert.equal(sourceVerdict('| 量 | 单位 |\n|---|---|\n| se | bit/s/Hz |').tooMuch, false, '表格不算');
  // 零散小段（每段 3 行、11 段）累计超限：兜底后不再超限
  const scattered = Array.from({ length: 11 }, (_, i) => `说明 ${i}\n` + lines(3)).join('\n');
  assert.equal(sourceVerdict(scattered).tooMuch, true);
  const first = stripCode(scattered, 3);
  assert.equal(sourceVerdict(first.text).tooMuch, true, '只删成段的不够');
  assert.equal(sourceVerdict(stripCode(first.text, 0).text).tooMuch, false);
  const stripped = stripCode('前文\n```c\n' + lines(20) + '\n```\n后文');
  assert.ok(!stripped.text.includes('x10 = y10'));
  assert.match(stripped.text, /按规则不回传/);
  assert.match(stripped.text, /后文/);

  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'claude', status: 'idle' });
  const { thread } = await ask(r, 'h', '请说明重传合并的逻辑');
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.answer(sid, '结论如下\n' + lines(20));
  await r.company.checkNow();
  assert.match(r.cs.sent.at(-1).text, /重写/);
  assert.equal(r.cs.sent.at(-1).id, sid);
  r.cs.answer(sid, '改写稿\n~~~\n' + lines(20) + '\n~~~\n结尾');
  await r.company.checkNow();
  await r.home.checkNow();
  const reply = r.home.thread(thread).rounds[0].reply;
  assert.ok(!reply.includes('x10 = y10'));
  assert.match(reply, /按规则不回传/);
  assert.match(reply, /结尾/);
});

test('放行页：公司代理返回网页时记为待放行、回执留在发件箱，放行后补发', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
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

test('公司没能开会话：家里收到报错；公司重试后家里的报错清掉、追问要等这一轮回来（不串轮）', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const original = r.company.deps.createSession;
  r.company.deps.createSession = async () => { throw new Error('codeagent 不在 PATH'); };
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
  await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'failed');
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, /没答上/);
  assert.match(r.hs.sent.at(-1).text, /codeagent 不在 PATH/);
  r.company.deps.createSession = original;
  r.company.retry(thread);
  await r.company.checkNow();
  assert.equal(r.company.thread(thread).state, 'running');
  await r.home.checkNow();
  assert.equal(r.home.thread(thread).rounds[0].error, null, '重试开始后家里清掉上次的报错');
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'h', arguments: { thread, question: '换个问法再问' } }), /还没回执/);
  r.cs.answer(r.cs.created[0].opts.id, '16 个进程');
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.home.thread(thread).rounds[0].reply, '16 个进程');
  assert.match(r.hs.sent.at(-1).text, /16 个进程/);
});

test('公司发问结果未知、3 分钟后原生记录都没有：重发一次；之后照常收回答', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  r.cs.receipt = { ok: true, sendStatus: 'stuck' };
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
  await r.company.checkNow();
  assert.equal(r.cs.sent.length, 1);
  assert.equal(r.company.thread(thread).rounds[0].sendUncertain, true, '「stuck」即使 ok:true 也记为结果未知');
  r.clock.now += 4 * 60000;
  r.cs.receipt = { ok: true };
  await r.company.checkNow();
  await r.company.checkNow();
  assert.equal(r.cs.sent.length, 2, '重发了一次');
  r.clock.now += 4 * 60000;
  await r.company.checkNow();
  assert.equal(r.cs.sent.length, 2, '只重发一次');
  r.cs.answer(r.cs.created[0].opts.id, '16 个进程');
  await r.company.checkNow(); await r.home.checkNow();
  assert.equal(r.home.thread(thread).rounds[0].reply, '16 个进程');
});

test('提问会话已关闭：先恢复再送回执；会话不在了就留在列表里', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
  await r.company.checkNow();
  r.cs.answer(r.cs.created[0].opts.id, '回答');
  await r.company.checkNow();
  r.hs.stored.set('h', r.hs.map.get('h')); r.hs.map.delete('h');
  await r.home.checkNow();
  assert.deepEqual(r.hs.resumed, ['h']);
  assert.equal(r.hs.sent.at(-1).id, 'h');
  assert.ok(r.home.thread(thread).rounds[0].delivered);
});

test('送达结果未知（确认迟到）按已送达处理，不重发；重复回执不重投', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
  await r.company.checkNow();
  r.cs.answer(r.cs.created[0].opts.id, '回答 A');
  await r.company.checkNow();
  r.hs.receipt = { ok: false, sendStatus: 'stuck' };
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
  const round = r.home.thread(thread).rounds[0];
  assert.ok(round.delivered && round.deliveryUncertain);
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1, '不重发');
  // 公司把同一轮的回执又发了一遍（例如崩溃后重发）：家里不重投
  await r.company.link.send('reply', { thread, gen: r.company.link.gen(), round: 1, text: '回答 A（重发）' });
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
  assert.equal(r.home.thread(thread).rounds[0].reply, '回答 A');
});

test('解除配对：没答完的问题作废；重新配对后旧回执不会发给新的对端', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'h', '请说明 HARQ 进程数怎么定');
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.company.unpair(); r.home.unpair();
  assert.equal(r.company.thread(thread).state, 'cancelled');
  assert.equal(r.home.thread(thread).state, 'cancelled');
  await pair(r);
  r.cs.answer(sid, '旧问题的回答');
  const postsBefore = r.relay.posts;
  await r.company.checkNow();
  assert.equal(r.relay.posts, postsBefore, '旧问题的回执不发');
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'h', arguments: { thread, question: '还在吗？' } }), /作废|找不到/);
  const again = await ask(r, 'h', '新配对后重新提问一次');
  assert.notEqual(again.thread, thread);
});

test('发件箱：网络断着时进度通知可以丢，问题和回执一条不丢', async t => {
  const r = rig(t);
  await pair(r);
  r.relay.offline = true;
  r.company.link.store.set('outbox', Array.from({ length: 999 }, (_, i) => ({ channel: 'c', to: 'home', mid: 'm' + i, blob: 'QQ', type: i % 2 ? 'status' : 'reply' })));
  await r.company.link.send('status', { note: 'x' });
  await r.company.link.send('reply', { text: 'y' });
  const box = r.company.link.store.get('outbox');
  assert.equal(box.length, 1000);
  assert.equal(box.filter(x => x.type === 'reply').length, 501, '回执一条没丢');
  r.company.link.store.set('outbox', Array.from({ length: 1000 }, (_, i) => ({ channel: 'c', to: 'home', mid: 'r' + i, blob: 'QQ', type: 'reply' })));
  await assert.rejects(r.company.link.send('reply', { text: 'z' }), /发件箱已满/);
});

test('通道被服务端清理重建（代次变了）：游标归零，新消息照样收到', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle' });
  await ask(r, 'h', '第一个问题：HARQ 进程数');
  await r.company.checkNow();
  assert.ok(r.company.link.config().cursor > 0);
  const channel = bridgeCrypto.derive(r.company.link.config().secret).channel;
  r.relay.channels.delete(channel); // 服务端清理
  const { thread } = await ask(r, 'h', '第二个问题：最大重传次数');
  await r.company.checkNow();
  assert.ok(r.company.thread(thread), '重建后的新问题收到了');
});

test('本机接口：凭会话通行证认身份，冒充别的会话被拒', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('s1', { id: 's1', kind: 'codex', status: 'idle' });
  await r.home.start();
  const url = JSON.parse(fs.readFileSync(r.home.endpointFile, 'utf8')).url;
  const call = (session, pass, body) => fetch(url, { method: 'POST', headers: { Authorization: 'Bearer ' + pass, 'X-Hub-Bridge-Session': session, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await call('s1', 'wrong', { name: 'company_thread', arguments: {} })).status, 403);
  assert.equal((await call('s2', r.home.passFor('s1'), { name: 'company_thread', arguments: {} })).status, 403, '拿 s1 的通行证冒充 s2');
  const ok = await (await call('s1', r.home.passFor('s1'), { name: 'ask_company', arguments: { question: '通过本机接口提问一次' } })).json();
  assert.equal(ok.ok, true);
  assert.equal(r.home.thread(ok.result.thread).sessionId, 's1');
  const gone = await (await call('s9', r.home.passFor('s9'), { name: 'ask_company', arguments: { question: '已删除的会话来提问' } })).json();
  assert.match(gone.error, /不在 Hub 里/);
});

test('旧版数据库（没有 open 列）能升级并回填', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bridge-migrate-'));
  let c = null;
  t.after(() => { try { c?.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const { DatabaseSync } = require('node:sqlite');
  fs.mkdirSync(path.join(root, 'company-bridge'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'company-bridge', 'assistant.sqlite'));
  db.exec('CREATE TABLE bridge_threads(id TEXT PRIMARY KEY,payload TEXT NOT NULL,state TEXT NOT NULL,updated INTEGER NOT NULL)');
  db.prepare('INSERT INTO bridge_threads VALUES(?,?,?,?)').run('Q-1', JSON.stringify({ id: 'Q-1', rounds: [{ round: 1, question: 'q', receivedAt: 1 }] }), 'queued', 1);
  db.close();
  c = new CompanyBridge({ dataDir: root, noTimer: true, ...sessions().deps });
  assert.equal(c.openThreads().length, 1);
  c.saveThread({ ...c.thread('Q-1'), rounds: [{ round: 1, question: 'q', reply: 'a' }] });
  assert.equal(c.openThreads().length, 0);
});

test('挂载：配对后 Codex / Claude 会话拿到通行证；只有 SuperRAN 相关的挂 MCP（可改为全部）', async t => {
  const r = rig(t);
  assert.equal(r.home.sessionPlan({ kind: 'codex', opts: { purpose: 'wireless-proposal' }, id: 'a' }), null, '未配对什么都不挂');
  await pair(r);
  const wireless = r.home.sessionPlan({ kind: 'codex', opts: { purpose: 'wireless-proposal' }, id: 'a' });
  assert.equal(wireless.mcp.name, 'company_bridge');
  assert.equal(wireless.mcp.env.HUB_BRIDGE_SESSION_PASS, r.home.passFor('a'));
  assert.equal(wireless.env.HUB_BRIDGE_SESSION_ID, 'a');
  assert.ok(fs.existsSync(wireless.mcp.args[0]));
  assert.ok(r.home.sessionPlan({ kind: 'claude', opts: { cwd: 'D:/AIWork/20261015-superran-pf' }, id: 'b' }).mcp);
  const plain = r.home.sessionPlan({ kind: 'codex', opts: { cwd: 'D:/AIWork/20261015-ppt' }, id: 'c' });
  assert.equal(plain.mcp, null, '普通会话不挂 MCP');
  assert.equal(plain.env.HUB_BRIDGE_SESSION_PASS, r.home.passFor('c'), '但有通行证，可用命令');
  assert.ok(fs.existsSync(plain.env.HUB_BRIDGE_CLI), '命令路径由 Hub 注入');
  assert.equal(r.home.sessionPlan({ kind: 'gemini', opts: {}, id: 'd' }), null);
  assert.equal(r.home.sessionPlan({ kind: 'claude', opts: { purpose: 'hub-assistant', cwd: 'C:/x/superran' }, id: 'e' }), null);
  r.home.setSettings({ attach: 'all' });
  assert.ok(r.home.sessionPlan({ kind: 'codex', opts: { cwd: 'D:/AIWork/20261015-ppt' }, id: 'f' }).mcp);
});

test('会话管理器：Codex 固定挂载不受 none 档影响；Claude 并进 --mcp-config；通行证进会话环境', t => {
  const { SessionManager } = require('../core/session-manager');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-extra-mcp-'));
  const old = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sm = Object.create(SessionManager.prototype);
  const entry = { name: 'company_bridge', command: 'node', args: ['x.js'], env: { A: '1' } };
  assert.deepEqual(sm._withExtraMcp('codex', { id: 'a' }), { id: 'a' }, '没有提供者时原样');
  sm.setExtraMcpProvider(() => ({ mcp: entry, env: { HUB_BRIDGE_SESSION_PASS: 'p' } }));
  const codex = sm._withExtraMcp('codex', { id: 'a', mcpProfile: 'none', extraEnv: { X: '1' } });
  assert.deepEqual(codex.codexPinnedMcpEntries, [entry]);
  assert.deepEqual(codex.extraEnv, { X: '1', HUB_BRIDGE_SESSION_PASS: 'p' });
  const existing = path.join(dataDir, 'assistant.json');
  fs.writeFileSync(existing, JSON.stringify({ mcpServers: { hub_assistant: { command: 'node', args: ['a.js'] } } }));
  const claude = sm._withExtraMcp('claude', { id: 'b', mcpConfigFile: existing });
  const merged = JSON.parse(fs.readFileSync(claude.mcpConfigFile, 'utf8'));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['company_bridge', 'hub_assistant']);
  sm.setExtraMcpProvider(() => ({ mcp: null, env: { HUB_BRIDGE_SESSION_PASS: 'q' } }));
  const envOnly = sm._withExtraMcp('codex', { id: 'c' });
  assert.equal(envOnly.codexPinnedMcpEntries, undefined);
  assert.equal(envOnly.extraEnv.HUB_BRIDGE_SESSION_PASS, 'q');
  sm.setExtraMcpProvider(() => null);
  assert.deepEqual(sm._withExtraMcp('codex', { id: 'd' }), { id: 'd' });
});

test('公司 CodeAgent 会话（purpose=company-bridge）：不传不起作用的禁用参数，只是不挂 Hub 自己的 MCP', () => {
  const { buildCodeAgentPtyLaunch } = require('../core/session-manager')._private;
  const config = { command: 'codeagent', configDir: os.tmpdir(), configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const bridge = buildCodeAgentPtyLaunch('x', 'codeagent', { purpose: 'company-bridge', mcpProfile: 'full', mcpConfigFile: 'C:/x.json' }, os.tmpdir(), {}, config).cmd;
  assert.doesNotMatch(bridge, /disallowedTools/);
  assert.doesNotMatch(bridge, /x\.json/);
  const normal = buildCodeAgentPtyLaunch('y', 'codeagent', { mcpProfile: 'full' }, os.tmpdir(), {}, config).cmd;
  assert.doesNotMatch(normal, /disallowedTools/);
});

test('剪贴板里的图片顶掉问题：那条回答不发回家、自动重发；连着 2 次以上报错，重试后清零', async t => {
  const r = rig(t);
  await pair(r);
  const turns = new Map();
  r.company.deps.readUserTurns = file => turns.get(file) || [];
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle', title: 'SuperRAN' });
  const asked = await ask(r, 'home-s1', '## 目的\n查文档\n## 问题\n1. 最新周报是哪天？');
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  const file = 'C:/t/' + sid + '.jsonl';
  r.cs.map.get(sid).transcriptPath = file;
  const hijack = () => { turns.set(file, [{ at: r.clock.now, text: '', images: 1 }]); r.cs.answer(sid, '收到一张图片，你想做什么？'); };
  hijack();
  await r.company.checkNow();
  let round = r.company.thread(asked.thread).rounds[0];
  assert.equal(round.reply, undefined, '答图片的那条不当回执');
  assert.equal(round.hijacked, 1);
  assert.ok(r.notices.some(n => /剪贴板图片/.test(n.title)));
  await r.company.checkNow();
  assert.equal(r.cs.sent.length, 2, '自动重发了一次');
  assert.match(r.cs.sent[1].text, new RegExp('编号 ' + asked.thread));
  r.clock.now += 1000; hijack(); await r.company.checkNow(); await r.company.checkNow();
  r.clock.now += 1000; hijack(); await r.company.checkNow();
  round = r.company.thread(asked.thread).rounds[0];
  assert.match(round.error, /剪贴板/);
  await r.home.checkNow();
  assert.equal(r.home.thread(asked.thread).rounds[0].reply, undefined, '家里一条图片回答都没收到');
  r.company.retry(asked.thread);
  assert.equal(r.company.thread(asked.thread).rounds[0].hijacked, 0);
  // 重发后正常收到：带编号的消息 + 回答，照常回执
  await r.company.checkNow();
  r.clock.now += 1000;
  turns.set(file, [{ at: r.clock.now, text: '## 家里的问题（编号 ' + asked.thread + '）\n1. 最新周报是哪天？', images: 0 }]);
  r.cs.answer(sid, '最新是 10-15。把握程度：高');
  await r.company.checkNow();
  assert.match(r.company.thread(asked.thread).rounds[0].reply, /10-15/);
});

test('原生记录解析：只取用户发出的消息（文字、图片），工具结果不算', t => {
  const { userTurnsFromTranscript } = require('../core/company-bridge/company');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-bridge-turns-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'a.jsonl');
  fs.writeFileSync(file, [
    { type: 'user', timestamp: '2026-10-15T02:30:00Z', message: { role: 'user', content: '## 家里的问题（编号 Q-1015-03）' } },
    { type: 'assistant', timestamp: '2026-10-15T02:30:05Z', message: { role: 'assistant', content: [{ type: 'text', text: 'x' }] } },
    { type: 'user', timestamp: '2026-10-15T02:30:06Z', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] } },
    { type: 'user', timestamp: '2026-10-15T02:31:00Z', message: { role: 'user', content: [{ type: 'image', source: {} }] } },
  ].map(x => JSON.stringify(x)).join('\n') + '\nnot json\n');
  const turns = userTurnsFromTranscript(file);
  assert.equal(turns.length, 2);
  assert.match(turns[0].text, /编号 Q-1015-03/);
  assert.equal(turns[1].images, 1);
  assert.deepEqual(userTurnsFromTranscript(path.join(dir, 'missing.jsonl')), []);
});

test('粘贴前清剪贴板图片：只在有图片时清一次、不放回；同一次复制里的文字留着；纯文字不碰；出错不挡粘贴', () => {
  const { dropImage } = require('../core/company-bridge/clipboard-guard');
  const fake = (formats, text = '') => {
    const c = { formats, text, ops: [] };
    Object.assign(c, {
      availableFormats: () => c.formats,
      readText: () => c.text,
      clear: () => { c.ops.push('clear'); c.formats = []; c.text = ''; },
      writeText: t => { c.ops.push('writeText'); c.formats = ['text/plain']; c.text = t; },
      writeImage: () => { c.ops.push('writeImage'); },
    });
    return c;
  };
  let c = fake(['image/png']);
  assert.deepEqual(dropImage(c), { cleared: true, keptText: false });
  assert.deepEqual(c.ops, ['clear'], '只清一次，不放回图片');
  assert.deepEqual(c.formats, []);
  // 从 Word 之类复制：图片和文字一起进剪贴板，文字当场写回
  c = fake(['text/plain', 'text/html', 'image/png'], '会议纪要第一段');
  assert.deepEqual(dropImage(c), { cleared: true, keptText: true });
  assert.deepEqual(c.ops, ['clear', 'writeText']);
  assert.equal(c.text, '会议纪要第一段');
  // 纯文字：一概不碰
  c = fake(['text/plain'], '要粘贴的命令');
  assert.deepEqual(dropImage(c), { cleared: false, keptText: false });
  assert.deepEqual(c.ops, []);
  // 剪贴板被别的程序占着：不抛错，粘贴照常进行
  c = fake(['image/png']); c.clear = () => { throw new Error('clipboard busy'); };
  assert.deepEqual(dropImage(c), { cleared: false, keptText: false });
  assert.deepEqual(dropImage(null), { cleared: false, keptText: false });
});

test('往 CodeAgent 粘贴（含公司桥接派的任务）前清剪贴板图片，紧挨着粘贴、只对 CodeAgent', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  const at = src.indexOf("require('./company-bridge/clipboard-guard').dropImage(clipboard)");
  const paste = src.indexOf('if (!usedCodexEditorInput) await writeBracketedPaste(sessionManager, sid, prompt');
  assert.ok(at > 0 && paste > at, '清图片在粘贴之前');
  assert.ok(!/await/.test(src.slice(at, paste)), '清完到粘贴之间没有等待');
  assert.match(src.slice(at - 400, at), /if \(isCodeAgentKind\(kind\) && !usedCodexEditorInput\)/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  assert.ok(!/withImageAside/.test(main), '不再「发完放回」：放回的图片会被 CodeAgent 后续读到');
});

test('公司设置：旧版存的模型不再生效；没改过的历代默认说明自动换成当前版，改过的保留', async t => {
  const r = rig(t);
  r.company.store.set('settings', { enabled: true, codeRoots: ['C:/AirView'], instructions: V1_INSTRUCTIONS, model: 'GLM-5.2-WX-Auto', effort: 'high', maxParallel: 2, pollSeconds: 30 });
  const s = r.company.settings();
  assert.equal(s.model, undefined);
  assert.equal(s.instructions, DEFAULT_INSTRUCTIONS);
  r.company.store.set('settings', { ...r.company.store.get('settings'), instructions: V2_INSTRUCTIONS });
  assert.equal(r.company.settings().instructions, DEFAULT_INSTRUCTIONS);
  assert.match(DEFAULT_INSTRUCTIONS, /MCP/);
  r.company.store.set('settings', { ...r.company.store.get('settings'), instructions: V3_INSTRUCTIONS });
  assert.equal(r.company.settings().instructions, DEFAULT_INSTRUCTIONS);
  assert.doesNotMatch(DEFAULT_INSTRUCTIONS, /家里/);
  assert.match(DEFAULT_INSTRUCTIONS, /明确要求时才做/);
  r.company.setSettings({ instructions: '我自己写的说明' });
  assert.equal(r.company.settings().instructions, '我自己写的说明');
  r.company.setSettings({ instructions: '' });
  assert.equal(r.company.settings().instructions, DEFAULT_INSTRUCTIONS);
});

// 2026-10-17 田哥：工作日忙时 3 个、内存保底 10%，这些数字都可在设置里调。
test('并行设置：旧版存的默认 2 换成新默认 3，调过的保留；各档位可设、越界报错；状态页给出现在的上限和原因', async t => {
  const r = rig(t);
  r.company.store.set('settings', { enabled: true, codeRoots: [], maxParallel: 2, pollSeconds: 30 });
  let s = r.company.settings();
  assert.equal(s.maxParallel, 3); assert.equal(s.perAccountPeak, 3); assert.equal(s.perAccountIdle, 6); assert.equal(s.memFloorPct, 10);
  r.company.setSettings({ maxParallel: 2, perAccountIdle: 8, memFloorPct: 15, busyHours: '09:00-18:00' });
  s = r.company.settings();
  assert.equal(s.maxParallel, 2, '用户在新设置页亲手选的 2 要保留');
  assert.equal(s.perAccountIdle, 8); assert.equal(s.memFloorPct, 15); assert.equal(s.busyHours, '09:00-18:00');
  assert.throws(() => r.company.setSettings({ memFloorPct: 60 }), /内存保底百分比只能是 5–50/);
  assert.throws(() => r.company.setSettings({ maxParallel: 9 }), /1–8/);
  const p = r.company.status().parallel;
  assert.ok(p && Number.isInteger(p.cap) && p.cap >= 1 && typeof p.limitedBy === 'string');
  const ui = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'home-link.js'), 'utf8');
  for (const key of ['maxParallel', 'maxParallelIdle', 'perAccountPeak', 'perAccountIdle', 'memFloorPct', 'busyHours', 'usePool']) {
    assert.match(ui, new RegExp(`data-hl-f="\\$\\{key\\}"|data-hl-f="${key}"`), `设置页要能改 ${key}`);
    assert.match(ui, new RegExp(`${key}: (Number\\()?field\\('${key}'\\)`), `保存时要带上 ${key}`);
  }
});

test('公司 CodeAgent 会话即使带了模型也不走 /model 菜单；普通 CodeAgent 会话照旧', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const { shouldPickCodeAgentModel } = require('../core/session-manager')._private;
  assert.equal(shouldPickCodeAgentModel({ model: 'MiniMax-M2.7', purpose: 'company-bridge' }), false);
  assert.equal(shouldPickCodeAgentModel({ model: 'MiniMax-M2.7', purpose: 'company-bridge', codeagentModelPick: true }), false);
});

test('自动检查：空闲按原设置；首问收到后立即缩短到 10 秒，不沿用刚排好的空闲倒计时', async t => {
  const r = rig(t);
  await pair(r);
  r.company.setSettings({ enabled: false, pollSeconds: 120 });
  await r.company.checkNow();
  assert.equal(r.company.status().polling.intervalSeconds, 120);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const first = await ask(r, 'home-s1', '请检查自动轮询何时收到这条测试任务');
  r.clock.now += 119000;
  await r.company.tick();
  assert.equal(r.company.thread(first.thread), null, '空闲时还没到下一次检查');
  r.clock.now += 1000;
  await r.company.tick();
  assert.ok(r.company.thread(first.thread), '自动检查收到首问');
  assert.equal(r.company.status().polling.intervalSeconds, 10);
  assert.equal(r.company.nextPullAt, r.clock.now + 10000);
  const second = await ask(r, 'home-s1', '另一条任务也应在十秒内被检查收到');
  r.clock.now += 9999;
  await r.company.tick();
  assert.equal(r.company.thread(second.thread), null);
  r.clock.now += 1;
  await r.company.tick();
  assert.ok(r.company.thread(second.thread));
});

test('自动检查：长任务持续 10 秒，完成后保留 10 分钟追问窗口，再恢复空闲间隔', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'home-s1', '请处理一项超过十分钟的测试任务');
  await r.company.checkNow();
  const sid = r.company.thread(thread).sessionId;
  r.cs.busy.add(sid);
  r.clock.now += 20 * 60000;
  await r.company.tick();
  assert.equal(r.company.status().polling.intervalSeconds, 10);
  r.cs.busy.delete(sid); r.cs.answer(sid, '长任务已完成。');
  await r.company.tick();
  const doneAt = r.clock.now;
  assert.equal(r.company.status().polling.activeUntil, doneAt + 10 * 60000);
  r.clock.now = doneAt + 10 * 60000 - 1;
  assert.equal(r.company.status().polling.intervalSeconds, 10);
  r.clock.now += 1;
  await r.company.tick();
  assert.equal(r.company.status().polling.intervalSeconds, 30);
  assert.equal(r.company.nextPullAt, r.clock.now + 30000);
});

test('自动检查：断网时未发出的回执保持 10 秒重试，恢复后只发一次', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'home-s1', '请验证断网期间回执排队和网络恢复');
  await r.company.checkNow();
  r.relay.offline = true;
  r.cs.answer(r.company.thread(thread).sessionId, '网络恢复后送达这条回执。');
  await r.company.tick();
  r.clock.now += 11 * 60000;
  await r.company.tick();
  assert.equal(r.company.status().polling.intervalSeconds, 10);
  assert.ok(r.company.status().link.outbox > 0);
  assert.ok(r.company.status().net.lastError);
  r.relay.offline = false;
  r.clock.now += 10000;
  await r.company.tick();
  assert.equal(r.company.status().link.outbox, 0);
  await r.home.checkNow();
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
});

test('自动检查：重开程序保留近期追问窗口，换配对不继承旧窗口', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'home-s1', '请验证重新启动之后保留追问窗口');
  await r.company.checkNow();
  r.cs.answer(r.company.thread(thread).sessionId, '完成。');
  await r.company.tick();
  r.company.close();
  const company = new CompanyBridge({ ...r.company.deps });
  try {
  r.clock.now += 60000;
  assert.equal(company.status().polling.intervalSeconds, 10);
  company.unpair();
  assert.equal(company.status().polling.intervalSeconds, 0);
  await company.pair(r.home.createPairing().code);
  await r.home.checkNow(); await company.checkNow();
  assert.equal(company.status().polling.intervalSeconds, 30);
  } finally { company.close(); }
});

test('自动检查：调低空闲间隔立即收紧倒计时；未配对不发请求', async t => {
  const r = rig(t);
  let pulls = 0;
  const pull = r.company.link.pull.bind(r.company.link);
  r.company.link.pull = (...args) => { pulls++; return pull(...args); };
  await r.company.tick();
  assert.equal(pulls, 0);
  await pair(r);
  r.company.setSettings({ pollSeconds: 600 });
  await r.company.checkNow();
  assert.equal(r.company.nextPullAt, r.clock.now + 600000);
  r.company.setSettings({ pollSeconds: 10 });
  assert.equal(r.company.nextPullAt, r.clock.now + 10000);
});

test('家里自动检查：发问与追问都把空闲的 1 分钟等待收紧为 10 秒', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  await r.home.checkNow();
  assert.equal(r.home.nextPullAt, r.clock.now + 60000);
  const { thread } = await ask(r, 'home-s1', '请验证家里收到回执不再多等三十秒');
  assert.equal(r.home.nextPullAt, r.clock.now + 10000);
  await r.company.checkNow();
  r.cs.answer(r.company.thread(thread).sessionId, '第一轮回答。');
  await r.company.tick();
  r.clock.now += 9999;
  await r.home.tick();
  assert.equal(r.hs.sent.length, 0);
  r.clock.now += 1;
  await r.home.tick();
  assert.equal(r.hs.sent.length, 1);
  await r.home.checkNow();
  assert.equal(r.home.nextPullAt, r.clock.now + 60000);
  await r.home.followup('home-s1', { thread, question: '请继续验证第二轮追问' });
  assert.equal(r.home.nextPullAt, r.clock.now + 10000);
});

test('公司开会话慢时仍每 10 秒收新任务，同一任务不会并发派发两次', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const first = await ask(r, 'home-s1', '第一项测试任务，模拟创建会话很慢');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const create = r.company.deps.createSession;
  let calls = 0;
  r.company.deps.createSession = async (...args) => { calls++; entered(); await blocked; return create(...args); };
  const ticks = [r.company.checkNow()];
  try {
    await started;
    const second = await ask(r, 'home-s1', '第二项测试任务，应在首项还在开会话时收到');
    r.clock.now += 10000;
    ticks.push(r.company.tick());
    await new Promise(resolve => setImmediate(resolve));
    assert.ok(r.company.thread(second.thread), '创建会话的等待不能挡住收件检查');
    assert.equal(calls, 1, '并发 tick 共用一次派发');
  } finally { release(); await Promise.all(ticks); }
  assert.equal(r.cs.sent.filter(x => x.text.includes(first.thread)).length, 1);
});

test('家里投递回执慢时仍每 10 秒收其他回执，不重复唤醒会话', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const first = await ask(r, 'home-s1', '第一项测试任务，模拟回执投递很慢');
  const second = await ask(r, 'home-s1', '第二项测试任务，需独立收取新回执');
  await r.company.checkNow();
  r.cs.answer(r.company.thread(first.thread).sessionId, '第一项已完成');
  await r.company.tick();
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const blocked = new Promise(resolve => { release = resolve; });
  const send = r.home.deps.sendPrompt;
  let calls = 0;
  r.home.deps.sendPrompt = async (...args) => { calls++; entered(); await blocked; return send(...args); };
  const ticks = [r.home.checkNow()];
  try {
    await started;
    r.cs.answer(r.company.thread(second.thread).sessionId, '第二项已完成');
    await r.company.tick();
    r.clock.now += 10000;
    ticks.push(r.home.tick());
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(r.home.thread(second.thread).rounds[0].reply, '第二项已完成');
    assert.equal(calls, 1, '同一轮回执只有一个投递者');
  } finally { release(); await Promise.all(ticks); }
  await r.home.tick();
  assert.equal(r.hs.sent.length, 2);
});

test('只有上传失败时保留待发提示，不因收件成功而误报回执已发出', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const { thread } = await ask(r, 'home-s1', '请验证网络只允许收件、不允许上传时的提示');
  await r.company.checkNow();
  r.company.link.fetchImpl = async (url, init = {}) => {
    if (init.method === 'POST') throw new Error('POST-only failure');
    return r.relay.fetch(url, init);
  };
  r.cs.answer(r.company.thread(thread).sessionId, '回执已生成，但等待上传。');
  await r.company.tick();
  r.clock.now += 10000;
  await r.company.tick();
  assert.match(r.company.status().net.lastError?.message || '', /POST-only/);
  assert.equal(r.company.status().link.outbox, 1);
  assert.ok(r.notices.some(n => n.title.includes('回执待发送')));
  assert.ok(!r.notices.some(n => n.title.includes('已回执')));
  r.company.link.fetchImpl = r.relay.fetch;
  r.clock.now += 10000;
  await r.company.tick();
  assert.equal(r.company.status().net.lastError, null);
  assert.equal(r.company.status().link.outbox, 0);
  await r.home.checkNow();
  assert.equal(r.hs.sent.length, 1);
});

test('首问响应晚到时按本次检查的起点收紧到 10 秒，不错过下个定时刻度', async t => {
  const r = rig(t);
  await pair(r);
  r.company.setSettings({ enabled: false });
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle' });
  const first = await ask(r, 'home-s1', '第一项测试，模拟收件响应晚了一毫秒');
  const begin = r.clock.now;
  r.company.link.fetchImpl = async (url, init = {}) => {
    if (!init.method || init.method === 'GET') r.clock.now += 1;
    return r.relay.fetch(url, init);
  };
  await r.company.checkNow();
  assert.ok(r.company.thread(first.thread));
  assert.equal(r.company.nextPullAt, begin + 10000);
  const second = await ask(r, 'home-s1', '第二项测试，应在下一次十秒检查收到');
  r.clock.now = begin + 10000;
  await r.company.tick();
  assert.ok(r.company.thread(second.thread));
});

// 2026-10-16 设计第一步：家里补收（recollect_company）和「发问方还在活动」报告，走真实的两端通道（假中转）。
test('补收：一轮报没答上后，家里请公司取回最新回答，作为新回执送回提问会话；正常回执的轮次不能补收', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle', title: '场景配置' });
  r.hs.map.set('other', { id: 'other', kind: 'codex', status: 'idle' });
  const asked = await ask(r, 'home-s1', '## 目的\n查 7 站场景配置\n## 问题\n1. 站间距多少？', '场景配置');
  await r.company.checkNow();
  const companySession = r.cs.created[0].opts.id;
  // 公司那边判没答上（例如回执核对不上），但会话里其实写好了回答
  const ct = r.company.thread(asked.thread);
  r.company.failRound(ct, ct.rounds[0], '会话停下了，但一直没读到回答');
  r.cs.finals.set(companySession, [{ id: 'f1', text: '站间距 500 m，下倾 6°。把握程度：高', timestamp: r.clock.now }]);
  await r.company.checkNow();
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, /没答上/);
  await assert.rejects(r.home.invoke({ name: 'recollect_company', callerSessionId: 'other', arguments: { thread: asked.thread } }), /另一个会话|找不到/);
  const res = await r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread } });
  assert.equal(res.status, '已请公司补收');
  await r.company.checkNow();
  await r.home.checkNow();
  assert.match(r.hs.sent.at(-1).text, new RegExp(`【公司回执 ${asked.thread} · 第 1 轮】`));
  assert.match(r.hs.sent.at(-1).text, /补收/);
  assert.match(r.hs.sent.at(-1).text, /站间距 500 m/);
  await assert.rejects(r.home.invoke({ name: 'recollect_company', callerSessionId: 'home-s1', arguments: { thread: asked.thread } }), /正常回执/);
});

test('家里报「发问方还在活动」：集合变了才立刻报，没变 10 分钟内不重复；公司据此记下', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('home-s1', { id: 'home-s1', kind: 'codex', status: 'idle', title: 'x', lastMessageTime: r.clock.now });
  const asked = await ask(r, 'home-s1', '## 目的\n问一件事\n## 问题\n1. 是什么？', '问一件事');
  const posts = () => r.relay.posts;
  await r.home.checkNow();
  await r.company.checkNow();
  assert.deepEqual(r.company.store.get('askerActive').threads, [asked.thread]);
  const before = posts();
  await r.home.reportAskers();
  assert.equal(posts(), before, '集合没变、10 分钟内不重复报');
  r.hs.map.get('home-s1').lastMessageTime = r.clock.now - 60 * 60000;
  await r.home.reportAskers();
  assert.equal(posts(), before + 1, '发问方不活跃了：集合变了立刻报');
  await r.company.checkNow();
  assert.deepEqual(r.company.store.get('askerActive').threads, []);
});
