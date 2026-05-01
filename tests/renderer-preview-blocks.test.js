'use strict';
// T7（2026-05-01）单测：renderer/meeting-room.js 的 preview blocks 结构化渲染 helper。
//
// renderer/meeting-room.js 是 IIFE 包裹（顶部 require('electron') + DOM 引用），
// 不能直接 require。这里用 fs.readFileSync 读源文件 + 正则提取目标函数体 +
// new Function() 在隔离作用域里执行，注入 mock 的 escapeHtml / _renderMarkdown 依赖。
//
// 锁定不变量：
//   1. _renderPreviewBlocks([]) → ''
//   2. text 块 → 含 <div class="mr-ft-md">（_renderMarkdown 输出）
//   3. thinking 块 → 含 <div class="mr-ft-think">（CSS ::before 加 💭）
//   4. _formatToolUseBlock(WebSearch{query}) → 🔍 搜索: "..."
//   5. _formatToolUseBlock(Bash{command}) → ⚙ 执行: ...
//   6. tool_use 上限 8（spec §3.6 R8）— 9 个输入只渲染最后 8 个

const fs = require('fs');
const path = require('path');
const assert = require('assert');

function test(name, fn) {
  return Promise.resolve(fn())
    .then(() => console.log(`  ✓ ${name}`))
    .catch(e => {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    });
}

// 提取 IIFE 内的 helper 函数源码 — 用栈匹配大括号（避免正则碰到嵌套花括号）
function extractFunctionSource(src, fnName) {
  const startRe = new RegExp(`function\\s+${fnName}\\s*\\(`);
  const m = startRe.exec(src);
  if (!m) throw new Error(`function ${fnName} not found`);
  const startIdx = m.index;
  // 找到第一个 '{' 之后栈匹配
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
      if (depth === 0) {
        return src.slice(startIdx, i + 1);
      }
    }
  }
  throw new Error(`unbalanced braces in ${fnName}`);
}

// mock 依赖
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function _renderMarkdown(text) {
  // 简化：仅做 escape — 测试只关心 _renderPreviewBlocks 调用了它（检查 wrapper）
  return escapeHtml(text || '');
}

// 在隔离作用域里 eval helper 函数；注入 mock 依赖到 closure
function loadHelpers() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'meeting-room.js'), 'utf8');
  const renderSrc = extractFunctionSource(src, '_renderPreviewBlocks');
  const formatSrc = extractFunctionSource(src, '_formatToolUseBlock');
  // 用 new Function 包裹，参数是 mock 依赖；返回两个 helper
  const factory = new Function('escapeHtml', '_renderMarkdown', `
    ${formatSrc}
    ${renderSrc}
    return { _renderPreviewBlocks: _renderPreviewBlocks, _formatToolUseBlock: _formatToolUseBlock };
  `);
  return factory(escapeHtml, _renderMarkdown);
}

