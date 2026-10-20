'use strict';
// 配对号牌、交接跟人走、通行证（2026-10-20，家里一端相关，不进公司版导出）：
// 1. 家里提问带短码和模型，公司会话名是号牌，公司回传会话名 / 号 / 模型；老家里、老公司两个方向都兼容；换号重做加「· 重做 N」。
// 5. 引用旧会话：旧会话已关 → 编号转给新会话并记日志；还开着 → 不转，追问被拒时说清编号属于哪个会话，关掉后再转。
// 6. 引用会话开的新会话起名（续）。
// 7. 通行证发给所有跑 Claude Code / Codex CLI 的会话；本机密钥不落盘、旧值删掉；新会话不继承 Hub 进程里的 HUB_BRIDGE_*。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHmac } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { rig, pair } = require('./helpers/company-bridge-rig');
const plate = require('../core/company-bridge/pairing-plate');

const ask = (r, sid, question, title) => r.home.invoke({ name: 'ask_company', callerSessionId: sid, arguments: { question, ...(title ? { title } : {}) } });
const tmpDir = (t, prefix) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

test('号牌往返：家里带短码和模型 → 公司会话名是号牌 → 公司回传会话名，家里状态里有 companyPlate', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('a1b2-home', { id: 'a1b2-home', kind: 'deepseek-claude', status: 'idle', title: '无线调度遗忘因子核对', currentModel: { id: 'deepseek-v4-pro' } });
  const sent = [];
  const rawSend = r.home.link.send.bind(r.home.link);
  r.home.link.send = (type, payload, ...rest) => { sent.push({ type, payload }); return rawSend(type, payload, ...rest); };
  const asked = await ask(r, 'a1b2-home', '## 目的\n核对遗忘因子\n## 问题\n1. 取值多少？', '遗忘因子');
  const askMsg = sent.find(x => x.type === 'ask');
  assert.deepEqual(askMsg.payload.from, { title: '无线调度遗忘因子核对', kind: 'deepseek-claude', code: 'a1b2', model: 'DeepSeek' });
  const n = Number(asked.thread.slice(-2));
  const want = `Q${n} · 家「无线调度遗忘因子核对 #a1b2」· DeepSeek`;
  assert.equal(r.home.thread(asked.thread).plate, want, '家里按同一规则推算出公司会话名');
  await r.company.checkNow();
  assert.equal(r.cs.created[0].opts.title, want);
  assert.deepEqual(r.company.thread(asked.thread).from, askMsg.payload.from, '公司原样存下 from（含新字段）');
  // 公司状态：pairing 里有会话名
  const cst = r.company.status().threads.find(x => x.id === asked.thread);
  assert.equal(cst.pairing.sessionTitle, want);
  // 家里收到 status：t.company 记下公司回传的会话名
  await r.home.checkNow();
  assert.equal(r.home.thread(asked.thread).company.sessionTitle, want);
  const sid = r.cs.created[0].opts.id;
  r.cs.answer(sid, '## 结论\n取 0.01。\n把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  const st = r.home.status().threads.find(x => x.id === asked.thread);
  assert.equal(st.companyPlate, want);
  assert.equal(st.session.code, 'a1b2');
  assert.match(r.hs.sent.at(-1).text, new RegExp(`^【公司回执 ${asked.thread} · 第 1 轮 · 题：遗忘因子】`));
  assert.match(plate.companyPairText(st), /^→ 公司 .*会话 Q\d+ · 家「无线调度遗忘因子核对 #a1b2」· DeepSeek$/);
});

test('兼容：老家里不带短码 → 公司仍起旧名 MMDD-Qn-家里AI；老公司不回传会话名 → 家里用自己推算的号牌', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle', title: '会话甲' });
  // 老家里：from 只有 title / kind
  const rawSend = r.home.link.send.bind(r.home.link);
  r.home.link.send = (type, payload, ...rest) => rawSend(type, type === 'ask' ? { ...payload, from: { title: payload.from.title, kind: payload.from.kind } } : payload, ...rest);
  // 老公司：status / reply 不带 pairing
  r.company.withPairing = (type, payload) => payload;
  const asked = await ask(r, 'h', '## 目的\n兼容性核对\n## 问题\n1. 能收到吗？');
  await r.company.checkNow();
  const m = /^Q-(\d{4})-(\d+)$/.exec(asked.thread);
  assert.equal(r.cs.created[0].opts.title, `${m[1]}-Q${Number(m[2])}-codex`);
  r.cs.answer(r.cs.created[0].opts.id, '能。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  const st = r.home.status().threads.find(x => x.id === asked.thread);
  assert.equal(st.company, undefined, '老公司没回传，家里不编');
  assert.equal(st.companyPlate, r.home.thread(asked.thread).plate);
  assert.match(st.companyPlate, /^Q\d+ · 家「会话甲 #h」· Codex$/);
  assert.match(r.hs.sent.at(-1).text, /能。/);
});

test('换号重做：新开的公司会话名加「· 重做 2」，不再出现两个同名会话', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('h', { id: 'h', kind: 'codex', status: 'idle', title: '会话甲' });
  const asked = await ask(r, 'h', '## 目的\n换号核对\n## 问题\n1. 新会话叫什么？');
  await r.company.checkNow();
  const first = r.cs.created[0].opts.title;
  assert.match(first, /^Q\d+ · 家「会话甲 #h」· Codex$/);
  const th = r.company.thread(asked.thread);
  r.company.rehome(th, th.rounds[0], { why: '测试换号', fromKey: 'personal' });
  assert.equal(r.company.thread(asked.thread).redoCount, 1);
  await r.company.checkNow();
  await r.company.checkNow();
  assert.equal(r.cs.created.length, 2, '换号后新开了一个会话');
  assert.equal(r.cs.created[1].opts.title, first + ' · 重做 2');
});

test('交接跟人走：旧会话已关 → 编号转给新会话，回执和追问都归新会话，写交接日志', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('old1', { id: 'old1', kind: 'codex', status: 'idle', title: '旧会话' });
  const asked = await ask(r, 'old1', '## 目的\n交接核对\n## 问题\n1. 第一轮？');
  await r.company.checkNow();
  const sid = r.cs.created[0].opts.id;
  r.cs.answer(sid, '第一轮答。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  assert.equal(r.hs.sentTo('old1').length, 1);
  // 关掉旧会话（记录还在 Hub 里），用【引用会话】新开一个
  r.hs.stored.set('old1', r.hs.map.get('old1')); r.hs.map.delete('old1');
  r.hs.map.set('new1', { id: 'new1', kind: 'claude', status: 'idle', title: '旧会话（续）' });
  const out = r.home.handoff('new1', 'old1', { why: '引用会话「旧会话」' });
  assert.deepEqual(out.moved, [asked.thread]);
  const moved = r.home.thread(asked.thread);
  assert.equal(moved.sessionId, 'new1');
  assert.equal(moved.code, 'new1');
  assert.equal(moved.transferredFrom.length, 1);
  assert.equal(moved.transferredFrom[0].label, '旧会话 #old1');
  assert.match(fs.readFileSync(path.join(r.home.dir, 'handoff.log'), 'utf8'), /"event":"moved","from":"old1","to":"new1"/);
  assert.ok(r.notices.some(n => /编号转到新会话/.test(n.title)));
  // 新会话里能追问，回执送到新会话
  await r.home.invoke({ name: 'followup_company', callerSessionId: 'new1', arguments: { thread: asked.thread, question: '第二轮追问' } });
  await r.company.checkNow();
  r.cs.answer(sid, '第二轮答。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  assert.match(r.hs.sentTo('new1').at(-1).text, /第 2 轮/);
  assert.equal(r.hs.sentTo('old1').length, 1, '旧会话不再收回执');
  const view = await r.home.invoke({ name: 'company_thread', callerSessionId: 'new1', arguments: { thread: asked.thread } });
  assert.deepEqual(view.threads[0].transferredFrom, ['旧会话 #old1']);
  // 没有交接关系的会话照旧被拒
  r.hs.map.set('other', { id: 'other', kind: 'codex', status: 'idle' });
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'other', arguments: { thread: asked.thread, question: '再看看' } }), /这个编号属于另一个会话「旧会话（续） #new1」/);
});

test('交接跟人走：旧会话还开着 → 不转；新会话追问被拒并说明编号属于谁；旧会话关掉后再追问就转过来', async t => {
  const r = rig(t);
  await pair(r);
  r.hs.map.set('old2', { id: 'old2', kind: 'codex', status: 'idle', title: '还开着的会话' });
  const asked = await ask(r, 'old2', '## 目的\n交接核对\n## 问题\n1. 第一轮？');
  await r.company.checkNow();
  r.cs.answer(r.cs.created[0].opts.id, '第一轮答。把握程度：高');
  await r.company.checkNow();
  await r.home.checkNow();
  r.hs.map.set('new2', { id: 'new2', kind: 'codex', status: 'idle', title: '新会话' });
  const out = r.home.handoff('new2', 'old2', { why: '引用会话「还开着的会话」' });
  assert.deepEqual(out, { moved: [], pending: 1 });
  assert.equal(r.home.thread(asked.thread).sessionId, 'old2', '不转');
  await assert.rejects(r.home.invoke({ name: 'followup_company', callerSessionId: 'new2', arguments: { thread: asked.thread, question: '在新会话追问' } }),
    err => /这个编号属于另一个会话「还开着的会话 #old2」/.test(err.message) && /关掉它之后在这里再试一次/.test(err.message));
  await assert.rejects(r.home.invoke({ name: 'company_thread', callerSessionId: 'new2', arguments: { thread: asked.thread } }), /找不到本会话的编号 .*还开着的会话 #old2/);
  // 关掉旧会话后再追问：这时转过来
  r.hs.map.delete('old2');
  const res = await r.home.invoke({ name: 'followup_company', callerSessionId: 'new2', arguments: { thread: asked.thread, question: '在新会话追问' } });
  assert.equal(res.round, 2);
  assert.equal(r.home.thread(asked.thread).sessionId, 'new2');
  const log = fs.readFileSync(path.join(r.home.dir, 'handoff.log'), 'utf8').trim().split('\n').map(x => JSON.parse(x));
  assert.deepEqual(log.map(x => x.event), ['pending', 'moved']);
  assert.deepEqual(log[1].threads, [asked.thread]);
  // 同一会话自己引用自己、空参数：什么也不做
  assert.deepEqual(r.home.handoff('new2', 'new2'), { moved: [] });
  assert.deepEqual(r.home.handoff('', 'x'), { moved: [] });
});

test('引用会话的交接入口：先认 Hub 解析过的路径，Hub 重启后读 md 头部；聊天记录目录以外的文件不读；一分钟内同一对只转一次', t => {
  const { createReferenceHandoff } = require('../main/reference-handoff');
  const dir = tmpDir(t, 'hub-ref-handoff-');
  const tdir = path.join(dir, 'transcripts');
  fs.mkdirSync(tdir);
  const md = path.join(tdir, 'old.md');
  fs.writeFileSync(md, '# 旧会话\n\n- Hub 会话：old-session-1\n- 种类：Codex\n\n正文');
  const outside = path.join(dir, 'outside.md');
  fs.writeFileSync(outside, '- Hub 会话：forged\n');
  const calls = [];
  let clock = 1000;
  const bridge = { handoff: (to, from, opts) => { calls.push({ to, from, why: opts.why }); return { moved: ['Q-1020-01'] }; } };
  const h = createReferenceHandoff({ getTranscriptDir: () => tdir, getBridge: () => bridge, now: () => clock });
  assert.equal(h.sourceOf(md), 'old-session-1');
  assert.equal(h.sourceOf(outside), null, '目录外的文件不读');
  assert.equal(h.sourceOf(path.join(tdir, 'missing.md')), null);
  h.noteResolved(outside, 'resolved-id');
  assert.equal(h.sourceOf(outside), 'resolved-id', 'Hub 自己解析过的路径直接认');
  const { buildReferenceText } = require('../core/session-reference');
  const text = buildReferenceText({ title: '旧会话', kind: 'codex', path: md }) + '\n\n接着做';
  assert.deepEqual(h.onPrompt({ hubSessionId: 'new-1', text }), [{ source: 'old-session-1', moved: ['Q-1020-01'] }]);
  assert.deepEqual(calls, [{ to: 'new-1', from: 'old-session-1', why: '引用会话「旧会话」' }]);
  assert.deepEqual(h.onPrompt({ hubSessionId: 'new-1', text }), [], 'hook 和原生记录各报一次：只处理一次');
  clock += 61000;
  assert.equal(h.onPrompt({ hubSessionId: 'new-1', text }).length, 1);
  assert.deepEqual(h.onPrompt({ hubSessionId: 'old-session-1', text }), [], '引用自己不转');
  assert.deepEqual(h.onPrompt({ hubSessionId: 'new-1', text: '没有引用' }), []);
  const noBridge = createReferenceHandoff({ getTranscriptDir: () => tdir, getBridge: () => null });
  assert.deepEqual(noBridge.onPrompt({ hubSessionId: 'new-1', text }), [], '公司版（没有家里一端）什么也不做');
});

test('引用会话开的新会话：标题直接起「旧标题（续）」，不调模型；已是（续）的递增', async t => {
  const https = require('node:https');
  const { ALL_AI_KINDS, KIND_LABELS } = require('../core/ai-kinds');
  const { createAutoTitleManager } = require('../main/auto-title-manager');
  const { buildReferenceText } = require('../core/session-reference');
  const original = https.request;
  const requests = [];
  https.request = (options, callback) => { const req = new EventEmitter(); req.write = () => {}; req.end = () => requests.push(options); return req; };
  t.after(() => { https.request = original; });
  const sessions = new Map();
  const manager = createAutoTitleManager({
    allAiKinds: ALL_AI_KINDS, kindLabels: KIND_LABELS, getHubConfig: () => ({ deepseekApiKey: 'test-key' }),
    sessionManager: { getSession: id => sessions.get(id), getAllSessions: () => [...sessions.values()],
      updateSessionMeta: (id, patch) => { const s = sessions.get(id); Object.assign(s, patch); return s; } },
    sendToRenderer() {}, meetingManager: {},
  });
  sessions.set('src', { id: 'src', kind: 'codex', title: '调度核对', autoTitleGenerated: true });
  sessions.set('n1', { id: 'n1', kind: 'codex', title: 'Codex 1' });
  manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: 'n1', text: buildReferenceText({ title: '调度核对', kind: 'codex', path: 'D:/x/a.md' }) + '\n\n接着做' });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sessions.get('n1').title, '调度核对（续）');
  sessions.set('n2', { id: 'n2', kind: 'claude', title: 'Claude 1' });
  manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: 'n2', text: buildReferenceText({ title: '调度核对（续）', kind: 'codex', path: 'D:/x/b.md' }) });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(sessions.get('n2').title, '调度核对（续2）');
  assert.equal(requests.length, 0, '续写标题不调模型');
  // 引用行不在开头（用户先写了话）：照常走模型起标题
  sessions.set('n3', { id: 'n3', kind: 'codex', title: 'Codex 2' });
  manager.maybeAutoTitleSessionFromPrompt({ hubSessionId: 'n3', text: '先看一下这个\n' + buildReferenceText({ title: '调度核对', kind: 'codex', path: 'D:/x/a.md' }) });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(requests.length, 1);
});

