'use strict';
// 「规则」页（2026-10-12）：通用规则的开关、检查更新、校验与回退；我的规则的保存；
// 随第一条消息送达与回执；导航顺序迁移。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { EventEmitter } = require('node:events');
const { createHubRulesStore, lineDiff, sha256 } = require('../core/hub-rules');

function tmp(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-rules-unit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// 假服务器：按 URL 返回预设的响应，记录请求。
function fakeServer(routes) {
  const calls = [];
  const fetchImpl = async url => {
    calls.push(url);
    const r = routes[url.replace(/^https:\/\/rules\.test\/hub-rules\//, '')];
    if (r instanceof Error) throw r;
    if (!r) return { ok: false, status: 404 };
    const body = typeof r === 'string' ? r : JSON.stringify(r);
    return { ok: true, status: 200, text: async () => body, arrayBuffer: async () => Buffer.from(body, 'utf8') };
  };
  return { fetchImpl, calls };
}
function latest(version, text, extra = {}) {
  return { schema: 1, channel: 'public', version, notes: `第 ${version} 版改动`, published_at: '2026-10-12T10:00:00+08:00', sha256: sha256(text), bytes: Buffer.byteLength(text), md: `v/${version}.md`, ...extra };
}
function store(t, extra = {}) {
  const root = tmp(t);
  const builtinFile = path.join(root, 'builtin.md');
  fs.writeFileSync(builtinFile, '# 内置规则\n- 第一条\n', 'utf8');
  const s = createHubRulesStore({ dataDir: path.join(root, 'data'), builtinFile, baseUrl: 'https://rules.test/hub-rules/', env: {}, loadPersonal: () => null, ...extra });
  return { root, s };
}

test('默认：内置 v1、开关默认开；手动关掉后不再注入，设置持久化', t => {
  const { s, root } = store(t);
  const snap = s.snapshot();
  assert.equal(snap.official.version, 1);
  assert.equal(snap.official.source, 'builtin');
  assert.equal(snap.official.enabled, true);
  assert.equal(snap.official.enabledIsDefault, true);
  assert.match(s.injection().content, /内置规则/);
  s.setEnabled(false);
  assert.equal(s.injection(), null);
  const again = createHubRulesStore({ dataDir: path.join(root, 'data'), builtinFile: path.join(root, 'builtin.md'), env: {}, loadPersonal: () => null });
  assert.equal(again.snapshot().official.enabled, false);
});

test('本机已有个人基础规则时通用规则默认关，我的规则显示个人文件且不重复注入', t => {
  const home = tmp(t);
  const personal = { home, source: path.join(home, '.agents', 'USER_CONTEXT.md'), content: '个人规则\r\n第二行\r\n' };
  const { s } = store(t, { loadPersonal: () => personal });
  const snap = s.snapshot();
  assert.equal(snap.official.enabled, false);
  assert.equal(snap.mine.mode, 'personal');
  assert.equal(snap.mine.text, personal.content);
  assert.equal(s.injection(), null, '个人规则已由 CLI 原生读取，不随消息重复送');
  s.setEnabled(true);
  assert.doesNotMatch(s.injection().content, /个人规则/);
});

test('检查更新：已是最新不下载；有新版校验通过后立即生效，可回到上一版', async t => {
  const v2 = '# 规则 v2\n- 第一条\n- 新增一条\n';
  const server = fakeServer({ 'public/latest.json': latest(1, '# 内置规则\n- 第一条\n') });
  const { s } = store(t, { fetchImpl: server.fetchImpl });
  let r = await s.checkUpdate();
  assert.equal(r.updated, false);
  assert.match(r.message, /已是最新：v1/);
  assert.equal(server.calls.length, 1, '同版同内容只取版本信息');

  const server2 = fakeServer({ 'public/latest.json': latest(2, v2), 'public/v/2.md': v2 });
  const { s: s2 } = store(t, { fetchImpl: server2.fetchImpl });
  r = await s2.checkUpdate();
  assert.equal(r.updated, true);
  assert.equal(r.from, 1); assert.equal(r.to, 2);
  assert.equal(r.added, 2); assert.equal(r.removed, 1);
  const snap = s2.snapshot();
  assert.equal(snap.official.version, 2);
  assert.equal(snap.official.source, 'cloud');
  assert.equal(snap.official.previous.version, 1);
  assert.match(snap.official.previousText, /内置规则/);
  assert.match(s2.injection().content, /新增一条/);
  const back = s2.rollback();
  assert.equal(back.official.version, 1);
  assert.match(s2.injection().content, /内置规则/);
  assert.match(back.official.lastCheck.message, /已回到 v1/);
});

test('检查更新失败时继续用当前版本：校验不一致、频道不符、超时、超限、同号不同内容', async t => {
  const v2 = '# 规则 v2\n';
  const cases = [
    [{ 'public/latest.json': latest(2, v2), 'public/v/2.md': v2 + '被篡改' }, /校验不一致/],
    [{ 'public/latest.json': latest(2, v2, { channel: 'company' }) }, /频道/],
    [{ 'public/latest.json': Object.assign(new Error('timeout'), { name: 'TimeoutError' }) }, /超时/],
    [{ 'public/latest.json': latest(2, v2, { bytes: 70000 }) }, /大小/],
    [{ 'public/latest.json': latest(2, v2, { md: '../../etc/passwd' }) }, /正文地址/],
    [{ 'public/latest.json': latest(1, '另一份内容') }, /同号但内容不同/],
    [{}, /404/],
  ];
  for (const [routes, pattern] of cases) {
    const { s } = store(t, { fetchImpl: fakeServer(routes).fetchImpl });
    const r = await s.checkUpdate();
    assert.equal(r.failed, true, String(pattern));
    assert.match(r.message, pattern);
    assert.match(r.message, /继续使用 v1/);
    assert.equal(s.snapshot().official.version, 1);
    assert.match(s.injection().content, /内置规则/);
  }
});

test('内置版本比已下载的新时以内置为准', async t => {
  const v2 = '# 规则 v2\n';
  const { s, root } = store(t, { fetchImpl: fakeServer({ 'public/latest.json': latest(2, v2), 'public/v/2.md': v2 }).fetchImpl });
  await s.checkUpdate();
  assert.equal(s.snapshot().official.version, 2);
  // 模拟升级后的 Hub 自带了更新的内置版本：直接改 state 让已下载版本低于内置版本号
  const stateFile = path.join(root, 'data', 'hub-rules', 'state.json');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  state.active.version = 0;
  fs.writeFileSync(stateFile, JSON.stringify(state));
  assert.equal(s.snapshot().official.source, 'builtin');
});

test('我的规则（本地补充）：并发保护、备份，随通用规则一起注入', t => {
  const { s, root } = store(t);
  const first = s.snapshot().mine;
  assert.equal(first.mode, 'local');
  assert.equal(first.text, '');
  s.saveMine({ text: '回答一律用中文', baseSha: first.sha });
  const injected = s.injection();
  assert.match(injected.content, /【通用规则 v1】/);
  assert.match(injected.content, /【我的规则】\n回答一律用中文/);
  assert.throws(() => s.saveMine({ text: '另一个窗口', baseSha: first.sha }), /别处被改过/);
  const now = s.snapshot().mine;
  s.saveMine({ text: '改过', baseSha: now.sha });
  assert.equal(fs.readdirSync(path.join(root, 'data', 'hub-rules', 'backups')).length, 1);
  s.setEnabled(false);
  assert.equal(s.injection().label, '我的规则');
  assert.ok(Buffer.byteLength('x'.repeat(40000)) > 32768);
  assert.throws(() => s.saveMine({ text: 'x'.repeat(40000), baseSha: s.snapshot().mine.sha }), /32 KB/);
});

test('我的规则（个人基础规则）：保留 CRLF、先备份、再运行同步', t => {
  const home = tmp(t);
  const file = path.join(home, '.agents', 'USER_CONTEXT.md');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '第一行\r\n第二行\r\n', 'utf8');
  const loadPersonal = () => ({ home, source: file, content: fs.readFileSync(file, 'utf8') });
  const synced = [];
  const { s } = store(t, { loadPersonal, runSync: h => { synced.push(h); return { ran: true, ok: true, message: '已保存并同步到各 CLI' }; } });
  const before = s.snapshot().mine;
  const r = s.saveMine({ text: '第一行\n第二行\n第三行\n', baseSha: before.sha });
  assert.equal(fs.readFileSync(file, 'utf8'), '第一行\r\n第二行\r\n第三行\r\n');
  assert.equal(fs.readFileSync(r.backup, 'utf8'), '第一行\r\n第二行\r\n');
  assert.deepEqual(synced, [home]);
  assert.equal(r.sync.ok, true);
  assert.throws(() => s.saveMine({ text: '   ', baseSha: s.snapshot().mine.sha }), /不能为空/);
});

test('逐行对比：增删行数与顺序', () => {
  const d = lineDiff('a\nb\nc', 'a\nc\nd');
  assert.equal(d.added, 1); assert.equal(d.removed, 1);
  assert.deepEqual(d.rows.map(r => r.type + r.text), ['samea', 'delb', 'samec', 'addd']);
  assert.equal(lineDiff('x\r\ny', 'x\ny').added, 0);
});

test('导航顺序：自定义过顺序的用户，「规则」插在主页和助理之间', () => {
  const { normalizeNavigationOrder } = require('../renderer/navigation-order');
  const available = ['btn-home', 'btn-rules', 'btn-assistant', 'btn-ran', 'btn-rail-accounts'];
  assert.deepEqual(normalizeNavigationOrder(['btn-home', 'btn-assistant', 'btn-rail-accounts', 'btn-ran'], available),
    ['btn-home', 'btn-rules', 'btn-assistant', 'btn-rail-accounts', 'btn-ran']);
  assert.deepEqual(normalizeNavigationOrder(['btn-ran', 'btn-home', 'btn-assistant', 'btn-rules', 'btn-rail-accounts'], available),
    ['btn-ran', 'btn-home', 'btn-assistant', 'btn-rules', 'btn-rail-accounts'], '用户自己挪过「规则」就保持');
  assert.deepEqual(normalizeNavigationOrder(null, available), available);
});

test('随第一条消息送达：一次送达留回执；换版补送；内部会话和斜杠命令不带', async t => {
  const { HubMemoryService } = require('../core/hub-memory-service');
  const root = tmp(t);
  const sessions = new Map([
    ['s1', { id: 's1', title: '普通会话', kind: 'claude', cwd: root, ccSessionId: 'native-1', nativeRuntime: { state: 'idle' } }],
    ['w1', { id: 'w1', title: '写作成员', kind: 'codex', cwd: root, purpose: 'writing', codexSid: 'native-2', nativeRuntime: { state: 'idle' } }],
  ]);
  const service = new HubMemoryService({ dataDir: path.join(root, 'data'), homeDir: root, transcriptTap: new EventEmitter(),
    sessionManager: { getSession: id => sessions.get(id), getAllSessions: () => [...sessions.values()] },
    workspaceService: { getWorkspaceRoot: () => root }, getPersistedSessions: () => [...sessions.values()],
    searchService: {}, createSession: async () => ({}), sendPrompt: async () => ({ ok: true }), logger: console });
  let rules = { content: '【通用规则 v1】\n先给结论', label: '通用规则 v1', version: 'a' };
  service.hubRules = { injection: () => rules };
  const sent = [];
  const send = sid => async text => { sent.push(text); service.confirmSend({ sessionId: sid, text }); return { ok: true }; };
  await service.withHubRules('s1', '你好', 'claude', { clientSubmissionId: 'one' }, send('s1'));
  // 2026-10-13 用户要求规则放在正文前面。
  assert.match(sent[0], /^<ai-hub-rules ref="hubrules-one">\n以下是 AI Hub 默认带上的规则（通用规则 v1/);
  assert.match(sent[0], /先给结论\n<\/ai-hub-rules>\n\n你好$/);
  assert.equal(service.hubRulesDeliveries().find(r => r.sessionId === 's1').status, 'sent');
  await service.withHubRules('s1', '第二条', 'claude', { clientSubmissionId: 'two' }, send('s1'));
  assert.equal(sent[1], '第二条', '已送达过同一版本就不再带');
  rules = { ...rules, content: '【通用规则 v2】\n先给结论，再给依据', label: '通用规则 v2', version: 'b' };
  await service.withHubRules('s1', '第三条', 'claude', { clientSubmissionId: 'three' }, send('s1'));
  assert.match(sent[2], /通用规则 v2/);
  assert.equal(service.hubRulesDeliveries().find(r => r.sessionId === 's1').reason, 'changed');
  await service.withHubRules('s1', '/status', 'claude', {}, send('s1'));
  assert.equal(sent[3], '/status');
  await service.withHubRules('w1', '写一段', 'codex', {}, send('w1'));
  assert.equal(sent[4], '写一段', '写作会话有自己的文风规则，不带');
  rules = null;
  await service.withHubRules('s1', '关掉以后', 'claude', {}, send('s1'));
  assert.equal(sent[5], '关掉以后');
  const context = await service.context('s1');
  assert.ok(context.receipts.some(r => r.kind === 'hub-rules'), '会话的记忆加载证据里也能看到规则回执');
});

test('卡片视图把末尾连着的规则块和工作区规则块一起折叠，搜索不收规则正文', () => {
  const { splitMemoryIndex } = require('../core/memory-index-envelope');
  const text = '真实问题\n\n<ai-hub-rules ref="hubrules-1">\n以下是规则\n先给结论\n</ai-hub-rules>\n\n<ai-hub-workspace-rules ref="workspace-1">\n共享规则\n</ai-hub-workspace-rules>';
  const parts = splitMemoryIndex(text);
  assert.equal(parts.userText, '真实问题');
  assert.equal(parts.userText + '\n\n' + parts.indexText, text);
  const { searchableUserText } = require('../core/synthetic-user-filter');
  const searchable = searchableUserText('真实问题\n\n<ai-hub-rules ref="hubrules-1">\n先给结论\n</ai-hub-rules>');
  assert.equal(searchable, '真实问题');
});

test('卡片只显示用户自己的话：前置、后置、包在 pasted_content 里的 Hub 附带块都拆出来交给发送内容面板', () => {
  const { displayUserText, hubAttachedFields, splitHubEnvelopes } = require('../core/synthetic-user-filter');
  const rules = '<ai-hub-rules ref="hubrules-1">\n以下是 AI Hub 默认带上的规则（通用规则 v1 + 我的规则，可在 Hub 左侧「规则」页查看或关闭）。\n先给结论\n</ai-hub-rules>';
  const ws = '<ai-hub-workspace-rules ref="workspace-1">\n共享规则\n</ai-hub-workspace-rules>';
  const lead = `${rules}\n\n${ws}\n\n真实问题\n第二行`;
  assert.equal(displayUserText(lead), '真实问题\n第二行');
  assert.deepEqual(hubAttachedFields(lead).hubAttached.map(a => [a.kind, a.label, a.ref]), [
    ['rules', 'Hub 规则（通用规则 v1 + 我的规则）', 'hubrules-1'], ['workspace-rules', '共享工作区规则', 'workspace-1']]);
  assert.equal(hubAttachedFields(lead).hubAttached[1].content, '共享规则');
  assert.equal(displayUserText(`真实问题\n\n${rules}`), '真实问题', '更早的消息块在后面');
  assert.equal(displayUserText(`<pasted_content id="7">\n${rules}\n\n真实问题\n</pasted_content id="7">`), '真实问题');
  assert.equal(displayUserText(rules), null, '只有附带块、没有用户正文的消息不出卡片');
  assert.deepEqual(hubAttachedFields('普通消息，提到 <ai-hub-rules> 这个标签'), {});
  assert.equal(displayUserText('普通消息，提到 <ai-hub-rules> 这个标签'), '普通消息，提到 <ai-hub-rules> 这个标签');
  assert.equal(splitHubEnvelopes('没有块').text, '没有块');
  // 群聊脚手架外面套着规则块时，仍只取「## 用户」那段。
  assert.equal(displayUserText(`${rules}\n\n## 规则\n你是成员\n## 用户\n大家好\n请发言。`), '大家好');
});

test('Claude 启动时把规则写进系统提示：按内容命名的文件、跳过内部会话、不抢别的系统提示文件', t => {
  const { SessionManager } = require('../core/session-manager');
  const { s } = store(t);
  const fake = { memoryService: { hubRules: s } };
  const pick = (opts, purpose) => SessionManager.prototype.hubRulesSystemPrompt.call(fake, opts, purpose);
  const first = pick({});
  assert.ok(first && fs.existsSync(first.file));
  const body = fs.readFileSync(first.file, 'utf8');
  assert.match(body, /^以下是 AI Hub 默认带上的规则（通用规则 v1，/);
  assert.match(body, /内置规则/);
  assert.equal(pick({}).file, first.file, '同一版内容复用同一个文件');
  assert.equal(pick({ appendSystemPromptFile: first.file }).file, first.file, '恢复时带回的旧规则文件会换成当前版本');
  assert.equal(pick({ appendSystemPromptFile: 'C:/other/memory.md' }), null, '已有别的系统提示文件就不改');
  assert.equal(pick({}, 'writing'), null);
  s.setEnabled(false);
  assert.equal(pick({}), null, '规则全关时不写');
});

test('已在系统提示里带上同一版的 Claude 会话不再随消息送；规则换版后随下一条消息补送', async t => {
  const { HubMemoryService } = require('../core/hub-memory-service');
  const root = tmp(t);
  const session = { id: 'c1', kind: 'claude', cwd: root, ccSessionId: 'n1', nativeRuntime: { state: 'idle' }, hubRulesSystem: { version: 'a', label: '通用规则 v1' } };
  const service = new HubMemoryService({ dataDir: path.join(root, 'data'), homeDir: root, transcriptTap: new EventEmitter(),
    sessionManager: { getSession: () => session, getAllSessions: () => [session] }, workspaceService: { getWorkspaceRoot: () => root },
    getPersistedSessions: () => [session], searchService: {}, createSession: async () => ({}), sendPrompt: async () => ({ ok: true }), logger: console });
  let rules = { content: '先给结论', label: '通用规则 v1', version: 'a' };
  service.hubRules = { injection: () => rules };
  const sent = [];
  await service.withHubRules('c1', '你好', 'claude', {}, async text => { sent.push(text); return { ok: true }; });
  assert.equal(sent[0], '你好');
  assert.equal(service.hubRulesDeliveries()[0].status, 'system');
  rules = { content: '先给结论，再给依据', label: '通用规则 v2', version: 'b' };
  await service.withHubRules('c1', '下一条', 'claude', {}, async text => { sent.push(text); return { ok: true }; });
  assert.match(sent[1], /<ai-hub-rules ref="hubrules-/);
});

test('Claude 把整段消息包进 pasted_content 时，卡片仍能把规则折叠起来', () => {
  const { splitMemoryIndex } = require('../core/memory-index-envelope');
  const text = '<pasted_content id="3320">\n真实问题\n\n<ai-hub-rules ref="hubrules-1">\n先给结论\n</ai-hub-rules>\n</pasted_content id="3320">';
  const parts = splitMemoryIndex(text);
  assert.equal(parts.userText, '真实问题');
  assert.match(parts.indexText, /^<ai-hub-rules/);
  assert.deepEqual(splitMemoryIndex('<pasted_content id="1">\n普通长粘贴\n</pasted_content id="1">'), { userText: '<pasted_content id="1">\n普通长粘贴\n</pasted_content id="1">', indexText: null });
});

test('内置规则经 git 检出成 CRLF 时，和服务器上 LF 的同一版仍认作同一版', async t => {
  const root = tmp(t);
  const builtinFile = path.join(root, 'builtin.md');
  fs.writeFileSync(builtinFile, '\uFEFF# 内置规则\r\n- 第一条\r\n', 'utf8');
  const server = fakeServer({ 'public/latest.json': latest(1, '# 内置规则\n- 第一条\n') });
  const s = createHubRulesStore({ dataDir: path.join(root, 'data'), builtinFile, baseUrl: 'https://rules.test/hub-rules/', env: {}, loadPersonal: () => null, fetchImpl: server.fetchImpl });
  const r = await s.checkUpdate();
  assert.equal(r.failed, undefined, r.message);
  assert.match(r.message, /已是最新/);
});

test('泄露闸门只放行规则服务器这一个公开前缀，同域其他地址仍拦截', () => {
  const { scanText } = require('../scripts/community/leak-rules');
  assert.deepEqual(scanText("const URL = 'https://me.lt-stockpartner.tech/hub-rules/';", 'a.js'), []);
  assert.deepEqual(scanText("const URL = 'https://me.lt-stockpartner.tech/captain/';", 'a.js').map(h => h.rule), ['private-gateway']);
  assert.deepEqual(scanText("'https://me.lt-stockpartner.tech/hub-rules/' + 'stockpartner'", 'a.js').map(h => h.rule), ['private-gateway'], '同一行的其他内容照常检查');
});