async function main() {
  console.log('Running renderer preview blocks tests...');

  const { _renderPreviewBlocks, _formatToolUseBlock } = loadHelpers();

  await test('_renderPreviewBlocks([]) 返回空字符串', () => {
    assert.strictEqual(_renderPreviewBlocks([]), '');
    assert.strictEqual(_renderPreviewBlocks(null), '');
    assert.strictEqual(_renderPreviewBlocks(undefined), '');
  });

  await test('_renderPreviewBlocks([{type:text}]) 含 <div class="mr-ft-md">', () => {
    const html = _renderPreviewBlocks([{ type: 'text', text: 'hello world' }]);
    assert.ok(html.includes('<div class="mr-ft-md">'), 'expected mr-ft-md wrapper, got: ' + html);
    assert.ok(html.includes('hello world'), 'text content present');
  });

  await test('_renderPreviewBlocks([{type:thinking}]) 含 <div class="mr-ft-think">', () => {
    const html = _renderPreviewBlocks([{ type: 'thinking', text: 'Thinking...' }]);
    assert.ok(html.includes('<div class="mr-ft-think">'), 'expected mr-ft-think wrapper, got: ' + html);
    assert.ok(html.includes('Thinking...'), 'thinking text present');
  });

  await test('_renderPreviewBlocks([{type:tool_use,WebSearch}]) 含 <span class="mr-ft-tool">', () => {
    const html = _renderPreviewBlocks([{ type: 'tool_use', name: 'WebSearch', input: { query: 'foo bar' } }]);
    assert.ok(html.includes('<span class="mr-ft-tool">'), 'expected mr-ft-tool span, got: ' + html);
    assert.ok(html.includes('搜索'), 'search emoji label present');
    assert.ok(html.includes('foo bar'), 'query text present');
  });

  await test('_formatToolUseBlock(WebSearch) → 🔍 搜索: "..."', () => {
    const out = _formatToolUseBlock({ name: 'WebSearch', input: { query: 'foo' } });
    assert.strictEqual(out, '🔍 搜索: "foo"');
    // alias web_search 同样命中
    const out2 = _formatToolUseBlock({ name: 'web_search', input: { query: 'bar' } });
    assert.strictEqual(out2, '🔍 搜索: "bar"');
  });

  await test('_formatToolUseBlock(Bash) → ⚙ 执行: <cmd>，命令截 60 字', () => {
    const out = _formatToolUseBlock({ name: 'Bash', input: { command: 'ls -la' } });
    assert.ok(out.includes('⚙ 执行:'), 'expected ⚙ 执行 prefix, got: ' + out);
    assert.ok(out.includes('ls -la'), 'command present');

    // 60 字截断
    const longCmd = 'a'.repeat(120);
    const out2 = _formatToolUseBlock({ name: 'Bash', input: { command: longCmd } });
    assert.ok(out2.length < 80, 'long command truncated');
    const trail = out2.replace(/^⚙ 执行: /, '');
    assert.strictEqual(trail.length, 60, '60 字截断');
  });

  await test('_formatToolUseBlock(Read/Edit/Write) 走对应分支', () => {
    assert.strictEqual(
      _formatToolUseBlock({ name: 'Read', input: { path: '/foo/bar.js' } }),
      '📄 读: /foo/bar.js'
    );
    assert.strictEqual(
      _formatToolUseBlock({ name: 'Edit', input: { file_path: '/x.js' } }),
      '✏ 编辑: /x.js'
    );
    assert.strictEqual(
      _formatToolUseBlock({ name: 'Write', input: { file_path: '/y.js' } }),
      '✏ 编辑: /y.js'
    );
  });

  await test('_formatToolUseBlock(未知 name) → 🔧 <name>', () => {
    assert.strictEqual(
      _formatToolUseBlock({ name: 'CustomTool', input: {} }),
      '🔧 CustomTool'
    );
  });

  await test('_renderPreviewBlocks tool_use 上限 8（9 个只渲染最后 8）', () => {
    const blocks = [];
    for (let i = 0; i < 9; i++) {
      blocks.push({ type: 'tool_use', name: 'WebSearch', input: { query: `q${i}` } });
    }
    const html = _renderPreviewBlocks(blocks);
    // 引号被 escapeHtml 转义为 &quot;，所以匹配 q0/q1/q8 字面 token
    // q0 应被丢弃（最早），q1-q8 保留
    assert.ok(!/q0[^0-9]/.test(html), 'first tool_use (q0) should be dropped, got: ' + html.slice(0, 200));
    assert.ok(/q1[^0-9]/.test(html), 'q1 should remain');
    assert.ok(/q8[^0-9]/.test(html), 'q8 (last) should remain');
    // 计数应为 8
    const matches = html.match(/<span class="mr-ft-tool">/g) || [];
    assert.strictEqual(matches.length, 8, `expected 8 tool spans, got ${matches.length}`);
  });

  await test('_renderPreviewBlocks 混合 thinking + tool + text 全部渲染', () => {
    const html = _renderPreviewBlocks([
      { type: 'thinking', text: 'reasoning' },
      { type: 'tool_use', name: 'WebSearch', input: { query: 'q' } },
      { type: 'text', text: 'final answer' },
    ]);
    assert.ok(html.includes('mr-ft-think'), 'think rendered');
    assert.ok(html.includes('mr-ft-tool'), 'tool rendered');
    assert.ok(html.includes('mr-ft-md'), 'text/md rendered');
    // 顺序保持
    assert.ok(html.indexOf('mr-ft-think') < html.indexOf('mr-ft-tool'), 'think before tool');
    assert.ok(html.indexOf('mr-ft-tool') < html.indexOf('mr-ft-md'), 'tool before text');
  });
}

main();
