'use strict';
// 公司助理「会话工具」接通（v3.1.1，2026-10-22）：田哥让助理查会话运行状态，助理说「获取不到」。
//   1. 本机接口还没开始监听时建的助理会话，也要挂上 hub_sessions（以前要求接口地址已有，先建的会话整场都没有工具，且没有提示）；
//   2. 接口文件缺失、连不上、口令已换时，mcp.js 返回 isError 和一句人话，进程不退出；
//   3. mcp.js 握手后发 __hello，Hub 按会话记下时间；会话起来满 90 秒还没收到就判「未接上」，并给出原因猜测；
//   4. 新建、恢复（手机消息唤醒）、重开三条路径真正经过 SessionManager._withExtraMcp，配置文件里都有 hub_sessions。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { CompanyAssistant, TOOLS_HELLO_GRACE_MS, TOOLS_VERSION } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');

const MCP = path.join(__dirname, '..', 'core', 'company-assistant', 'mcp.js');
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'company-tools-link-'));
const wait = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await wait(20); } throw new Error('timeout: ' + label); };

function rig({ dir = tmp(), clock = null, extra = {} } = {}) {
  const sessions = new Map(), sent = [];
  const deps = {
    dataDir: dir, noTimer: true, nodeExecutable: process.execPath, bus: new NoticeBus(),
    ...(clock ? { now: () => clock.t } : {}),
    welinkRun: async () => ({ code: 1, stdout: '', stderr: 'welink 不在本测试范围' }),
    createSession: async (kind, opts) => { sessions.set(opts.id, { id: opts.id, kind, ...opts, status: 'idle' }); return { id: opts.id }; },
    sendPrompt: async (id, text) => { sent.push({ id, text }); return { ok: true }; },
    getSession: id => sessions.get(id) || null,
    getSessionMetadata: id => sessions.get(id) || null,
    getAllSessions: () => [...sessions.values()],
    listKnownSessions: () => [],
    resumeSession: async () => null,
    isAgentTurnActive: () => false,
    readFinals: () => [],
    ...extra,
  };
  return { dir, sessions, sent, svc: new CompanyAssistant(deps) };
}

