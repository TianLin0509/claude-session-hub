'use strict';

// 2026-08-28：索引此前只有 claude / codex / meeting 三个适配器。
// Kimi 的 45 个 Hub 会话（磁盘上 43 个有真实 transcript）**正文一条都进不了索引**，
// 用户搜对话内容时它们完全不存在。这里补 Kimi 与 Gemini 两个适配器的回归。

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  collectSourceDescriptors,
  createMetadataMaps,
  parseSourceDescriptor,
  providerForHubSession,
  providerLabel,
  titleOnlySources,
} = require('../core/session-search-sources.js');

function tmpRoot(t, name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `hub-src-${name}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

/** 按真实 wire.jsonl 的形状造一份 Kimi 会话 */
function writeKimiWire(root, workdir, sid, lines) {
  const dir = path.join(root, workdir, `session_${sid}`, 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(file, lines.map(l => JSON.stringify(l)).join('\n') + '\n', 'utf8');
  return file;
}

const KIMI_LINES = [
  { type: 'metadata', protocol_version: 1, created_at: 1787000000000 },
  { type: 'turn.prompt', input: [{ type: 'text', text: '帮我排查 KIMIPROBE 这个报错' }], time: 1787000001000 },
  { type: 'context.append_message', message: { role: 'user', content: [{ type: 'text', text: '<system-reminder>这段是注入的噪声，不该进索引</system-reminder>' }] }, time: 1787000001500 },
  { type: 'context.append_loop_event', event: { type: 'step.begin', step: 1 }, time: 1787000002000 },
  { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'think', think: '思考内容，暂不索引' } }, time: 1787000002100 },
  { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '我先看一下日志。' } }, time: 1787000002200 },
  { type: 'context.append_loop_event', event: { type: 'content.part', part: { type: 'text', text: '定位到是端口冲突。' } }, time: 1787000002300 },
  { type: 'context.append_loop_event', event: { type: 'tool.call', name: 'Bash', arguments: { command: 'netstat -ano | findstr 9229' } }, time: 1787000002400 },
  { type: 'context.append_loop_event', event: { type: 'step.end', step: 1 }, time: 1787000002500 },
  { type: 'turn.prompt', input: [{ type: 'text', text: '那就换个端口' }], time: 1787000003000 },
];

test('Kimi：wire.jsonl 能解析出提问 / 回答 / 工具三档', (t) => {
  const root = tmpRoot(t, 'kimi');
  const file = writeKimiWire(root, 'wd_demo_abc', '11111111-2222-3333-4444-555555555555', KIMI_LINES);
  const maps = createMetadataMaps({ sessions: [], meetings: [] });
  const { descriptors } = collectSourceDescriptors({ kimiRoots: [root] }, { sessions: [], meetings: [] });
  assert.equal(descriptors.length, 1, '应当发现一个 kimi 来源');
  const descriptor = descriptors[0];
  assert.equal(descriptor.type, 'kimi');
  assert.equal(descriptor.provider, 'kimi');
  assert.equal(descriptor.nativeSessionId, '11111111-2222-3333-4444-555555555555');
  assert.equal(descriptor.filePath, file);

  const parsed = parseSourceDescriptor(descriptor, maps, {});
  const byScope = {};
  for (const doc of parsed.docs) byScope[doc.scope] = (byScope[doc.scope] || 0) + 1;
  assert.equal(byScope.user, 2, '两条 turn.prompt');
  assert.equal(byScope.assistant, 1, '同一 step 的多个 text part 聚成一段回答');
  assert.equal(byScope.tool, 1);
  assert.equal(byScope.title, 1);

  const answer = parsed.docs.find(d => d.scope === 'assistant');
  assert.match(answer.text, /我先看一下日志。\n定位到是端口冲突。/, '同一回合的分片要按顺序拼起来');
  assert.doesNotMatch(answer.text, /思考内容/, 'think 分片不进正文');

  const noise = parsed.docs.find(d => /system-reminder/.test(d.text || ''));
  assert.equal(noise, undefined, 'context.append_message 里的注入噪声不该进索引');

  const tool = parsed.docs.find(d => d.scope === 'tool');
  assert.match(tool.text, /netstat -ano/);
  assert.equal(parsed.session.provider, 'kimi');
  assert.equal(parsed.searchable, true);
});

test('Kimi：只收 agents/main，子 agent 的分身不重复入库', (t) => {
  const root = tmpRoot(t, 'kimi-sub');
  writeKimiWire(root, 'wd_demo_abc', 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', KIMI_LINES);
  const subDir = path.join(root, 'wd_demo_abc', 'session_aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'agents', 'agent-0');
  fs.mkdirSync(subDir, { recursive: true });
  fs.writeFileSync(path.join(subDir, 'wire.jsonl'), JSON.stringify(KIMI_LINES[1]) + '\n', 'utf8');
  const { descriptors } = collectSourceDescriptors({ kimiRoots: [root] }, { sessions: [], meetings: [] });
  assert.equal(descriptors.length, 1, 'agent-0 是子 agent 的分身，内容与 main 重复');
});

test('Kimi：按 kimiSid 或 transcriptPath 关联回 Hub 会话', (t) => {
  const root = tmpRoot(t, 'kimi-bind');
  const sid = '99999999-8888-7777-6666-555555555555';
  const file = writeKimiWire(root, 'wd_demo_abc', sid, KIMI_LINES);
  const snapshot = {
    sessions: [{ hubId: 'hub-kimi-1', kind: 'kimi', title: '端口冲突排查', cwd: 'C:\\repo', kimiSid: `session_${sid}` }],
    meetings: [],
  };
  const { descriptors, maps } = collectSourceDescriptors({ kimiRoots: [root] }, snapshot);
  assert.equal(descriptors[0].hubSession && descriptors[0].hubSession.hubId, 'hub-kimi-1',
    'Hub 存的是 session_<uuid>，路径里是裸 uuid，两种写法都要认');
  const parsed = parseSourceDescriptor(descriptors[0], maps, {});
  assert.equal(parsed.session.title, '端口冲突排查', '有 Hub 标题就用 Hub 的');
  assert.equal(parsed.session.hubSessionId, 'hub-kimi-1', '没有它，搜到了也打不开');

  // 换成只有 transcriptPath 的绑定方式
  const snapshot2 = { sessions: [{ hubId: 'hub-kimi-2', kind: 'kimi', title: '另一个', transcriptPath: file }], meetings: [] };
  const r2 = collectSourceDescriptors({ kimiRoots: [root] }, snapshot2);
  assert.equal(r2.descriptors[0].hubSession.hubId, 'hub-kimi-2');
});

test('Kimi：空文件 / 坏行 / 缺 session 目录都不该抛', (t) => {
  const root = tmpRoot(t, 'kimi-bad');
  const dir = path.join(root, 'wd_x_1', 'session_dead0000-0000-0000-0000-000000000000', 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire.jsonl'), '', 'utf8');
  const empty = collectSourceDescriptors({ kimiRoots: [root] }, { sessions: [], meetings: [] });
  assert.equal(empty.descriptors.length, 0, '零字节文件跳过');

  const dir2 = path.join(root, 'wd_x_2', 'session_beef0000-0000-0000-0000-000000000000', 'agents', 'main');
  fs.mkdirSync(dir2, { recursive: true });
  fs.writeFileSync(path.join(dir2, 'wire.jsonl'), '这不是 json\n{"type":"turn.prompt","input":[{"type":"text","text":"BADLINE_OK"}]}\n{半个', 'utf8');
  const { descriptors, maps } = collectSourceDescriptors({ kimiRoots: [root] }, { sessions: [], meetings: [] });
  assert.equal(descriptors.length, 1);
  const parsed = parseSourceDescriptor(descriptors[0], maps, {});
  assert.equal(parsed.docs.some(d => d.text === 'BADLINE_OK'), true, '坏行跳过，好行照收');

  assert.doesNotThrow(() => collectSourceDescriptors({ kimiRoots: ['C:\\不存在的目录'] }, { sessions: [], meetings: [] }));
});

test('Gemini：chats/*.json 能解析，且太小的试跑文件被跳过', (t) => {
  const root = tmpRoot(t, 'gemini');
  const chats = path.join(root, 'proj-hash-1', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  const big = {
    sessionId: 'e2cc2c59-418e-4295-8aec-8e7f0e598aa4',
    projectHash: 'proj-hash-1',
    startTime: '2026-04-17T15:55:00.000Z',
    lastUpdated: '2026-04-17T16:10:00.000Z',
    messages: [
      { id: 'm1', timestamp: '2026-04-17T15:55:01.000Z', type: 'user', content: [{ text: 'GEMINIPROBE 这个方案可行吗' + 'x'.repeat(1500) }] },
      { id: 'm2', timestamp: '2026-04-17T15:55:30.000Z', type: 'gemini', content: [{ text: '可行，理由如下……' + 'y'.repeat(800) }] },
    ],
  };
  fs.writeFileSync(path.join(chats, 'session-2026-04-17T15-55-e2cc2c59.json'), JSON.stringify(big), 'utf8');
  fs.writeFileSync(path.join(chats, 'session-2026-04-17T15-06-d981e4b2.json'),
    JSON.stringify({ sessionId: 'd981e4b2-0000-0000-0000-000000000000', messages: [{ id: 'a', type: 'user', content: [{ text: '你好' }] }] }), 'utf8');

  const { descriptors, maps } = collectSourceDescriptors({ geminiRoots: [root] }, { sessions: [], meetings: [] });
  assert.equal(descriptors.length, 1, '小于 2KB 的试跑文件不进索引');
  const parsed = parseSourceDescriptor(descriptors[0], maps, {});
  const byScope = {};
  for (const doc of parsed.docs) byScope[doc.scope] = (byScope[doc.scope] || 0) + 1;
  assert.equal(byScope.user, 1);
  assert.equal(byScope.assistant, 1);
  assert.equal(parsed.session.provider, 'gemini');
  assert.equal(parsed.session.updatedAt, Date.parse('2026-04-17T15:55:30.000Z'), '用消息时间而不是文件 mtime');
  assert.match(parsed.docs.find(d => d.scope === 'user').text, /GEMINIPROBE/);
});

test('Gemini：文件名只带 uuid 前 8 位，靠前缀关联 Hub 会话', (t) => {
  const root = tmpRoot(t, 'gemini-bind');
  const chats = path.join(root, 'proj', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  fs.writeFileSync(path.join(chats, 'session-2026-04-17T15-55-fbc8608b.json'), JSON.stringify({
    sessionId: 'fbc8608b-b783-41f0-bc3a-9c4cd36729fd',
    messages: [{ id: 'm', timestamp: '2026-04-17T15:55:01.000Z', type: 'user', content: [{ text: 'z'.repeat(3000) }] }],
  }), 'utf8');
  const snapshot = {
    sessions: [{ hubId: 'hub-gem', kind: 'gemini', title: 'Charmander', geminiChatId: 'fbc8608b-b783-41f0-bc3a-9c4cd36729fd' }],
    meetings: [],
  };
  const { descriptors } = collectSourceDescriptors({ geminiRoots: [root] }, snapshot);
  assert.equal(descriptors[0].hubSession && descriptors[0].hubSession.hubId, 'hub-gem');
});

test('provider 归类与标签覆盖 kimi / gemini', () => {
  assert.equal(providerForHubSession({ kind: 'kimi' }), 'kimi');
  assert.equal(providerForHubSession({ kind: 'kimi-resume' }), 'kimi');
  assert.equal(providerForHubSession({ kind: 'gemini' }), 'gemini');
  assert.equal(providerForHubSession({ kind: 'gemini-resume' }), 'gemini');
  assert.equal(providerLabel('kimi'), 'Kimi');
  assert.equal(providerLabel('gemini'), 'Gemini');
});

test('没有 transcript 的 kimi / gemini 会话至少留下标题（否则搜索里完全不存在）', () => {
  const maps = createMetadataMaps({
    sessions: [
      { hubId: 'k1', kind: 'kimi', title: 'Kimi 没有 transcript', lastOutputPreview: 'KIMI_PREVIEW_MARKER' },
      { hubId: 'g1', kind: 'gemini', title: 'Gemini 记录已丢', lastOutputPreview: 'GEMINI_PREVIEW_MARKER' },
      { hubId: 'q1', kind: 'qwen', title: '暂不支持的 CLI' },
    ],
    meetings: [],
  });
  const sources = titleOnlySources(maps, new Set(), new Set());
  const keys = sources.map(s => s.key);
  assert.ok(keys.includes('hub:k1'), 'kimi 必须留标题');
  assert.ok(keys.includes('hub:g1'), 'gemini 必须留标题');
  assert.ok(!keys.includes('hub:q1'), 'qwen 还没适配，不该凭空出现');
  const kimi = sources.find(s => s.key === 'hub:k1');
  assert.equal(kimi.session.provider, 'kimi');
  assert.equal(kimi.docs.some(d => d.text === 'KIMI_PREVIEW_MARKER'), true, '最后一段输出也应可搜');
});

test('Kimi 的 JSONL 读取不能走 Codex 那个信封过滤器', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-sources.js'), 'utf8');
  const fn = src.slice(src.indexOf('function parseKimiWire('));
  const body = fn.slice(0, fn.indexOf('\nfunction '));
  assert.doesNotMatch(body, /streamJsonlRecordsSync\(/,
    'streamJsonlRecordsSync 包了 createCodexLineFilter，只认 Codex 的 record_type 信封；'
    + '用它读 Kimi 会把每一条记录都过滤掉（第一版就是这么错的，11MB 只解析出 1 条标题）');
  assert.match(body, /streamPlainJsonlSync\(/, 'Kimi 要用朴素 JSONL 读取');
});

console.log('unit-session-search-kimi-gemini OK');
