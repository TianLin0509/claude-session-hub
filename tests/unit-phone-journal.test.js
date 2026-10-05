'use strict';
// 手机通道记录：已发出的消息只留编号（不留全文），旧记录有上限，文件不再越写越大；写盘遇到短暂占用会重试。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PhoneJournal } = require('../core/hub-phone/journal');
const safe = { encryptString: s => Buffer.from(s, 'utf8'), decryptString: b => b.toString('utf8') };

test('sent payloads are dropped, old rows are capped, and the file stays small', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-journal-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = new PhoneJournal(dir, safe), big = 'x'.repeat(200000);
  j.change(s => {
    for (let i = 0; i < 700; i++) s.outbox.push({ id: 'o' + i, payload: i < 690 ? big.slice(0, 2000) : big, sent: i < 695 });
    for (let i = 0; i < 400; i++) s.inbox.push({ id: 'i' + i, state: i < 380 ? 'answered' : 'queued', text: 'hi', pcm: 'AAAA' });
    s.notices = Array.from({ length: 800 }, (_, i) => 'n' + i);
  });
  const s = j.state;
  assert.equal(s.outbox.filter(r => r.sent).every(r => !('payload' in r)), true, '已发出的不留全文');
  assert.equal(s.outbox.filter(r => !r.sent).length, 5, '没发出的全部保留');
  assert.ok(s.outbox.length <= 600);
  assert.equal(s.inbox.filter(r => r.state === 'queued').length, 20, '在办的收件全部保留');
  assert.equal(s.inbox.filter(r => r.state === 'answered').length, 300);
  assert.equal(s.notices.length, 500);
  assert.ok(fs.statSync(path.join(dir, 'channel.bin')).size < 1200000, '只剩未发出的大消息');
  assert.equal(new PhoneJournal(dir, safe).state.outbox.length, s.outbox.length, '重新载入一致');
});

test('a briefly locked file is retried instead of failing the round', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phone-journal-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const j = new PhoneJournal(dir, safe), rename = fs.renameSync; let fails = 2;
  fs.renameSync = (a, b) => { if (fails-- > 0) { const e = new Error('locked'); e.code = 'EPERM'; throw e; } return rename(a, b); };
  t.after(() => { fs.renameSync = rename; });
  j.change(s => { s.cursor = 7; });
  fs.renameSync = rename;
  assert.equal(new PhoneJournal(dir, safe).state.cursor, 7);
});
