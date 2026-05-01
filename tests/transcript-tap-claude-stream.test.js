'use strict';
// Task 1（2026-05-01）单测：ClaudeTap 流式累积块到 _streamingBuf。
//
// 锁定不变量：
// 1. notifyClaudeStop 注入路径后 JsonlTail 启动；后续 appendFile 的 assistant 行能累积
// 2. thinking 块 → { type:'thinking', text }
// 3. text 块 → { type:'text', text }
// 4. tool_use 块 → { type:'tool_use', name, input }
// 5. getStreamingText 返回数组（非字符串）
// 6. clearStreamingBuf 清空后再调返回 null
// 7. 50KB 头部截断（保留尾部）

const fs = require('fs');
const path = require('path');
const os = require('os');
const assert = require('assert');
const { TranscriptTap } = require('../core/transcript-tap');

function test(name, fn) {
  return Promise.resolve(fn())
    .then(() => console.log(`  ✓ ${name}`))
    .catch(e => {
      console.error(`  ✗ ${name}\n    ${e.stack || e.message}`);
      process.exitCode = 1;
    });
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

async function tmpJsonl() {
  const dir = path.join(os.tmpdir(), 'claude-tap-test-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8));
  await fs.promises.mkdir(dir, { recursive: true });
  const jsonlPath = path.join(dir, 'mock-session.jsonl');
  await fs.promises.writeFile(jsonlPath, '');
  return { dir, jsonlPath };
}

async function rmDir(dir) {
  try { await fs.promises.rm(dir, { recursive: true, force: true }); } catch {}
}

async function main() {
  console.log('Running ClaudeTap streamingBuf tests...');

  await test('notifyClaudeStop 启动 JsonlTail；后续 append 累积 thinking/text', async () => {
    const tap = new TranscriptTap();
    const sid = 'test-claude-' + Date.now() + '-a';
    const { dir, jsonlPath } = await tmpJsonl();

    tap.registerSession(sid, 'claude', { cwd: dir });
    await tap.notifyClaudeStop(sid, jsonlPath);

    const block1 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'thinking', thinking: '我先想想' }] },
    });
    const block2 = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '答案是 42' }] },
    });
    await fs.promises.appendFile(jsonlPath, block1 + '\n' + block2 + '\n');

    await wait(900);

    const blocks = tap.getStreamingText(sid);
    assert.ok(Array.isArray(blocks), 'getStreamingText returns array');
    assert.strictEqual(blocks.length, 2, `expected 2 blocks, got ${blocks.length}: ${JSON.stringify(blocks)}`);
    assert.strictEqual(blocks[0].type, 'thinking');
    assert.strictEqual(blocks[0].text, '我先想想');
    assert.strictEqual(blocks[1].type, 'text');
    assert.strictEqual(blocks[1].text, '答案是 42');

    tap.unregisterSession(sid);
    await rmDir(dir);
  });

  await test('tool_use 块累积为 { name, input }', async () => {
    const tap = new TranscriptTap();
    const sid = 'test-claude-' + Date.now() + '-b';
    const { dir, jsonlPath } = await tmpJsonl();

    tap.registerSession(sid, 'claude', { cwd: dir });
    await tap.notifyClaudeStop(sid, jsonlPath);

    const toolBlock = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'tool_use', name: 'WebSearch', input: { query: 'react hooks' } }] },
    });
    await fs.promises.appendFile(jsonlPath, toolBlock + '\n');
    await wait(900);

    const blocks = tap.getStreamingText(sid);
    assert.ok(Array.isArray(blocks) && blocks.length === 1, `expected 1 block, got ${blocks ? blocks.length : 'null'}`);
    assert.strictEqual(blocks[0].type, 'tool_use');
    assert.strictEqual(blocks[0].name, 'WebSearch');
    assert.deepStrictEqual(blocks[0].input, { query: 'react hooks' });

    tap.unregisterSession(sid);
    await rmDir(dir);
  });

  await test('clearStreamingBuf 清空 → getStreamingText 返回 null', async () => {
    const tap = new TranscriptTap();
    const sid = 'test-claude-' + Date.now() + '-c';
    const { dir, jsonlPath } = await tmpJsonl();

    tap.registerSession(sid, 'claude', { cwd: dir });
    await tap.notifyClaudeStop(sid, jsonlPath);
    const block = JSON.stringify({
      type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] },
    });
    await fs.promises.appendFile(jsonlPath, block + '\n');
    await wait(900);

    assert.ok(Array.isArray(tap.getStreamingText(sid)), 'has blocks before clear');
    tap.clearStreamingBuf(sid);
    assert.strictEqual(tap.getStreamingText(sid), null, 'null after clear');

    tap.unregisterSession(sid);
    await rmDir(dir);
  });

  await test('未注册 sid → getStreamingText 返回 null（null-safe）', () => {
    const tap = new TranscriptTap();
    assert.strictEqual(tap.getStreamingText('not-exists'), null);
    tap.clearStreamingBuf('not-exists');  // should not throw
  });

  await test('50KB 截断（保留尾部）', async () => {
    const tap = new TranscriptTap();
    const sid = 'test-claude-' + Date.now() + '-d';
    const { dir, jsonlPath } = await tmpJsonl();

    tap.registerSession(sid, 'claude', { cwd: dir });
    await tap.notifyClaudeStop(sid, jsonlPath);

    // 写 70KB 的 text 块（每块 5KB，14 块），看截断后是否保留尾部
    const lines = [];
    for (let i = 0; i < 14; i++) {
      lines.push(JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: `chunk-${i}-` + 'x'.repeat(5000 - 10) }] },
      }));
    }
    await fs.promises.appendFile(jsonlPath, lines.join('\n') + '\n');
    await wait(1500);

    const blocks = tap.getStreamingText(sid);
    assert.ok(Array.isArray(blocks), 'still has blocks');
    // 总文字应 ≤ 50000 字符
    const totalLen = blocks.reduce((s, b) => s + (b.text || '').length, 0);
    assert.ok(totalLen <= 50000, `truncation kept total ${totalLen} ≤ 50000`);
    // 尾部应保留（最后一块的 chunk-13 必在）
    const hasTail = blocks.some(b => /chunk-13-/.test(b.text || ''));
    assert.ok(hasTail, 'tail (chunk-13) preserved after truncation');

    tap.unregisterSession(sid);
    await rmDir(dir);
  });

  console.log('All passed.');
}

main().catch(e => { console.error(e); process.exit(1); });
