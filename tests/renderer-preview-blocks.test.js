'use strict';
// 2026-07-29 道雪 · 群聊 blocks → turn 卡片映射单测。
//
// 前身是 T7（2026-05-01）的 _renderPreviewBlocks / _formatToolUseBlock 单测。那两个
// helper 是群聊自建的一套 blocks 渲染，与 renderer/turn-card-renderer.js 完全平行；
// 「群聊直接复用各自 session 的卡片视图」落地后它们已删除，本文件改为锁住新的桥接层。
//
// renderer/meeting-room.js 是 IIFE 包裹（顶部 require('electron') + DOM 引用），
// 不能直接 require。沿用原来的做法：读源文件 + 栈匹配提取目标函数体 + new Function()
// 在隔离作用域里执行。
//
// 锁定不变量：
//   1. thinking 块 → turn.thinking（turn-card 渲染成 <details class="turn-thinking">）
//   2. tool_use 块 → turn.toolCalls[]（turn-card 渲染成可折叠工具簇）
//   3. text 块 → turn.text（turn-card 走 marked + DOMPurify）
//   4. blocks 里的 text 优先于兜底 text（结构化数据比 PTY 抓取可信）
//   5. 没有 blocks 时退回兜底 text，卡片仍然渲染得出来
//   6. 多个 thinking / text 块按顺序合并，不丢内容
//   7. 工具调用有防 DOM 膨胀上限，且保留的是**最近**的

const fs = require('fs');
const path = require('path');
const assert = require('assert');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e.stack || e.message}`); }
}

// 提取 IIFE 内的 helper 函数源码 — 用栈匹配大括号（避免正则碰到嵌套花括号）
function extractFunctionSource(src, fnName) {
  const startRe = new RegExp(`function\\s+${fnName}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) throw new Error(`function ${fnName} not found`);
  const startIdx = m.index;
  let i = src.indexOf('{', startIdx);
  if (i < 0) throw new Error(`opening brace not found for ${fnName}`);
  let depth = 0;
  let inStr = null;
  let escaped = false;
  for (; i < src.length; i++) {
    const c = src[i];
    if (escaped) { escaped = false; continue; }
    if (inStr) {
      if (c === '\\') { escaped = true; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = c; continue; }
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(startIdx, i + 1);
    }
  }
  throw new Error(`unbalanced braces in ${fnName}`);
}

const SRC = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');

function loadBridge() {
  const capMatch = SRC.match(/const _GC_TURN_TOOL_CAP = (\d+);/);
  assert.ok(capMatch, '找不到 _GC_TURN_TOOL_CAP —— 工具上限是防 DOM 膨胀的护栏，不许悄悄删');
  const factory = new Function(`
    const _GC_TURN_TOOL_CAP = ${capMatch[1]};
    ${extractFunctionSource(SRC, '_gcTurnFromBlocks')}
    return { _gcTurnFromBlocks, _GC_TURN_TOOL_CAP };
  `);
  return factory();
}

console.log('Running groupchat blocks→turn bridge tests...');
const { _gcTurnFromBlocks, _GC_TURN_TOOL_CAP } = loadBridge();

test('thinking 块 → turn.thinking（卡片渲染成 💭 思考过程折叠块）', () => {
  const turn = _gcTurnFromBlocks({ id: 't1', blocks: [{ type: 'thinking', text: 'reasoning here' }] });
  assert.strictEqual(turn.thinking, 'reasoning here');
  assert.strictEqual(turn.role, 'assistant');
  assert.strictEqual(turn.id, 't1');
});

test('tool_use 块 → turn.toolCalls[]（卡片渲染成工具簇）', () => {
  const turn = _gcTurnFromBlocks({
    id: 't2',
    blocks: [
      { type: 'tool_use', name: 'WebSearch', input: { query: 'foo bar' } },
      { type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } },
    ],
  });
  assert.strictEqual(turn.toolCalls.length, 2);
  assert.strictEqual(turn.toolCalls[0].name, 'WebSearch');
  assert.strictEqual(turn.toolCalls[0].input.query, 'foo bar');
  assert.strictEqual(turn.toolCalls[1].name, 'Bash');
  assert.strictEqual(turn.toolCalls[1].input.command, 'ls -la');
});

