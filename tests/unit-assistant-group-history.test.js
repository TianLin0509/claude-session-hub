'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { test } = require('node:test');
const { readGroupHistory } = require('../core/hub-assistant/group-history');
const A = require('../core/group-answer-files'), D = require('../core/delivery-workflow');
const now = Date.now();
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-groups-'));
  t.after(() => { const real = fs.realpathSync(root); assert(real.startsWith(fs.realpathSync(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }); });
  return root;
}
function write(file, text, time = now - 1000) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); fs.utimesSync(file, time / 1000, time / 1000); }
function plain(root, group = 'g', member = 'm', turn = 1) { return A.entryFor({ dataDir: root, meetingId: group, memberId: member, turnNum: turn }); }
function workflow(root, members = ['m']) {
  const run = { id: 'run1', goal: '验证工作', stages: [{ members, after: 'review' }], steps: [] };
  const step = D.newStep(run, 0); run.steps.push(step);
  const base = D.directory(root, 'g');
  const save = () => write(path.join(base, 'run.json'), JSON.stringify(run));
  save(); return { run, step, base, save };
}
test('ordinary group uses only answer file, strips header and keeps observational time', t => {
  const root = fixture(t), e = plain(root);
  write(e.ready, '\uFEFF<!-- hub-delivery:abc123 -->\n已交互验证，等待田哥选择。');
  write(path.join(root, 'transcripts', 'fake.md'), '虚构已合入');
  const r = readGroupHistory({ dataDir: root, since: now - 5000, until: now, meetings: [{ id: 'g', groupChat: true, title: '交互设计' }] });
  assert.equal(r.sources.length, 1); const s = r.sources[0];
  assert.equal(s.text, '已交互验证，等待田哥选择。'); assert.equal(s.title, '交互设计');
  assert.equal(s.timestamp, null); assert.equal(s.observedAt, now - 1000); assert.equal(s.accepted, false);
  assert.match(s.verification, /not proof/); assert.match(r.coverage, /旧协议/);
});
test('window excludes stale and future files; missing answers are not synthesized', t => {
  const root = fixture(t); write(plain(root, 'g', 'old').ready, '旧内容', now - 100000);
  write(plain(root, 'g', 'future').ready, '未来文件', now + 100000);
  write(plain(root, 'g', 'current').ready, '当前变更');
  fs.mkdirSync(plain(root, 'g', 'missing').dir, { recursive: true });
  const r = readGroupHistory({ dataDir: root, since: now - 5000, until: now });
  assert.deepEqual(r.sources.map(s => s.memberId), ['current']);
});
test('workflow distinguishes draft ready rework and blocked without claiming acceptance', t => {
  const root = fixture(t), { run, step, base } = workflow(root, ['draft', 'ready', 'rework', 'blocked']);
  for (const m of step.members) write(D.paths(base, run, step, m)[m], D.header(run, step, m) + '\n' + m + '正文');
  const r = readGroupHistory({ dataDir: root, until: now });
  assert.equal(r.sources.length, 4);
  assert.equal(r.sources.find(s => s.memberId === 'draft').deliveryState, 'draft');
  assert.equal(r.sources.find(s => s.memberId === 'blocked').outcome, 'blocked');
  assert(r.sources.every(s => s.accepted === false && !s.text.includes('hub-delivery')));
});
test('accepted workflow requires matching exact version and ignores skipped member', t => {
  const root = fixture(t), { run, step, base, save } = workflow(root, ['ok', 'changed', 'skip']);
  for (const m of step.members) {
    write(D.paths(base, run, step, m).ready, D.header(run, step, m) + '\n' + m);
    step.deliveries[m] = D.readDelivery(base, run, step, m);
  }
  step.deliveries.skip = { outcome: 'skipped' }; save();
  write(D.paths(base, run, step, 'changed').ready, '后来的未接纳修改');
  const r = readGroupHistory({ dataDir: root, until: now });
  assert.deepEqual(r.sources.map(s => s.memberId), ['ok']); assert.equal(r.sources[0].accepted, true);
  assert.equal(r.skipped.pinnedChanged, 1); assert.equal(r.skipped.userSkipped, 1);
});
test('conflicting final states and wrong round ticket are skipped', t => {
  const root = fixture(t), { run, step, base } = workflow(root, ['conflict', 'wrong']);
  const p = D.paths(base, run, step, 'conflict'); write(p.ready, 'ready'); write(p.blocked, 'blocked');
  write(D.paths(base, run, step, 'wrong').ready, '<!-- hub-delivery:abc123 -->\n其他轮次');
  const r = readGroupHistory({ dataDir: root, until: now }); assert.equal(r.sources.length, 0); assert.equal(r.skipped.invalid, 2);
});
test('archived workflow remains readable after current run changes', t => {
  const root = fixture(t), { run, step, base } = workflow(root);
  write(D.paths(base, run, step, 'm').ready, '历史交付');
  write(path.join(base, run.id, '已结束运行.json'), JSON.stringify(run));
  write(path.join(base, 'run.json'), JSON.stringify({ id: 'run2', steps: [] }));
  const r = readGroupHistory({ dataDir: root, until: now }); assert.equal(r.sources[0].runId, 'run1');
});
test('content and outcome revisions change evidence ref; unchanged read is stable', t => {
  const root = fixture(t), e = plain(root); write(e.ready, '第一版');
  const opts = { dataDir: root, until: now }; const first = readGroupHistory(opts).sources[0].ref;
  assert.equal(readGroupHistory(opts).sources[0].ref, first);
  write(e.ready, '修订版'); assert.notEqual(readGroupHistory(opts).sources[0].ref, first);
  const flow = workflow(root), p = D.paths(flow.base, flow.run, flow.step, 'm');
  write(p.ready, '同样的正文');
  const ready = readGroupHistory(opts).sources.find(s => s.sourceType === 'group-delivery-file').ref;
  fs.renameSync(p.ready, p.blocked);
  const blocked = readGroupHistory(opts).sources.find(s => s.sourceType === 'group-delivery-file');
  assert.equal(blocked.outcome, 'blocked'); assert.notEqual(blocked.ref, ready);
});
test('query is constrained to file content/title and does not fall back to transcripts', t => {
  const root = fixture(t); write(plain(root).ready, '企鹅外观已经提交');
  const opts = { dataDir: root, until: now };
  assert.equal(readGroupHistory({ ...opts, query: '企鹅 提交' }).sources.length, 1);
  assert.equal(readGroupHistory({ ...opts, query: '火箭' }).sources.length, 0);
});
test('budgets expose truncation and oversized inputs', t => {
  const root = fixture(t); write(plain(root, 'g', 'a').ready, '甲'.repeat(100)); write(plain(root, 'g', 'b').ready, '乙'.repeat(100));
  const r = readGroupHistory({ dataDir: root, until: now, maxChars: 35, maxFiles: 1 });
  assert.equal(r.selectedChars, 35); assert.equal(r.truncated, true); assert.equal(r.sources[0].truncated, true);
  const tiny = readGroupHistory({ dataDir: root, until: now, maxFileBytes: 20 }); assert.equal(tiny.sources.length, 0); assert.equal(tiny.skipped.oversized, 2);
  const bounded = readGroupHistory({ dataDir: root, until: now, maxScanEntries: 1 });
  assert.equal(bounded.sources.length, 0); assert.equal(bounded.truncated, true);
});
test('explicit legacy meeting and legacy-only directory are reported uncovered', t => {
  const root = fixture(t); write(plain(root).ready, '不能读这个旧协议群');
  write(path.join(root, 'task-docs', 'legacy', '旧协议.md'), '旧协议正文');
  const r = readGroupHistory({ dataDir: root, until: now, meetings: [{ id: 'g', groupChat: true, answerSource: 'transcript' }] });
  assert.equal(r.sources.length, 0); assert.equal(r.skipped.legacy, 1); assert.equal(r.skipped.noSupportedFiles, 1);
});
test('directory junction is rejected without reading its external target', t => {
  const root = fixture(t), outside = fixture(t), external = plain(outside, 'evil'); write(external.ready, '禁止纳入');
  fs.mkdirSync(path.join(root, 'task-docs'), { recursive: true });
  const link = path.join(root, 'task-docs', 'evil');
  fs.symlinkSync(path.join(outside, 'task-docs', 'evil'), link, process.platform === 'win32' ? 'junction' : 'dir');
  try { const r = readGroupHistory({ dataDir: root, until: now }); assert.equal(r.sources.length, 0); assert(r.skipped.unsafe > 0); }
  finally { fs.unlinkSync(link); }
  assert.equal(fs.readFileSync(external.ready, 'utf8'), '禁止纳入');
});
