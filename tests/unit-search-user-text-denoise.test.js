'use strict';

// 2026-08-28 用户反馈：搜「梦境」命中的是自动注入的 AGENTS.md 正文，
// 「我的提问」那一栏整屏都是系统提示词。诉求：
//   「搜索一定是冲着对话内容去的 —— 搜索文本和我看到的卡片视图的问答内容一样就可以了」
// 所以索引里的 user 文档必须复用卡片视图那套判定，保证「搜到的」= 「看到的」。

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  displayUserText,
  isSyntheticUserText,
  searchableUserText,
  stripInjectedBlocks,
} = require('../core/synthetic-user-filter.js');
const { docsFromTurns } = require('../core/session-search-sources.js');

// 真实形态（从本机 Codex rollout 里取的，长度约 1200 字）
const CODEX_AGENTS_INJECTION = [
  '# AGENTS.md instructions',
  '',
  '<INSTRUCTIONS>',
  '# Codex 全局约定',
  '',
  '## 协作',
  '- 默认中文；代码标识、API、命令和路径保留英文。',
  '- 不关闭、重启或按命令行子串终止生产 AI HUB 进程。',
  '',
  '<!-- dream:begin -->',
  '## 梦境沉淀（AI Hub 自动维护）',
  '- (2026-08-01) HTML 可视化产物写文件。',
  '</INSTRUCTIONS>',
  '',
  '<environment_context>',
  '  <cwd>C:\\Vibe\\_scratch\\inbox-20260727-201613-011200</cwd>',
  '  <shell>powershell</shell>',
  '</environment_context>',
].join('\n');

test('整条都是注入的 AGENTS.md 消息不进索引（就是截图里那条）', () => {
  assert.equal(isSyntheticUserText(CODEX_AGENTS_INJECTION), true,
    '此前判定要求带 " for " 后缀，漏掉了 Codex 更常见的这一种');
  assert.equal(displayUserText(CODEX_AGENTS_INJECTION), null, '卡片视图不该显示');
  assert.equal(searchableUserText(CODEX_AGENTS_INJECTION), null, '搜索索引也不该收');
});

test('搜「梦境」不该再命中注入块里的「梦境沉淀」', () => {
  assert.match(CODEX_AGENTS_INJECTION, /梦境/, '注入块里确实含这两个字（所以以前会命中）');
  const docs = docsFromTurns(
    [{ id: 'u1', role: 'user', text: CODEX_AGENTS_INJECTION, ts: 1 }],
    '某会话', 'codex',
  );
  assert.equal(docs.filter(d => d.scope === 'user').length, 0, '这条 user 文档整条都不该产生');
  assert.equal(docs.some(d => /梦境沉淀/.test(d.text || '')), false);
});

test('注入块夹在真话前后时，只剪掉注入，保留真话', () => {
  const mixed = [
    '帮我看看 SEARCHPROBE 这个报错',
    '<system-reminder>这段是运行期注入的提醒，用户没说过</system-reminder>',
    '顺便把日志也贴一下',
  ].join('\n\n');
  const cleaned = searchableUserText(mixed);
  assert.match(cleaned, /SEARCHPROBE/);
  assert.match(cleaned, /顺便把日志也贴一下/);
  assert.doesNotMatch(cleaned, /system-reminder/);
  assert.doesNotMatch(cleaned, /运行期注入/);
});

test('各类注入块都要剪掉，且不留一地空行', () => {
  for (const tag of ['INSTRUCTIONS', 'system-reminder', 'environment_context',
    'recommended_plugins', 'user-prompt-submit-hook', 'skills_instructions', 'plugins_instructions']) {
    const text = `真话开头\n<${tag}>噪声NOISE_MARKER</${tag}>\n真话结尾`;
    const out = stripInjectedBlocks(text);
    assert.doesNotMatch(out, /NOISE_MARKER/, `${tag} 没被剪掉`);
    assert.match(out, /真话开头/);
    assert.match(out, /真话结尾/);
    assert.doesNotMatch(out, /\n{3,}/, '剪完不该留三连空行');
  }
});

test('群聊脚手架仍然只取「## 用户」那一段（原有行为不能退）', () => {
  const scaffold = [
    '## 规则', '- 这里是AI群聊，你是Kimi 3。', '',
    '## 新增发言', 'Codex：我觉得应该先看日志。', '',
    '## 用户', '那你去查一下 GROUPPROBE 的实现', '', '请发言。',
  ].join('\n');
  const cleaned = searchableUserText(scaffold);
  assert.equal(cleaned, '那你去查一下 GROUPPROBE 的实现');
  assert.doesNotMatch(cleaned, /这里是AI群聊/, 'Hub 注入的角色设定不算用户说的话');
});

test('普通提问原样保留，不能被误伤', () => {
  const normal = '帮我梳理一份 html，介绍 claude 和 codex 的 prompt 组成，比如包含了 claude.md';
  assert.equal(searchableUserText(normal), normal);
  const withAngle = '这个 <div> 标签为什么不生效？还有 <span> 也是';
  assert.equal(searchableUserText(withAngle), withAngle, '普通尖括号不该被当成注入块');
  const mentionsAgents = '你看下 AGENTS.md 里写了什么规则';
  assert.equal(searchableUserText(mentionsAgents), mentionsAgents, '提到 AGENTS.md 不等于是注入');
});

