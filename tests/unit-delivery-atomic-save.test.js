'use strict';

const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const D = require('../core/delivery-workflow'), S = require('../core/workflow-settings');
const { createDeliveryEngine } = require('../main/groupchat/delivery-engine');
const flush = () => new Promise(resolve => setImmediate(resolve));

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-delivery-save-'));
  const members = ['a', 'b'].map(memberId => ({ memberId, displayName: memberId }));
  const meeting = { id: 'atomic', groupChat: true, slotSpecs: members, subSessions: ['sa', 'sb'],
    serialWorkflow: S.toDeliveryConfig({}, { kind: 'serial', presetId: 'custom', enabled: true,
      rounds: [{ name: 'first', members: ['a'], prompt: '', after: 'next' },
        { name: 'second', members: ['b'], prompt: '', after: 'end' }] }, ['a', 'b']) };
  const calls = [], errors = [], warnings = [], events = [];
  const engine = createDeliveryEngine({
    meetingManager: { getMeeting: () => meeting, setParticipants: (_, p) => { meeting.participants = p; }, updateMeeting: (_, p) => Object.assign(meeting, p) },
    sessionManager: { getSession: () => ({ status: 'idle' }) }, getHubDataDir: () => dir,
    getMembers: () => members, ensureMemberReady: async () => {},
    getDispatcher: () => ({ dispatchGroupChatTurn: (_, request) => {
      calls.push(request); request.targetMemberIds.forEach(memberId => request.onSubmission({ memberId, ok: true }));
      return Promise.resolve({ status: 'completed' });
    } }), logger: { error: (...args) => errors.push(args), warn: (...args) => warnings.push(args) },
    sendToRenderer: (name, value) => events.push({ name, value }),
  });
  const file = path.join(D.directory(dir, meeting.id), 'run.json');
  const read = () => JSON.parse(fs.readFileSync(file, 'utf8'));
  t.after(() => { engine.dispose(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { engine, meeting, file, read, dir, calls, errors, warnings, events };
}

test('交付状态短暂 rename 占用恢复后继续下一步，派工与已交付内容只记录一次', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t);
  await h.engine.start(h.meeting.id, 'atomic save'); await flush();
  const rename = fs.renameSync, attempts = [], uniqueSources = new Set();
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target === h.file) {
      uniqueSources.add(source); attempts.push(source);
      if (attempts.length <= 2) throw Object.assign(new Error('briefly busy'), { code: attempts.length === 1 ? 'EPERM' : 'EBUSY', path: source, dest: target });
    }
    return rename(source, target);
  });
  const run = h.read(), step = run.steps.at(-1), delivery = D.paths(D.directory(h.dir, h.meeting.id), run, step, 'a');
  fs.writeFileSync(delivery.ready, D.header(run, step, 'a') + '\nverified');
  h.engine.tick(h.meeting.id); await flush(); await flush();
  assert.equal(h.calls.length, 2); assert.deepEqual(h.calls[1].targetMemberIds, ['b']);
  assert.equal(h.read().status, 'running'); assert.equal(h.read().steps.length, 2);
  assert.equal(h.read().steps[0].deliveries.a.hash, D.hash(fs.readFileSync(delivery.ready, 'utf8')));
  assert.deepEqual(attempts.slice(0, 3), Array(3).fill(attempts[0]), '同一候选文件重复 rename，不能重跑状态变更');
  assert.equal(attempts.length, uniqueSources.size + 2);
  assert.equal(h.errors.length, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)).filter(name => name.endsWith('.tmp')), []);
});

test('新任务保存永久拒绝时抛原错误；临时文件清理失败也不能替换它', async t => {
  const h = harness(t), renameError = Object.assign(new Error('save denied'), { code: 'EACCES', syscall: 'rename' });
  const cleanupError = Object.assign(new Error('cleanup denied'), { code: 'EBUSY' });
  const rename = fs.renameSync, unlink = fs.unlinkSync;
  let renameCalls = 0, cleanupCalls = 0, failedSource;
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target !== h.file) return rename(source, target);
    renameCalls++; failedSource = source; renameError.path = source; renameError.dest = target; throw renameError;
  });
  t.mock.method(fs, 'unlinkSync', file => {
    if (file !== failedSource) return unlink(file);
    cleanupCalls++; throw cleanupError;
  });
  await assert.rejects(h.engine.start(h.meeting.id, 'must fail'), error => error === renameError);
  assert.equal(renameCalls, 1); assert.equal(cleanupCalls, 1); assert.equal(h.calls.length, 0);
  assert.equal(fs.existsSync(h.file), false); assert.equal(fs.existsSync(failedSource), true);
  assert.ok(h.warnings.some(args => args.includes(cleanupError)));
});

test('保存持续 EPERM 时不会伪装完成或重复派工，耗尽仍暴露原始失败', { skip: process.platform !== 'win32' }, async t => {
  const h = harness(t);
  await h.engine.start(h.meeting.id, 'held target'); await flush();
  const before = fs.readFileSync(h.file, 'utf8'), rename = fs.renameSync, failures = [];
  t.mock.method(fs, 'renameSync', (source, target) => {
    if (target !== h.file) return rename(source, target);
    const error = Object.assign(new Error('held target'), { code: 'EPERM', syscall: 'rename', path: source, dest: target });
    failures.push(error); throw error;
  });
  const run = h.read(), step = run.steps.at(-1), delivery = D.paths(D.directory(h.dir, h.meeting.id), run, step, 'a');
  fs.writeFileSync(delivery.ready, D.header(run, step, 'a') + '\nverified');
  h.engine.tick(h.meeting.id); await flush(); await flush();
  assert.equal(failures.length, 18, '一次保存和一次既有失败状态保存，各最多 9 次 rename');
  assert.equal(h.calls.length, 1); assert.equal(fs.readFileSync(h.file, 'utf8'), before);
  assert.ok(h.errors.some(args => args.includes(failures[8])));
  assert.ok(h.errors.some(args => args.includes(failures[17])));
  assert.ok(h.events.some(event => event.value?.paused && /held target/.test(event.value.error)));
  assert.deepEqual(fs.readdirSync(path.dirname(h.file)).filter(name => name.endsWith('.tmp')), []);
});
