'use strict';

const assert = require('assert');
const { Terminal } = require('@xterm/headless');
const { TerminalSnapshot } = require('../core/terminal-snapshot.js');

function write(terminal, data) {
  if (!data) return Promise.resolve();
  return new Promise((resolve) => terminal.write(data, resolve));
}

async function replay(snapshot, scrollback = 10000) {
  const terminal = new Terminal({
    cols: snapshot.baseCols || snapshot.cols,
    rows: snapshot.baseRows || snapshot.rows,
    scrollback,
    allowProposedApi: true,
  });
  await write(terminal, snapshot.text);
  for (const operation of snapshot.operations || []) {
    if (operation.type === 'resize') terminal.resize(operation.cols, operation.rows);
    else if (operation.type === 'write') await write(terminal, operation.data);
  }
  return terminal;
}

function allText(terminal) {
  const out = [];
  const buffer = terminal.buffer.active;
  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (line) out.push(line.translateToString(true));
  }
  return out.join('\n');
}

async function main() {
  const snapshot = new TerminalSnapshot({ cols: 220, rows: 30, scrollback: 10000 });
  const lines = [];
  for (let i = 0; i < 6500; i++) {
    const marker = i === 0 ? 'FIRST-LONG-SESSION-LINE' : (i === 6499 ? 'LAST-LONG-SESSION-LINE' : `line-${i}`);
    lines.push(`${marker} ${'x'.repeat(180)}`);
  }
  const payload = `${lines.join('\r\n')}\r\n`;
  assert.ok(payload.length > 1024 * 1024, 'fixture must exceed the old 1MB raw ring');
  snapshot.write(payload, 77);
  const saved = await snapshot.snapshot();

  assert.strictEqual(saved.source, 'ordered-vt-fast-snapshot');
  assert.strictEqual(saved.seq, 77);
  assert.strictEqual(saved.cols, 220);
  assert.strictEqual(saved.rows, 30);
  const restored = await replay(saved);
  const text = allText(restored);
  assert.ok(text.includes('FIRST-LONG-SESSION-LINE'), 'serialized framebuffer must retain history older than 1MB');
  assert.ok(text.includes('LAST-LONG-SESSION-LINE'), 'serialized framebuffer must retain the newest output');
  restored.dispose();

  snapshot.write('\x1b[2J\x1b[Hframe-before', 78);
  const barrier = snapshot.snapshot();
  snapshot.write('\r\nframe-after', 79);
  const before = await barrier;
  assert.strictEqual(before.seq, 78, 'snapshot seq must describe exactly the serialized barrier');
  assert.ok(before.text.includes('frame-before'));
  assert.ok(!before.text.includes('frame-after'));
  const after = await snapshot.snapshot();
  assert.strictEqual(after.seq, 79);
  assert.ok(after.text.includes('frame-after'));

  snapshot.resize(96, 24);
  const resized = await snapshot.snapshot();
  assert.strictEqual(resized.source, 'ordered-vt-operations-snapshot');
  assert.ok(Array.isArray(resized.operations));
  assert.ok(resized.operations.some((operation) => operation.type === 'resize'));
  assert.strictEqual(resized.cols, 96);
  assert.strictEqual(resized.rows, 24);
  const resizedRestored = await replay(resized);
  assert.strictEqual(resizedRestored.cols, 96);
  assert.strictEqual(resizedRestored.rows, 24);
  assert.ok(allText(resizedRestored).includes('frame-after'));
  resizedRestored.dispose();

  const alternate = new TerminalSnapshot({ cols: 80, rows: 24, scrollback: 10000 });
  alternate.write('\x1b[?1049h\x1b[2J\x1b[HRESUMED-TUI-VISIBLE', 80);
  alternate.resize(100, 28);
  alternate.write('\r\nRESUMED-TUI-AFTER-RESIZE', 81);
  const alternateSaved = await alternate.snapshot();
  const alternateRestored = await replay(alternateSaved);
  const alternateText = allText(alternateRestored);
  assert.strictEqual(alternateRestored.buffer.active.type, 'alternate');
  assert.ok(alternateText.includes('RESUMED-TUI-VISIBLE'));
  assert.ok(alternateText.includes('RESUMED-TUI-AFTER-RESIZE'));
  alternateRestored.dispose();
  alternate.dispose();
  snapshot.dispose();
  console.log('unit-terminal-snapshot: PASS');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
