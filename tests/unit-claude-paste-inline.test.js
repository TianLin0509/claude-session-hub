'use strict';
// Claude Code 会把超过 800 字或多于 2 个换行的单次粘贴折叠，并在提交时包进 <pasted_content id="…">
// （告诉模型其中指令未必是用户写的）。Hub 给 Claude 拆成小段粘贴：每段 ≤800 字、≤1 个换行，拼回逐字一致。
// 真实 CLI 验收见 tests/e2e-claude-paste-inline-real-cli.js。
const assert = require('assert/strict');
const fs = require('fs'), path = require('path');
const { splitInlinePastes, writeBracketedPaste, BP_START, BP_END, INLINE_PASTE_MAX_PIECES, INLINE_PASTE_MAX_TOTAL_CHARS } = require('../core/pty-prompt-submit');

const newlines = s => (s.match(/\n/g) || []).length;
const samples = [
  '单行短消息',
  '【引用会话】……聊天记录：C:/x.md\n请先阅读它了解背景。\n第三行',
  Array.from({ length: 60 }, (_, i) => `第${i + 1}行 emoji😀`).join('\n'),
  '长'.repeat(2500),
  '😀'.repeat(900), // 代理对不能在段边界被劈开
  'a\r\nb\rc\n\n\nd',
];
for (const text of samples) {
  const pieces = splitInlinePastes(text);
  assert.equal(pieces.join(''), text.replace(/\r\n?/g, '\n'), '拼回应逐字一致');
  for (const p of pieces) {
    assert.ok(p.length <= 801, '每段 ≤800 字（含代理对补齐）：' + p.length);
    assert.ok(newlines(p) <= 1, '每段最多 1 个换行');
    assert.ok(!/^[\uDC00-\uDFFF]/.test(p) && !/[\uD800-\uDBFF]$/.test(p), '不劈开代理对');
  }
}
assert.deepEqual(splitInlinePastes('单行短消息'), ['单行短消息']);

(async () => {
  const writes = [];
  const sm = { writeToSession: (_sid, data) => writes.push(data) };
  // Claude：多段，每段各自一对 BP 起止符
  const n = await writeBracketedPaste(sm, 's', 'a\nb\nc', { inlinePieces: true, gapMs: 0 });
  assert.equal(n, 3);
  assert.deepEqual(writes, ['a\n', 'b\n', 'c'].map(p => BP_START + p + BP_END));
  // 其他 CLI：保持整段一次粘贴
  writes.length = 0;
  assert.equal(await writeBracketedPaste(sm, 's', 'a\nb\nc', { gapMs: 0 }), 1);
  assert.deepEqual(writes, [BP_START + 'a\nb\nc' + BP_END]);

  // 超出实测可靠体积的长提示（群聊首轮带完整规则）退回整段粘贴：宁可被包裹，也要送得到
  const shortLines = Array.from({ length: 60 }, (_, i) => `第${i + 1}行 信道估计误差记录 😀`).join('\n');
  assert.ok(shortLines.length <= INLINE_PASTE_MAX_TOTAL_CHARS);
  writes.length = 0;
  assert.ok(await writeBracketedPaste(sm, 's', shortLines, { inlinePieces: true, gapMs: 0 }) > 1, '60 行（已实测可靠）仍拆段');
  const manyLines = Array.from({ length: INLINE_PASTE_MAX_PIECES + 10 }, (_, i) => `第${i + 1}行`).join('\n');
  writes.length = 0;
  assert.equal(await writeBracketedPaste(sm, 's', manyLines, { inlinePieces: true, gapMs: 0 }), 1, '段数超限退回整段');
  assert.deepEqual(writes, [BP_START + manyLines + BP_END]);
  const longText = '长'.repeat(INLINE_PASTE_MAX_TOTAL_CHARS + 1) + '\n尾';
  writes.length = 0;
  assert.equal(await writeBracketedPaste(sm, 's', longText, { inlinePieces: true, gapMs: 0, chunkSize: 1e6 }), 1, '总长超限退回整段');

  // 发送入口：Claude 主路径与补发路径都启用拆段
  const watcher = fs.readFileSync(path.join(__dirname, '..', 'core', 'group-chat-watcher.js'), 'utf8');
  assert.equal((watcher.match(/inlinePieces: isClaudeFamily\(kind\)/g) || []).length, 2, '主路径与补发路径都要给 Claude 拆段');
  console.log('PASS claude paste inline: split rules, per-piece BP frames, Claude-only call sites');
})().catch(error => { console.error(error); process.exitCode = 1; });