test('通行证：所有跑 Claude Code / Codex CLI 的会话都发，别家命令行不发', async t => {
  const r = rig(t);
  await pair(r);
  for (const kind of ['claude', 'claude-resume', 'deepseek-claude', 'deepseek-claude-resume', 'deepseek-legacy', 'codeagent', 'codeagent-resume', 'codex', 'codex-resume', 'deepseek', 'deepseek-resume']) {
    const plan = r.home.sessionPlan({ kind, opts: {}, id: 'id-' + kind });
    assert.ok(plan, kind + ' 该发通行证');
    assert.equal(plan.env.HUB_BRIDGE_SESSION_ID, 'id-' + kind);
    assert.equal(plan.env.HUB_BRIDGE_SESSION_PASS, r.home.passFor('id-' + kind));
  }
  for (const kind of ['gemini', 'kimi', 'glm', 'qwen', 'powershell']) assert.equal(r.home.sessionPlan({ kind, opts: {}, id: 'x' }), null, kind + ' 不发');
  assert.equal(r.home.wantsMcp({ kind: 'deepseek-claude', opts: { cwd: 'D:/code/superran' } }), true);
  assert.equal(r.home.wantsMcp({ kind: 'gemini', opts: { cwd: 'D:/code/superran' } }), false);
  // 会话管理器：跑在 Claude Code 上的 DeepSeek 也把 MCP 并进 --mcp-config
  const { SessionManager } = require('../core/session-manager');
  const dataDir = tmpDir(t, 'hub-pairing-mcp-');
  const old = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old; });
  const sm = Object.create(SessionManager.prototype);
  sm.setExtraMcpProvider(p => r.home.sessionPlan(p));
  const existing = path.join(dataDir, 'meeting.json');
  fs.writeFileSync(existing, JSON.stringify({ mcpServers: { hub_meeting: { command: 'node', args: ['m.js'] } } }));
  for (const kind of ['deepseek-claude', 'deepseek-legacy', 'claude']) {
    const opts = sm._withExtraMcp(kind, { id: 's-' + kind, cwd: 'D:/code/superran', mcpConfigFile: existing });
    assert.notEqual(opts.mcpConfigFile, existing, kind);
    const merged = JSON.parse(fs.readFileSync(opts.mcpConfigFile, 'utf8'));
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['company_bridge', 'hub_meeting'], kind);
    assert.equal(opts.extraEnv.HUB_BRIDGE_SESSION_ID, 's-' + kind);
  }
  const gem = sm._withExtraMcp('gemini', { id: 'g', cwd: 'D:/code/superran' });
  assert.equal(gem.extraEnv, undefined);
  assert.equal(gem.mcpConfigFile, undefined);
});

