'use strict';
// 卡片「发送内容」面板（2026-10-13）：一条消息发出去时请求里依次有哪几块。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { buildComposition, estimateTokens } = require('../core/prompt-composition');
const { renderComposition } = require('../renderer/prompt-composition-view');
const { hubAttachedFields, displayUserText } = require('../core/synthetic-user-filter');

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

test('粗估 token：中文约 0.8/字，英文约 3.8 字符/token', () => {
  assert.equal(estimateTokens('先给结论'), 3);
  assert.equal(estimateTokens('a'.repeat(38)), 10);
  assert.equal(estimateTokens(''), 0);
});

test('三组按请求顺序：系统提示 → 会话开头的规则与记忆 → 这条消息（附带块在正文前）', () => {
  const raw = '<ai-hub-rules ref="hubrules-1">\n以下是 AI Hub 默认带上的规则（通用规则 v1，可在…）\n先给结论\n</ai-hub-rules>\n\n周报要不要改成双周？';
  const turn = { role: 'user', text: displayUserText(raw), ...hubAttachedFields(raw) };
  const model = buildComposition({ turn, kind: 'codex', systemRules: null,
    assembly: { segments: [
      { id: 'codex:0', label: 'AGENTS.md', path: 'C:/w/AGENTS.md', text: '# 规则\n短', bytes: 12, textBytes: 12, orderTruth: 'measured' },
      { id: 'codex:1', label: 'gone.md', missing: true },
      { id: 'import:0:0', label: '@x.md', path: 'C:/w/x.md', duplicateOf: 'c:/w/x.md' },
    ] } });
  assert.deepEqual(model.groups.map(g => g.id), ['system', 'startup', 'message']);
  assert.deepEqual(model.groups[0].parts.map(p => p.id), ['cli-builtin'], 'Codex 会话没有 Hub 写进系统提示的规则');
  assert.equal(model.groups[0].parts[0].unavailable, true);
  assert.deepEqual(model.groups[1].parts.map(p => p.title), ['AGENTS.md'], '读不到的和重复的不列');
  assert.deepEqual(model.groups[2].parts.map(p => p.title), ['Hub 规则（通用规则 v1）', '你输入的内容']);
  assert.equal(model.groups[2].parts[1].text, '周报要不要改成双周？');
  assert.equal(model.tokens, model.groups.reduce((n, g) => n + g.tokens, 0));
});

test('Claude 会话：启动时写进系统提示的规则放在系统提示组；文件被清理时如实说明', () => {
  const withText = buildComposition({ turn: { text: '你好' }, kind: 'claude', systemRules: { label: '通用规则 v1', text: '以下是规则\n先给结论' } });
  const sys = withText.groups[0].parts.find(p => p.id === 'hub-rules-system');
  assert.equal(sys.title, 'Hub 规则（通用规则 v1）');
  assert.equal(sys.text, '以下是规则\n先给结论');
  assert.match(withText.groups[2].note, /没有附带/);
  const gone = buildComposition({ turn: { text: '你好' }, systemRules: { label: '通用规则 v1', text: null } });
  assert.equal(gone.groups[0].parts[1].unavailable, true);
  assert.match(gone.groups[0].parts[1].note, /已被清理/);
  const failed = buildComposition({ turn: { text: '你好' }, assemblyError: '这个会话没有记录工作目录' });
  assert.match(failed.groups[1].note, /还原失败：这个会话没有记录工作目录/);
});

test('面板 HTML：每块一个可展开项，正文转义，体量条按四类上色', () => {
  const raw = '<ai-hub-workspace-rules ref="workspace-1">\n<script>x</script>\n</ai-hub-workspace-rules>\n\n问题';
  const model = buildComposition({ turn: { text: displayUserText(raw), ...hubAttachedFields(raw) }, systemRules: { label: 'v1', text: '规则' } });
  const html = renderComposition(model, { escapeHtml: esc });
  assert.equal((html.match(/<details class="pc-part/g) || []).length, 4);
  assert.match(html, /&lt;script&gt;x&lt;\/script&gt;/);
  assert.doesNotMatch(html, /<script>/);
  for (const cls of ['pc-c-system', 'pc-c-attached', 'pc-c-user']) assert.match(html, new RegExp(`<i class="${cls}" style="width:`));
  assert.match(html, /拿不到原文/);
});

test('主进程 prompt-composition：读回会话启动时那一版系统提示规则和规则文件拼装', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-composition-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'work'); fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, 'AGENTS.md'), '# 项目规则\n先给结论');
  fs.mkdirSync(path.join(cwd, '.git'));
  const { createHubRulesStore } = require('../core/hub-rules');
  const store = createHubRulesStore({ dataDir: path.join(root, 'data'), loadPersonal: () => null });
  const rules = store.injection();
  store.systemPromptFile(rules);
  const sessions = {
    c1: { id: 'c1', kind: 'claude', cwd, hubRulesSystem: { version: rules.version, label: rules.label } },
    x1: { id: 'x1', kind: 'codex', cwd },
    old: { id: 'old', kind: 'claude', cwd, hubRulesSystem: { version: 'f'.repeat(64), label: '通用规则 v0' } },
  };
  const handlers = new Map();
  const prevHome = process.env.USERPROFILE;
  process.env.USERPROFILE = root; // 不读真实用户目录下的全局规则
  t.after(() => { process.env.USERPROFILE = prevHome; });
  require('../main/ipc/prompt-inspect-handlers').registerPromptInspectIpc({ handle: (name, fn) => handlers.set(name, fn) },
    { sessionManager: { getSession: id => sessions[id] || null, memoryService: { hubRules: store } } });
  const call = sessionId => handlers.get('prompt-composition')(null, { sessionId });
  const claude = await call('c1');
  assert.equal(claude.ok, true);
  assert.match(claude.data.systemRules.text, /^以下是 AI Hub 默认带上的规则/);
  const codex = await call('x1');
  assert.equal(codex.data.systemRules, null);
  assert.ok(codex.data.assembly.segments.some(s => s.label === 'AGENTS.md' && /先给结论/.test(s.text)));
  assert.equal((await call('old')).data.systemRules.text, null, '轮换清掉的旧版返回空，面板据此说明');
  assert.equal((await call('nope')).ok, false);
  assert.equal(store.systemPromptText('../../etc'), null, '版本号不合格式就不拼路径');
});
