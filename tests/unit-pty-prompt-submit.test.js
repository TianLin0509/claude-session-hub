'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const submit = require('../core/pty-prompt-submit.js');

const BP_START = '\x1b[200~';
const BP_END = '\x1b[201~';

function recorder() {
  const writes = [];
  return {
    writes,
    sessionManager: {
      writeToSession(_sid, data) { writes.push(data); },
      getSessionBuffer: () => '',
    },
    joined() { return writes.join(''); },
  };
}

test('computeSettleMs keeps short prompts at the legacy floor and caps long ones', () => {
  assert.equal(submit.computeSettleMs(0), 500, '空 prompt 不该比老行为慢');
  assert.equal(submit.computeSettleMs(12), 500, '短 prompt 维持 500ms 下限');
  // 300 + 20000/20 = 1300
  assert.equal(submit.computeSettleMs(20000), 1300, 'settle 应随体积线性增长');
  assert.equal(submit.computeSettleMs(10_000_000), submit.SETTLE_MAX_MS, '再长也要封顶，剩下交给语义确认');
  assert.ok(submit.computeSettleMs(60000) <= submit.SETTLE_MAX_MS);
  // 单调不减：这是"越长等越久"这条性质本身
  let prev = 0;
  for (const len of [0, 1000, 5000, 14061, 33000, 80000]) {
    const now = submit.computeSettleMs(len);
    assert.ok(now >= prev, `settle 必须随体积单调不减 (len=${len})`);
    prev = now;
  }
});

test('writeBracketedPaste keeps small payloads as a single write', async () => {
  const r = recorder();
  const chunks = await submit.writeBracketedPaste(r.sessionManager, 'sid', 'hello');
  assert.equal(chunks, 1);
  assert.deepEqual(r.writes, [`${BP_START}hello${BP_END}`]);
});

test('writeBracketedPaste chunks large payloads without losing a byte', async () => {
  const r = recorder();
  const prompt = Array.from({ length: 600 }, (_v, i) => `第 ${i + 1} 行：长提示完整性校验 ${'x'.repeat(40)}`).join('\n');
  const chunks = await submit.writeBracketedPaste(r.sessionManager, 'sid', prompt, { gapMs: 0 });
  assert.ok(chunks > 1, '长 payload 必须分块');
  assert.equal(r.writes.length, chunks);
  const joined = r.joined();
  assert.ok(joined.startsWith(BP_START) && joined.endsWith(BP_END), 'BP 帧头尾必须完整');
  assert.equal(joined.slice(BP_START.length, -BP_END.length), prompt, '重组后必须与原文逐字节一致');
  for (const chunk of r.writes) {
    assert.ok(chunk.length <= submit.CHUNK_SIZE + 1, '分片不得超过片长上限（+1 为代理对补位）');
  }
});

test('chunking never splits a surrogate pair', async () => {
  const r = recorder();
  // 让第一个切分点正好落在一个 emoji 中间：BP_START 占 6 个 UTF-16 单元。
  const filler = 'a'.repeat(submit.CHUNK_SIZE - BP_START.length - 1);
  const prompt = `${filler}😀${'b'.repeat(5000)}`;
  await submit.writeBracketedPaste(r.sessionManager, 'sid', prompt, { gapMs: 0 });
  for (const chunk of r.writes) {
    const first = chunk.charCodeAt(0);
    const last = chunk.charCodeAt(chunk.length - 1);
    assert.ok(!(last >= 0xd800 && last <= 0xdbff), '分片不得以高代理项结尾');
    assert.ok(!(first >= 0xdc00 && first <= 0xdfff), '分片不得以低代理项开头');
  }
  assert.equal(r.joined().slice(BP_START.length, -BP_END.length), prompt);
  // 逐片编码再拼回来，等价于 PTY 那头看到的字节流
  const bytes = Buffer.concat(r.writes.map(c => Buffer.from(c, 'utf8')));
  assert.equal(bytes.toString('utf8'), `${BP_START}${prompt}${BP_END}`, '逐片 UTF-8 编码不得产生替换字符');
});

test('waitForPasteSettled returns early on a freshly rendered paste marker', async () => {
  let buffer = 'idle screen';
  const sessionManager = { getSessionBuffer: () => buffer };
  setTimeout(() => { buffer += '\n> [Pasted text #3 +220 lines]'; }, 60);
  const started = Date.now();
  const result = await submit.waitForPasteSettled({
    sessionManager, sid: 'sid', settleMs: 3000, baselineMarker: null, pollMs: 10, markerConfirmMs: 30,
  });
  assert.equal(result.reason, 'marker');
  assert.ok(Date.now() - started < 1500, '拿到正向信号就该收工，不该等满 settle');
});

test('a stale marker left on screen must not shortcut the wait', async () => {
  // 上一次粘贴的折叠标记还在屏幕上。Ink 每帧全屏重绘会把它反复刷进新字节，
  // 不比对基线就会立刻误判"这次的粘贴已消化"，提前把 \r 打进消化窗口里。
  const stale = '> [Pasted text #2 +80 lines]';
  const sessionManager = { getSessionBuffer: () => `screen\n${stale}` };
  const baselineMarker = submit.snapshotPasteMarker(sessionManager, 'sid');
  assert.equal(baselineMarker, '[Pasted text #2 +80 lines]');
  const result = await submit.waitForPasteSettled({
    sessionManager, sid: 'sid', settleMs: 200, baselineMarker, pollMs: 10, markerConfirmMs: 20,
  });
  assert.equal(result.reason, 'ceiling', '与基线相同的标记不算数');
});

test('a new marker after a stale one still counts', async () => {
  let buffer = '> [Pasted text #2 +80 lines]';
  const sessionManager = { getSessionBuffer: () => buffer };
  const baselineMarker = submit.snapshotPasteMarker(sessionManager, 'sid');
  setTimeout(() => { buffer = '> [Pasted text #3 +220 lines]'; }, 40);
  const result = await submit.waitForPasteSettled({
    sessionManager, sid: 'sid', settleMs: 2000, baselineMarker, pollMs: 10, markerConfirmMs: 20,
  });
  assert.equal(result.reason, 'marker');
  assert.equal(result.marker, '[Pasted text #3 +220 lines]');
});

test('no marker at all falls through to the adaptive ceiling', async () => {
  // Codex 走 BP 时不进粘贴态，屏幕上根本不会出现折叠标记 —— 必须等满 settle。
  const sessionManager = { getSessionBuffer: () => 'Context 100% left · gpt-5.5' };
  const started = Date.now();
  const result = await submit.waitForPasteSettled({
    sessionManager, sid: 'sid', settleMs: 240, baselineMarker: null, pollMs: 20,
  });
  assert.equal(result.reason, 'ceiling');
  assert.ok(Date.now() - started >= 200, '没有正向信号时不得提前发 \\r');
});