test('AI 回答不做这套过滤（那是模型真实输出）', () => {
  const answer = '我先看一下 <system-reminder> 这个标签是怎么来的。';
  const docs = docsFromTurns([{ id: 'a1', role: 'assistant', text: answer, ts: 1 }], 'T', 'codex');
  const assistant = docs.find(d => d.scope === 'assistant');
  assert.equal(assistant.text, answer, 'assistant 文本必须原样入库');
});

test('会话标题取第一句用户真话，而不是注入块', () => {
  const docs = docsFromTurns([
    { id: 'u1', role: 'user', text: CODEX_AGENTS_INJECTION, ts: 1 },
    { id: 'u2', role: 'user', text: '帮我把这个 PPT 转成可编辑的', ts: 2 },
  ], '未命名会话', 'codex');
  const users = docs.filter(d => d.scope === 'user');
  assert.equal(users.length, 1);
  assert.equal(users[0].text, '帮我把这个 PPT 转成可编辑的');
});

test('剪空之后的空消息不产生文档（免得留一条空壳）', () => {
  const onlyNoise = '<system-reminder>只有注入，没有真话</system-reminder>';
  assert.equal(searchableUserText(onlyNoise), null);
  const docs = docsFromTurns([{ id: 'u', role: 'user', text: onlyNoise, ts: 1 }], 'T', 'codex');
  assert.equal(docs.filter(d => d.scope === 'user').length, 0);
});

test('每一处 signature 都要带文本投影版本号，否则旧索引永远不会重新解析', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-search-sources.js'), 'utf8');
  // refresh() 按 signature 增量复用：mtime+size+元数据没变就直接沿用旧文档。
  // 只改解析逻辑不改签名的话，这次去噪对已入库的 2000+ 个源一点效果都没有。
  const lines = src.split('\n').filter(line => /descriptor\.signature\s*=/.test(line));
  assert.ok(lines.length >= 5, `只找到 ${lines.length} 处签名赋值，文件结构可能变了`);
  for (const line of lines) {
    assert.match(line, /PROJECTION_SUFFIX/,
      `这一处签名没带版本号，改了解析逻辑也不会重建：\n    ${line.trim()}`);
  }
  assert.match(src, /const SEARCH_TEXT_PROJECTION_VERSION = \d+;/);
});

test('去噪后的文本投影确实会让签名变化（版本号不是摆设）', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { collectSourceDescriptors } = require('../core/session-search-sources.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-sig-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'wd_a_1', 'session_11111111-2222-3333-4444-555555555555', 'agents', 'main');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'wire.jsonl'),
    JSON.stringify({ type: 'turn.prompt', input: [{ type: 'text', text: 'hi' }], time: 1 }) + '\n', 'utf8');
  const { descriptors } = collectSourceDescriptors({ kimiRoots: [root] }, { sessions: [], meetings: [] });
  assert.match(descriptors[0].signature, /:utext-v\d+$/, '签名末尾必须是文本投影版本号');
});

console.log('unit-search-user-text-denoise OK');

test('剪掉注入块后，剩下的残渣本身又是注入标记时也要丢掉', () => {
  // 2026-08-28 在真实 Codex rollout 上抓到的形态（原文 1687 字）：
  //     <recommended_plugins> …一大段… </recommended_plugins>
  //     # AGENTS.md instructions for C:\Users\lintian\chuxin-research
  // 第一版剪掉前一块之后，把后一行当成用户真话入库了，搜索里照样能命中。
  const real = [
    '<recommended_plugins>',
    'Here is a list of plugins that are available but not installed.',
    'x'.repeat(1400),
    '</recommended_plugins>',
    '',
    '# AGENTS.md instructions for C:\Users\lintian\chuxin-research',
  ].join('\n');
  assert.equal(searchableUserText(real), null, '整条都是注入，一个字都不该进索引');

  const docs = docsFromTurns([{ id: 'u1', role: 'user', text: real, ts: 1 }], '标题', 'codex');
  assert.equal(docs.filter(d => d.scope === 'user').length, 0);
  assert.equal(docs.some(d => /AGENTS\.md instructions/i.test(d.text || '')), false);
});

test('注入块后面跟着真话时，真话必须留下', () => {
  const mixed = [
    '<recommended_plugins>一堆插件清单</recommended_plugins>',
    '',
    '帮我把这个 PPT 转成可编辑的 REALQUESTION',
  ].join('\n');
  const out = searchableUserText(mixed);
  assert.match(out, /REALQUESTION/);
  assert.doesNotMatch(out, /插件清单/);
});

test('只有 <recommended_plugins> 一块的消息，剪完为空→丢掉', () => {
  // 有意**不**把它加进 isSyntheticUserText 的整条判定：那样会把
  // 「注入块 + 后面跟着的真话」整条误杀（上一条用例就是防这个）。
  // 靠「剪块 → 剩空 → 丢」达到同样效果，且不误伤。
  assert.equal(searchableUserText('<recommended_plugins>\nfoo\n</recommended_plugins>'), null);
  assert.equal(isSyntheticUserText('<recommended_plugins>\nfoo\n</recommended_plugins>'), false,
    '整条判定不该认它，否则块后面的真话会被一起丢掉');
});