test('本机密钥：只在内存里，不写进 assistant.sqlite；老版本留下的明文旧值启动时删掉；测试密钥只在隔离测试实例里认', t => {
  const { HomeBridge } = require('../core/company-bridge/home');
  const { DatabaseSync } = require('node:sqlite');
  const root = tmpDir(t, 'hub-pairing-master-');
  const deps = { dataDir: root, noTimer: true, fetchImpl: async () => { throw new Error('offline'); }, getSession: () => null };
  const dbFile = path.join(root, 'company-bridge', 'assistant.sqlite');
  const legacy = 'ab'.repeat(32);
  let home = new HomeBridge(deps);
  const pass1 = home.passFor('s');
  home.close();
  const read = () => { const db = new DatabaseSync(dbFile); try { return db.prepare("SELECT value FROM meta WHERE key='localMaster'").get(); } finally { db.close(); } };
  assert.equal(read(), undefined, '新版不落盘');
  { const db = new DatabaseSync(dbFile); db.prepare('INSERT INTO meta VALUES(?,?)').run('localMaster', JSON.stringify(legacy)); db.close(); }
  home = new HomeBridge(deps);
  assert.equal(read(), undefined, '老版本留下的旧值删掉');
  assert.notEqual(home.passFor('s'), createHmac('sha256', legacy).update('session:s').digest('hex'), '不再用旧值');
  assert.notEqual(home.passFor('s'), pass1, '每次启动重新生成');
  home.close();
  assert.ok(!fs.readFileSync(dbFile).includes(Buffer.from(legacy)), '库文件里不留旧值残迹');
  // 测试密钥：CLAUDE_HUB_E2E=1 且指定数据目录才认
  const keys = ['CLAUDE_HUB_E2E', 'CLAUDE_HUB_DATA_DIR', 'CLAUDE_HUB_E2E_BRIDGE_MASTER'];
  const saved = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  t.after(() => { for (const k of keys) if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; });
  const testKey = 'cd'.repeat(32), expect = createHmac('sha256', testKey).update('session:s').digest('hex');
  process.env.CLAUDE_HUB_E2E_BRIDGE_MASTER = testKey; delete process.env.CLAUDE_HUB_E2E; delete process.env.CLAUDE_HUB_DATA_DIR;
  home = new HomeBridge(deps); assert.notEqual(home.passFor('s'), expect, '正式运行不认测试密钥'); home.close();
  process.env.CLAUDE_HUB_E2E = '1'; process.env.CLAUDE_HUB_DATA_DIR = root;
  home = new HomeBridge(deps); assert.equal(home.passFor('s'), expect, '隔离测试实例认'); home.close();
  process.env.CLAUDE_HUB_E2E_BRIDGE_MASTER = 'short';
  home = new HomeBridge(deps); assert.notEqual(home.passFor('s'), createHmac('sha256', 'short').update('session:s').digest('hex'), '太短的不认'); home.close();
});

test('新会话不继承 Hub 进程里的 HUB_BRIDGE_*：先剥掉，再按会话注入自己的通行证', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const strip = src.indexOf("if (/^HUB_BRIDGE_/i.test(key)) delete sessionEnv[key]");
  const copy = src.indexOf('const sessionEnv = { ...process.env };');
  const inject = src.indexOf('Object.assign(sessionEnv, opts.extraEnv);');
  assert.ok(copy > 0 && strip > copy, '复制进程环境之后马上剥掉');
  assert.ok(inject > strip, '会话自己的通行证（extraEnv）在剥掉之后才注入');
});