test('text 块 → turn.text', () => {
  const turn = _gcTurnFromBlocks({ id: 't3', blocks: [{ type: 'text', text: '# 标题\n正文' }] });
  assert.strictEqual(turn.text, '# 标题\n正文');
});

test('blocks 里的 text 优先于兜底 text', () => {
  const turn = _gcTurnFromBlocks({
    id: 't4',
    text: 'PTY 抓来的粗糙文本',
    blocks: [{ type: 'text', text: '结构化正文' }],
  });
  assert.strictEqual(turn.text, '结构化正文');
});

test('没有 blocks 时退回兜底 text，卡片仍渲染得出来', () => {
  const turn = _gcTurnFromBlocks({ id: 't5', text: '持久化的回答', blocks: null });
  assert.strictEqual(turn.text, '持久化的回答');
  assert.deepStrictEqual(turn.toolCalls, []);
  assert.ok(!('thinking' in turn), '没有 thinking 块时不该凭空造一个空 thinking（否则卡片多一个空折叠块）');
});

test('多个 thinking / text 块按顺序合并，不丢内容', () => {
  const turn = _gcTurnFromBlocks({
    id: 't6',
    blocks: [
      { type: 'thinking', text: '第一段思考' },
      { type: 'text', text: 'AAA' },
      { type: 'thinking', text: '第二段思考' },
      { type: 'text', text: 'BBB' },
    ],
  });
  assert.ok(turn.thinking.includes('第一段思考'), '第一段思考必须在');
  assert.ok(turn.thinking.includes('第二段思考'), '第二段思考必须在');
  assert.ok(turn.thinking.indexOf('第一段思考') < turn.thinking.indexOf('第二段思考'), '顺序保持');
  assert.strictEqual(turn.text, 'AAABBB');
});

test('混合 thinking + tool + text 三类块全部映射', () => {
  const turn = _gcTurnFromBlocks({
    id: 't7',
    kind: 'claude',
    blocks: [
      { type: 'thinking', text: 'reasoning' },
      { type: 'tool_use', name: 'Read', input: { file_path: '/x.js' } },
      { type: 'text', text: 'final answer' },
    ],
  });
  assert.strictEqual(turn.thinking, 'reasoning');
  assert.strictEqual(turn.toolCalls.length, 1);
  assert.strictEqual(turn.text, 'final answer');
  assert.strictEqual(turn.kind, 'claude');
});

test('工具调用上限生效，且保留的是最近的', () => {
  const blocks = [];
  const n = _GC_TURN_TOOL_CAP + 5;
  for (let i = 0; i < n; i++) {
    blocks.push({ type: 'tool_use', name: 'Bash', input: { command: `cmd${i}` } });
  }
  const turn = _gcTurnFromBlocks({ id: 't8', blocks });
  assert.strictEqual(turn.toolCalls.length, _GC_TURN_TOOL_CAP, `应截到 ${_GC_TURN_TOOL_CAP} 个`);
  assert.strictEqual(turn.toolCalls[turn.toolCalls.length - 1].input.command, `cmd${n - 1}`, '最后一个必须是最新的');
  assert.strictEqual(turn.toolCalls[0].input.command, `cmd${n - _GC_TURN_TOOL_CAP}`, '从前面丢，保留最近的');
});

test('脏输入不炸：null / 非对象 / 缺字段的块被跳过', () => {
  const turn = _gcTurnFromBlocks({
    id: 't9',
    blocks: [null, 'str', 42, { type: 'thinking' }, { type: 'tool_use' }, { type: 'text', text: 'ok' }],
  });
  assert.strictEqual(turn.text, 'ok');
  assert.deepStrictEqual(turn.toolCalls, [], '没有 name 的 tool_use 不该进 toolCalls');
  assert.ok(!('thinking' in turn), '没有 text 的 thinking 块不该产生空 thinking');
});

console.log(`\n${failed === 0 ? '✓ all passed' : '✗ ' + failed + ' failed'}`);
process.exit(failed > 0 ? 1 : 0);
