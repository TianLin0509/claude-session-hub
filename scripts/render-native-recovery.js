'use strict';
// Read-only companion for a deliberate rollback to a version that cannot read
// Main's native journal/draft schema. This never writes to an engine or Hub.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const escapeHtml = value => String(value).replace(/[&<>"']/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function renderRecovery(source) {
  if (!source || typeof source.sessionId !== 'string' || typeof source.providerId !== 'string'
      || typeof source.unsentDraft !== 'string' || !Array.isArray(source.turns)
      || source.turns.some(turn => !turn || typeof turn.text !== 'string' || typeof turn.role !== 'string')) {
    throw new Error('Recovery export requires exact session/provider identity, turns and an unsent draft');
  }
  const json = JSON.stringify(source, null, 2);
  const sha256 = createHash('sha256').update(json).digest('hex');
  const turns = source.turns.map(turn => `<article><h3>${escapeHtml(turn.role)} · ${escapeHtml(turn.id || '')}</h3><pre data-turn-text>${escapeHtml(turn.text)}</pre></article>`).join('\n');
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'">
<title>原生会话回退只读副本</title><style>body{font:16px/1.7 system-ui,sans-serif;background:#f2f4f7;color:#172131;max-width:1000px;margin:32px auto;padding:0 24px}article,section{background:white;border:1px solid #ccd4df;border-radius:8px;padding:18px;margin:16px 0}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:14px/1.65 ui-monospace,monospace}.notice{border-left:5px solid #b46b10}h1{font-size:26px}h2{font-size:20px}h3{font-size:16px}small{overflow-wrap:anywhere}</style></head><body>
<h1>原生会话回退只读副本</h1><section class="notice">旧版 Hub 可能无法显示新版保存的回答和草稿，可在这里核对完整内容。此文件没有发送或执行功能。未知提交仍须核对；不要把历史问题或未确认消息批量重发。</section>
<section><b>Hub 会话：</b><span id="session-id">${escapeHtml(source.sessionId)}</span><br><b>引擎会话：</b><span id="provider-id">${escapeHtml(source.providerId)}</span><br><b>数据摘要：</b><small>${sha256}</small></section>
<h2>未发送草稿</h2><section><pre id="unsent-draft">${escapeHtml(source.unsentDraft)}</pre></section>
<h2>已保存历史</h2>${turns}
<details><summary>完整原始记录与提交身份</summary><pre id="recovery-json">${escapeHtml(json)}</pre></details>
</body></html>`;
}

function writeRecovery(inputFile, outputFile) {
  const input = path.resolve(inputFile), output = path.resolve(outputFile);
  const source = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(input)));
  const html = renderRecovery(source);
  fs.writeFileSync(output, html, { encoding: 'utf8', flag: 'wx' });
  if (fs.readFileSync(output, 'utf8') !== html) throw new Error('Recovery report readback mismatch');
  return { output, bytes: Buffer.byteLength(html), readOnly: true };
}

if (require.main === module) {
  try {
    if (process.argv.length !== 4) throw new Error('Usage: node scripts/render-native-recovery.js <export.json> <new-report.html>');
    console.log(JSON.stringify(writeRecovery(process.argv[2], process.argv[3])));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { renderRecovery, writeRecovery };
