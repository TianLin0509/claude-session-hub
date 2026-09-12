'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { renderRecovery, writeRecovery } = require('../scripts/render-native-recovery');
const source = { sessionId: 'hub-id', providerId: 'engine-id', submission: { id: 'submission-id', status: 'unknown' },
  unsentDraft: '  中文草稿\r\n— 🧪  ', turns: [{ id: 'uuid', role: 'assistant', text: '</pre><script>alert(1)</script>&中文' }] };
test('recovery companion preserves identity and content as inert text', () => {
  const html = renderRecovery(source);
  assert.ok(html.includes('&lt;/pre&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;中文'));
  assert.ok(html.includes(source.unsentDraft));
  assert.ok(html.includes('submission-id'));
  assert.ok(html.includes("default-src 'none'"));
  assert.ok(!/<script|<iframe|<form|<button|<a\s/i.test(html));
  assert.throws(() => renderRecovery({ ...source, unsentDraft: null }), /requires/);
});
test('CLI companion never overwrites an existing file or changes the input; invalid UTF8 fails', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-recovery-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const input = path.join(dir, 'source.json'), output = path.join(dir, 'report.html');
  const bytes = Buffer.from(JSON.stringify(source)); fs.writeFileSync(input, bytes);
  assert.equal(writeRecovery(input, output).readOnly, true);
  assert.deepEqual(fs.readFileSync(input), bytes);
  assert.throws(() => writeRecovery(input, output), { code: 'EEXIST' });
  assert.throws(() => writeRecovery(input, input), { code: 'EEXIST' });
  fs.writeFileSync(input, Buffer.from([0xff]));
  assert.throws(() => writeRecovery(input, path.join(dir, 'bad.html')));
  assert.equal(fs.existsSync(path.join(dir, 'bad.html')), false);
});
