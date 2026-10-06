'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { recoverEmptyMeetingMembers, resolveNative } = require('../core/meeting-member-recovery');
const ids = ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222'];
const nativeIds = ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'];
function fixture() {
  const slots = [{ kind: 'claude', memberId: 'm1', model: 'claude-test' }, { kind: 'codex', memberId: 'm2', model: 'codex-test' }];
  const state = { sessions: [], meetings: [{ id: 'room', groupChat: true, subSessions: [], slotSpecs: slots,
    createdAt: 100, lastMessageTime: 200, participants: [1], orchestration: { sessionId: ids[0] } }] };
  return { state, backups: [{ ...state.meetings[0], subSessions: ids.slice() }], options: {
    logger: { info() {}, warn() {} }, manifests: [{ writtenAt: 300, sessions: ids.map((id, i) => ({ id, meetingId: 'room',
      kind: slots[i].kind, nativeId: nativeIds[i] })) }], resolveNative: (s, slot) => slot.kind === 'claude'
      ? { ccSessionId: s.nativeId } : { codexSid: s.nativeId, codexProfile: 'second', codexSessionsRoot: 'second/sessions' },
  } };
}
test('restores exact ordered identities, orchestrator, selected members and account route', () => {
  const f = fixture();
  assert.equal(recoverEmptyMeetingMembers(f.state, f.backups, f.options).length, 1);
  assert.deepEqual(f.state.meetings[0].subSessions, ids);
  assert.deepEqual(f.state.meetings[0].participants, [1]);
  assert.equal(f.state.sessions[0].purpose, 'hub-orchestrator');
  assert.equal(f.state.sessions[1].codexSid, nativeIds[1]);
  assert.equal(f.state.sessions[1].codexProfile, 'second');
  assert.equal(f.state.sessions[0].lastMessageTime, 200);
  assert.equal(recoverEmptyMeetingMembers(f.state, f.backups, f.options).length, 0, 'repair is idempotent');
});
test('does not revive removed rooms or partially removed rosters', () => {
  for (const mutate of [f => f.state.meetings = [], f => f.state.meetings[0].subSessions = [ids[0]],
    f => f.state.meetings[0].slotSpecs = [{ kind: 'claude', memberId: 'other' }]]) {
    const f = fixture(); mutate(f); const before = JSON.stringify(f.state);
    assert.equal(recoverEmptyMeetingMembers(f.state, f.backups, f.options).length, 0);
    assert.equal(JSON.stringify(f.state), before);
  }
});
test('missing identity, wrong ownership and contradictory native identities leave the whole room unchanged', () => {
  for (const mutate of [f => f.options.resolveNative = () => { throw Error('missing history'); },
    f => f.options.canEditSession = s => s.hubId !== ids[1],
    f => f.options.manifests[0].sessions[1].meetingId = 'different',
    f => f.state.sessions.push({ hubId: ids[1], kind: 'codex', meetingId: 'room', codexSid: 'different-native' })]) {
    const f = fixture(); mutate(f); const before = JSON.stringify(f.state);
    assert.equal(recoverEmptyMeetingMembers(f.state, f.backups, f.options).length, 0);
    assert.equal(JSON.stringify(f.state), before);
  }
});
test('native recovery verifies file contents and finds Codex in its actual account history', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-member-recovery-'));
  const claude = path.join(root, '.claude', 'projects', 'work');
  const second = path.join(root, 'second'), codex = path.join(second, 'sessions');
  fs.mkdirSync(claude, { recursive: true }); fs.mkdirSync(codex, { recursive: true });
  const cfile = path.join(claude, nativeIds[0] + '.jsonl');
  fs.writeFileSync(cfile, JSON.stringify({ type: 'user', sessionId: nativeIds[0], cwd: root, message: { role: 'user', content: 'hello' } }) + '\n');
  const xfile = path.join(codex, 'rollout-test-' + nativeIds[1] + '.jsonl');
  fs.writeFileSync(xfile, JSON.stringify({ type: 'session_meta', payload: { id: nativeIds[1], cwd: root } }) + '\n');
  const options = { homeDir: root, codexProfiles: [{ id: 'default', home: path.join(root, 'default') }, { id: 'second', home: second }] };
  assert.equal(resolveNative({ nativeId: nativeIds[0] }, { kind: 'claude' }, options).ccSessionId, nativeIds[0]);
  assert.equal(resolveNative({ nativeId: nativeIds[1] }, { kind: 'codex' }, options).codexProfile, 'second');
  fs.writeFileSync(cfile, JSON.stringify({ sessionId: 'wrong-native-id' }));
  assert.throws(() => resolveNative({ nativeId: nativeIds[0] }, { kind: 'claude' }, options), /身份/);
});
