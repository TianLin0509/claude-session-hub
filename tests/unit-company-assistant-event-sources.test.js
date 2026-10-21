'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const NOW = Date.parse('2026-10-21T12:00:00+08:00'), DAY = '2026-10-21';

test('真实 collect 刷新后，旧简报/通知仍读到当时会议；重启保留、换号拒绝、未引用版本不累计', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-event-sources-'));
  let now = NOW, uid = 'self', revision = 1;
  const rows = () => ['referenced', 'uncited'].map(id => ({ id, subject: id, start: '2026-10-21T17:00:00+08:00',
    end: '2026-10-21T18:00:00+08:00', meetingUsers: Array.from({ length: revision }, (_, i) => ({ id: i })) }));
  const welinkRun = async args => {
    const cmd = args.slice(0, 2).join(' ');
    const body = cmd === 'auth status' ? `UID: ${uid}\nUser Token: VALID` : JSON.stringify(
      cmd === 'meeting query-list' ? { code: 200, data: { data: rows(), total: 2 } } :
        cmd === 'calendar list' ? { events: [] } : cmd === 'im query-recent-conversation' ? { conversation_info: [] } : { mails: [] });
    return { code: 0, stdout: body, stderr: '' };
  };
  const make = () => new CompanyAssistant({ dataDir: dir, now: () => now, welinkRun, noTimer: true, noTools: true, bus: new NoticeBus() });
  let svc = make();
  t.after(() => { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  svc.setSettings({ email: 'self@example.test' });
  const first = await svc.collect(), old = first.meetings[0], ignored = first.meetings[1];
  svc.write(`brief-${DAY}.json`, { sections: [{ items: [{ source: old.sourceId, text: '当时会议' }] }] });
  svc.saveState({ notices: [{ detail: { source: old.sourceId } }] });
  assert.equal(svc.sourceContext(old.sourceId).entry.item.attendees, 1);
  revision = 2; now += 600000;
  const current = await svc.collect();
  assert.equal(current.meetings[0].attendees, 2);
  const preserved = svc.sourceContext(old.sourceId);
  assert.equal(preserved.entry.item.attendees, 1);
  assert.equal(preserved.capturedAt, NOW);
  assert.equal(preserved.historical, true);
  assert.match(preserved.entry.label, /当时记录/);
  assert.throws(() => svc.sourceContext(ignored.sourceId), /没有这条原文/);
  assert.equal(Object.keys(svc.read(`source-history-${DAY}.json`).records).length, 1);
  assert.doesNotMatch(JSON.stringify(svc.agentSnapshot(current)), /当时会议|source-history|historical/);
  svc.close(); svc = make();
  assert.equal(svc.sourceContext(old.sourceId).entry.item.attendees, 1, '重启后仍可读');
  await svc.collect();
  assert.equal(svc.sourceContext(old.sourceId).entry.item.attendees, 1, '再次刷新仍可读');
  uid = 'other'; await svc.collect();
  assert.throws(() => svc.sourceContext(old.sourceId), /没有这条原文/);
  now += 16 * 86400000;
  svc.pruneFiles();
  assert.equal(fs.existsSync(svc.file(`source-history-${DAY}.json`)), false);
});