// 起一个 mcp.js（和 CodeAgent 起它的方式一样：Node 方式运行、环境变量给接口文件和会话编号），按行收发 JSON-RPC。
function mcpProcess(env) {
  const child = spawn(process.execPath, [MCP], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  let buf = '', stderr = ''; const replies = new Map();
  child.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); replies.set(m.id, m); } });
  child.stderr.on('data', d => { stderr += d; });
  let next = 1;
  const ask = async (method, params = {}) => { const id = next++; child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); await until(() => replies.has(id), method, 30000); return replies.get(id); };
  return { child, ask, stderr: () => stderr, close: () => child.kill() };
}
const closedPort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('本机接口还没开始监听：助理会话照样挂上 hub_sessions，其他会话不挂', () => {
  const r = rig();
  assert.equal(r.svc.tools.bridge.url, undefined, '前提：工具服务还没开始监听');
  const plan = r.svc.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-assistant', id: 'early' } });
  assert.equal(plan.mcp.name, 'hub_sessions');
  assert.equal(plan.mcp.env.HUB_COMPANY_ASSISTANT_SESSION_ID, 'early');
  assert.equal(plan.mcp.env.HUB_COMPANY_TOOLS_ENDPOINT, r.svc.tools.endpointFile, '挂载只要接口文件路径，调用时才读');
  assert.equal(r.svc.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-forum', id: 'x' } }), null);
  assert.equal(r.svc.sessionPlan({ kind: 'codeagent', opts: { id: 'x' } }), null);
  const off = new CompanyAssistant({ ...rig().svc.deps, noTools: true });
  assert.equal(off.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-assistant', id: 'y' } }), null, '没有会话工具的 Hub 不挂');
});

test('接口文件缺失、连不上、口令已换：工具返回 isError 和人话，MCP 进程不退出', async t => {
  const dir = tmp();
  const missing = mcpProcess({ HUB_COMPANY_TOOLS_ENDPOINT: path.join(dir, '没有这个文件.json'), HUB_COMPANY_ASSISTANT_SESSION_ID: 's1' });
  t.after(missing.close);
  assert.equal((await missing.ask('initialize', { protocolVersion: '2024-11-05' })).result.serverInfo.name, 'hub-sessions', '握手不受接口缺失影响');
  assert.ok((await missing.ask('tools/list')).result.tools.some(x => x.name === 'list_sessions'));
  const r1 = (await missing.ask('tools/call', { name: 'list_sessions', arguments: {} })).result;
  assert.equal(r1.isError, true);
  const body = JSON.parse(r1.content[0].text);
  assert.match(body.error, /Hub 会话工具还没准备好或 Hub 刚重启，请稍后重试；仍不行请在助理页点『重开助理会话』/);
  assert.match(body.detail, /接口文件读不出来/);
  assert.deepEqual((await missing.ask('ping')).result, {}, '报错后进程还在，继续应答');
  assert.equal(missing.child.exitCode, null);

  const port = await closedPort();
  const endpoint = path.join(dir, 'closed.json');
  fs.writeFileSync(endpoint, JSON.stringify({ url: `http://127.0.0.1:${port}/tool`, token: 'x' }));
  const closed = mcpProcess({ HUB_COMPANY_TOOLS_ENDPOINT: endpoint, HUB_COMPANY_ASSISTANT_SESSION_ID: 's1' });
  t.after(closed.close);
  const r2 = (await closed.ask('tools/call', { name: 'read_session', arguments: { sessionId: 'a' } })).result;
  assert.equal(r2.isError, true);
  assert.match(JSON.parse(r2.content[0].text).error, /重开助理会话/);
  assert.match(JSON.parse(r2.content[0].text).detail, /连不上 Hub 的本机接口/);
  assert.deepEqual((await closed.ask('ping')).result, {});

  // Hub 重启后旧口令作废：接口回 403、没有正文
  const r = rig({ dir: tmp() });
  await r.svc.tools.start(); t.after(() => r.svc.close());
  const stale = path.join(dir, 'stale.json');
  fs.writeFileSync(stale, JSON.stringify({ url: r.svc.tools.bridge.url, token: 'old-token' }));
  const old = mcpProcess({ HUB_COMPANY_TOOLS_ENDPOINT: stale, HUB_COMPANY_ASSISTANT_SESSION_ID: 's1' });
  t.after(old.close);
  const r3 = (await old.ask('tools/call', { name: 'list_sessions', arguments: {} })).result;
  assert.equal(r3.isError, true);
  assert.match(JSON.parse(r3.content[0].text).detail, /HTTP 403/);
  assert.deepEqual((await old.ask('ping')).result, {});
  for (const p of [missing, closed, old]) assert.equal(p.child.exitCode, null, '三种情况进程都还在');
});

test('接通信号：握手后发 __hello，Hub 记下时间；起来满 90 秒没收到判「未接上」并给原因；重启后要重新收到才算接上', async t => {
  const T = 1_800_000_000_000, clock = { t: T };
  const r = rig({ clock });
  r.svc.start(); t.after(() => r.svc.close());
  await r.svc.toolsReady;
  assert.equal(r.svc.toolsStatus().state, 'closed', '还没有助理会话');
  const sid = 'assistant-1';
  r.svc.saveState({ sessionId: sid, toolsVersion: TOOLS_VERSION });
  r.sessions.set(sid, { id: sid, kind: 'codeagent', purpose: 'company-assistant', status: 'idle', createdAt: T });
  clock.t = T + 10_000;
  assert.equal(r.svc.toolsStatus().state, 'starting');
  assert.equal(r.svc.toolsStatus().checkAt, T + TOOLS_HELLO_GRACE_MS, '界面据此到点重取状态');
  clock.t = T + TOOLS_HELLO_GRACE_MS - 1;
  assert.equal(r.svc.toolsStatus().state, 'starting', '89.999 秒还在等');
  clock.t = T + TOOLS_HELLO_GRACE_MS;
  const missing = r.svc.toolsStatus();
  assert.equal(TOOLS_HELLO_GRACE_MS, 90000);
  assert.equal(missing.state, 'missing', '满 90 秒没收到接通信号：未接上');
  assert.match(missing.reason, /没有挂上会话工具/, '这个会话的配置文件里没有 hub_sessions，原因猜到挂载上');
  // 配置文件里有了（启动时挂上了），原因换成「工具进程没找到 Hub」
  fs.mkdirSync(path.join(r.dir, 'extra-mcp'), { recursive: true });
  fs.writeFileSync(path.join(r.dir, 'extra-mcp', `codeagent-${sid}.json`), JSON.stringify({ mcpServers: { hub_sessions: r.svc.tools.mcpEntry(sid) } }));
  assert.match(r.svc.toolsStatus().reason, /没有启动会话工具进程/);

  // 真实的 mcp.js 握手 → __hello
  const changed = []; r.svc.deps.onChanged = () => changed.push(clock.t);
  const entry = r.svc.tools.mcpEntry(sid);
  const p = mcpProcess(entry.env); t.after(p.close);
  await p.ask('initialize', { protocolVersion: '2024-11-05' });
  await until(() => r.svc.tools.seenFor(sid), 'hello 到达 Hub');
  assert.equal(r.svc.tools.seenFor(sid).how, 'hello');
  assert.equal(r.svc.tools.seenFor(sid).at, clock.t, '按会话编号记下 toolsSeenAt');
  assert.ok(changed.length >= 1, '收到接通信号就通知界面刷新');
  const linked = r.svc.toolsStatus();
  assert.equal(linked.state, 'linked');
  assert.equal(linked.label, '已接上');
  assert.equal(r.svc.status().tools.state, 'linked', '助理页状态里带着');

  // 真实工具调用也更新时间，并记下工具名
  clock.t += 5000;
  const listed = (await p.ask('tools/call', { name: 'list_sessions', arguments: {} })).result;
  assert.equal(listed.isError, false);
  assert.equal(r.svc.tools.seenFor(sid).at, clock.t);
  assert.equal(r.svc.toolsStatus().lastTool, 'list_sessions');

  // 会话重启（createdAt 变新）：旧的接通记录不算，等新的工具进程报到
  r.sessions.get(sid).createdAt = clock.t + 1000; clock.t += 2000;
  assert.equal(r.svc.toolsStatus().state, 'starting');
  clock.t += TOOLS_HELLO_GRACE_MS;
  assert.equal(r.svc.toolsStatus().state, 'missing');
  // 别的编号发来的接通信号不会算到助理会话头上；没有编号的不记
  await r.svc.tools.invoke({ name: '__hello', callerSessionId: 'someone-else' });
  await r.svc.tools.invoke({ name: '__hello', callerSessionId: '' });
  assert.equal(r.svc.toolsStatus().state, 'missing');
  assert.equal(r.svc.tools.seenFor(''), null);
  // 会话休眠：不算未接上
  r.sessions.get(sid).status = 'dormant';
  assert.equal(r.svc.toolsStatus().state, 'closed');

  // 远程诊断：存在与否、是否在听、时间、编号；不带口令和端口
  const diag = r.svc.toolsDiag();
  assert.deepEqual(Object.keys(diag).sort(), ['bridgeListening', 'endpointExists', 'mcpConfigHasHubSessions', 'sessionId', 'toolsSeenAt']);
  assert.equal(diag.endpointExists, true); assert.equal(diag.bridgeListening, true); assert.equal(diag.mcpConfigHasHubSessions, true); assert.equal(diag.sessionId, sid);
  const text = JSON.stringify(diag), ep = JSON.parse(fs.readFileSync(r.svc.tools.endpointFile, 'utf8'));
  assert.ok(!text.includes(ep.token) && !text.includes(String(new URL(ep.url).port)), '诊断不带口令和端口');
});

test('远程诊断 features 段带 assistantTools（白名单字段）', () => {
  const diag = require('../core/company-bridge/diag');
  const features = diag.features;
  assert.equal(typeof features, 'function', '诊断模块导出 features');
  const out = features({ featureStatus: () => ({ forum: null, pet: null, assistant: { enabled: true, brief: null, phone: {},
    tools: { state: 'missing', endpointExists: true, bridgeListening: true, sessionId: 's1', open: true, since: 1, toolsSeenAt: null, mcpConfigHasHubSessions: false, reason: '助理会话启动时没有挂上会话工具', token: 'SECRET' } } }) });
  assert.deepEqual(out.assistantTools, { state: 'missing', endpointExists: true, bridgeListening: true, sessionId: 's1', sessionOpen: true, sessionStartedAt: 1, toolsSeenAt: null, mcpConfigHasHubSessions: false, reason: '助理会话启动时没有挂上会话工具' });
  assert.ok(!JSON.stringify(out).includes('SECRET'));
});

test('新建、恢复（手机消息唤醒）、重开：都经过 SessionManager._withExtraMcp，配置文件里都有 hub_sessions', async t => {
  const dataDir = tmp();
  // 公司版导出物里新建会话前先核对 CodeAgent CLI 在不在（community-provider.js）；这里不起 CLI，按测试约定放行
  const oldEnv = { CLAUDE_HUB_DATA_DIR: process.env.CLAUDE_HUB_DATA_DIR, CLAUDE_HUB_E2E_ALLOW_MISSING_CLI: process.env.CLAUDE_HUB_E2E_ALLOW_MISSING_CLI };
  Object.assign(process.env, { CLAUDE_HUB_DATA_DIR: dataDir, CLAUDE_HUB_E2E_ALLOW_MISSING_CLI: '1' });
  t.after(() => { for (const [k, v] of Object.entries(oldEnv)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } });
  // 真的 SessionManager（createSession → _withExtraMcp），只把起 PTY 那一步换成记录参数
  const { SessionManager } = require('../core/session-manager');
  const sm = Object.create(SessionManager.prototype);
  sm.sessions = new Map();
  const launches = [];
  let created = 0;
  sm._createSession = function (kind, opts) {
    launches.push({ kind, opts });
    const info = { id: opts.id, kind, title: opts.title, cwd: opts.cwd, purpose: opts.purpose, status: 'idle', createdAt: Date.now() + created++, ccSessionId: 'cc-' + opts.id };
    this.sessions.set(opts.id, { info });
    return { ...info };
  };
  // 恢复：Hub 现有的 resume 处理（main/ipc/resume-session-handlers.js），会话管理器用上面这个
  const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
  const resumeSession = createResumeSessionHandler({
    defaultCodexSessionsRoot: dataDir, findCodexRolloutBySid: () => null, findTranscriptByCCSessionId: () => null, fs: { readdirSync: () => [] },
    getHookPort: () => 3456, getHubDataDir: () => dataDir, hookToken: 'token', isClaudeFamily: k => ['claude', 'claude-resume'].includes(k),
    isClaudeWebKind: () => false, isCodexBaseKind: () => false, lookupKimiSession: () => null, meetingManager: { getMeeting: () => null },
    os: { homedir: () => dataDir }, path, readTranscriptTail: async () => null, registerSessionForTap: () => {}, scenes: {}, sendToRenderer: () => {},
    sessionManager: sm, slotIds: [], logger: { warn() {}, log() {} },
  });
  // 重开：和 main/ipc/session-handlers.js 的 restartSession 一样，休眠后按 buildSessionResumeMeta 恢复
  const { buildSessionResumeMeta } = require('../core/session-capabilities');
  const stored = new Map();
  const r = rig({ dir: dataDir, extra: {
    createSession: async (kind, opts) => { const s = sm.createSession(kind, opts); stored.set(s.id, { ...sm.getSession(s.id), hubId: s.id }); return s; },
    getSession: id => sm.getSession(id) || null,
    getSessionMetadata: id => stored.get(id) || null,
    resumeSession: async id => resumeSession({ ...stored.get(id), hubId: id }),
    restartSession: async id => { const old = sm.getSession(id); sm.sessions.delete(id); sm._releaseOpenSession(id); return resumeSession(buildSessionResumeMeta(old)); },
  } });
  // main.js 的提供者链：助理优先，其余交给家里联动
  sm.setExtraMcpProvider(request => r.svc.sessionPlan(request) || null);
  r.svc.start(); t.after(() => r.svc.close());
  // 关掉会话：和 Hub 关闭一样释放本 Hub 的打开归属，之后才能按原生身份恢复
  const closeIn = id => { sm.sessions.delete(id); sm._releaseOpenSession(id); };
  const mounted = id => { const f = path.join(dataDir, 'extra-mcp', `codeagent-${id}.json`); return fs.existsSync(f) && !!JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers?.hub_sessions; };
  const reset = id => fs.rmSync(path.join(dataDir, 'extra-mcp', `codeagent-${id}.json`), { force: true });

  // 新建：工具服务还没开始监听就建（直接走会话管理器，和启动时恢复一样不等工具服务）
  const early = sm.createSession('codeagent', { id: 'early-assistant', purpose: 'company-assistant', cwd: r.svc.workspace, title: '公司助理' });
  assert.ok(mounted(early.id), '先于工具服务建的助理会话也挂上了');
  assert.equal(launches.at(-1).opts.mcpConfigFile, path.join(dataDir, 'extra-mcp', 'codeagent-early-assistant.json'), '启动参数带上这份配置');
  // 新建：助理自己开会话（ensureSession）
  const sid = await r.svc.ensureSession();
  assert.ok(mounted(sid), '新建');
  assert.equal(r.svc.toolsDiag(sid).mcpConfigHasHubSessions, true);

  // 恢复（手机消息唤醒）：会话关着 → 手机来一句 → 排队 → ensureSession → 按原生身份恢复
  closeIn(sid); reset(sid);
  r.svc.ask('现在有哪些会话在跑？', { via: 'phone' });
  await until(() => r.sent.length === 1, '问题发进助理会话');
  assert.equal(r.sent[0].id, sid, '还是原来的助理会话');
  assert.equal(launches.at(-1).opts.purpose, 'company-assistant', '恢复时带着 purpose');
  assert.ok(mounted(sid), '恢复（手机消息唤醒）');

  // 重开：助理页按钮 → Hub 现有的重启
  reset(sid);
  const before = launches.length;
  const reopened = await r.svc.reopenSession();
  assert.deepEqual([reopened.ok, reopened.how, reopened.sessionId], [true, 'restart', sid]);
  assert.equal(launches.length, before + 1);
  assert.ok(mounted(sid), '重开');

  // 重开时会话关着：按原生身份恢复
  closeIn(sid); reset(sid);
  const resumed = await r.svc.reopenSession();
  assert.equal(resumed.how, 'resume');
  assert.ok(mounted(sid), '重开（会话关着）');

  // 重启失败（例如还没绑定原生身份）：换一个新的助理会话，同样挂上
  r.svc.deps.restartSession = async () => ({ ok: false, error: 'native-session-id-missing', message: '当前会话尚未绑定原生会话 ID' });
  const fresh = await r.svc.reopenSession();
  assert.equal(fresh.how, 'new');
  assert.notEqual(fresh.sessionId, sid);
  assert.equal(r.svc.state().sessionId, fresh.sessionId);
  assert.ok(mounted(fresh.sessionId), '重开（换新会话）');
});

test('说明文字写明具体工具名，以及工具缺失时怎么告诉用户', () => {
  const { INSTRUCTIONS } = require('../core/company-assistant/service');
  for (const name of ['list_sessions', 'read_session', 'send_session', 'create_session', 'watch_session', 'press_keys', 'stop_session']) assert.ok(INSTRUCTIONS.includes(name), name);
  assert.match(INSTRUCTIONS, /会话工具没接上，请在助理页点『重开助理会话』/);
  assert.match(INSTRUCTIONS, /hub_sessions/);
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(page, /'会话工具'/);
  assert.match(page, /data-ca="reopen-session">重开助理会话</);
  const ipc = fs.readFileSync(path.join(__dirname, '..', 'main', 'ipc', 'company-assistant-handlers.js'), 'utf8');
  assert.match(ipc, /'reopen-session': \(\) => service\.reopenSession\(\)/);
});
