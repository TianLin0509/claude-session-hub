'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const parent = '11111111-2222-4333-8444-555555555555';
const child = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const other = 'bbbbbbbb-cccc-4ddd-8eee-ffffffffffff';
const api = () => require('../core/codeagent-fork-identity');
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codeagent-fork-identity-'));
  const cwd = path.join(root, 'work'), config = path.join(root, 'cac'); fs.mkdirSync(cwd);
  const bucket = path.join(config, 'projects', path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(bucket, { recursive: true });
  const file = id => path.join(bucket, id + '.jsonl');
  const row = (id, extra = {}) => ({ type: 'user', sessionId: id, cwd, message: { role: 'user', content: 'retained history' }, ...extra });
  const write = (id, rows) => { fs.writeFileSync(file(id), rows.map(value => typeof value === 'string' ? value : JSON.stringify(value)).join('\n') + '\n'); return file(id); };
  const previous = {};
  for (const [key, value] of Object.entries({ CLAUDE_HUB_DATA_DIR: path.join(root, 'data'), CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), AI_HUB_CODEAGENT_CONFIG_DIR: config })) {
    previous[key] = process.env[key]; process.env[key] = value;
  }
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } fs.rmSync(root, { recursive: true }); });
  const source = { id: 'parent-card', hubId: 'parent-card', kind: 'codeagent', cwd, ccSessionId: parent, transcriptPath: write(parent, [row(parent)]) };
  const meta = { hubId: 'branch-card', kind: 'codeagent', cwd, ccSessionId: parent, transcriptPath: file(child), branchSourceSessionId: source.id, codeagentForkSourceSessionId: parent };
  const deps = { getSession: id => id === source.id ? source : null, loadSessionFile: () => null };
  return { root, cwd, file, row, write, source, meta, deps };
}
test('fork source snapshot survives a later parent /clear; legacy falls back to exact parent card', () => {
  const { forkSourceIdentity } = api();
  const deps = { getSession: () => ({ ccSessionId: other }), loadSessionFile: () => ({ ccSessionId: child }) };
  assert.equal(forkSourceIdentity({ kind: 'codeagent', codeagentForkSourceSessionId: parent, branchSourceSessionId: 'p' }, deps), parent);
  assert.equal(forkSourceIdentity({ kind: 'codeagent', branchSourceSessionId: 'p' }, deps), other);
  assert.equal(forkSourceIdentity({ kind: 'codeagent', branchSourceSessionId: 'p' }, { ...deps, getSession: () => null }), child);
  assert.equal(forkSourceIdentity({ kind: 'codeagent', branchSourceSessionId: 'p' }, { ...deps, getSession: () => ({ ccSessionId: null }) }), child);
});
test('identity rejection refuses source id, source file and UUID/path mismatch', () => {
  const { identityRejection } = api();
  assert.ok(identityRejection({ ccSessionId: parent }, parent));
  assert.ok(identityRejection({ ccSessionId: child, transcriptPath: path.join(os.tmpdir(), parent + '.jsonl') }, parent));
  assert.ok(identityRejection({ ccSessionId: child, transcriptPath: path.join(os.tmpdir(), other + '.jsonl') }, parent));
  assert.equal(identityRejection({ ccSessionId: child, transcriptPath: path.join(os.tmpdir(), child + '.jsonl') }, parent), null);
  assert.equal(identityRejection({ ccSessionId: child }, parent), null);
});
test('exact child path plus top-level child evidence repairs only metadata, preserving inherited rows', t => {
  const h = setup(t), original = h.write(child, [h.row(parent), h.row(child)]), bytes = fs.readFileSync(original);
  const result = api().recoverCodeAgentFork(h.meta, h.deps);
  assert.equal(result.repaired, true); assert.equal(result.meta.ccSessionId, child); assert.equal(result.meta.transcriptPath, original);
  assert.equal(result.forkCCSessionId, null); assert.equal(h.meta.ccSessionId, parent);
  assert.deepEqual(fs.readFileSync(original), bytes);
});
test('path also points to parent: other children and their times never choose an identity', t => {
  const h = setup(t); h.write(child, [h.row(parent), h.row(child)]); h.write(other, [h.row(parent), h.row(other)]);
  assert.throws(() => api().recoverCodeAgentFork({ ...h.meta, transcriptPath: h.file(parent) }, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('child filename with only inherited parent rows cannot repair identity', t => {
  const h = setup(t); h.write(child, [h.row(parent)]);
  assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('sidechain child row is not independent top-level evidence', t => {
  const h = setup(t); h.write(child, [h.row(parent), h.row(child, { isSidechain: true })]);
  assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('last top-level foreign id or wrong cwd is not usable child evidence', t => {
  const h = setup(t);
  for (const rows of [[h.row(child), h.row(other)], [h.row(child, { cwd: path.join(h.root, 'other') })]]) {
    h.write(child, rows); assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
  }
});
test('partial or corrupt tail after a child row is not silently skipped', t => {
  const h = setup(t);
  for (const tail of ['{"type":', '{broken}\n']) {
    h.write(child, [h.row(child)]); fs.appendFileSync(h.file(child), tail);
    assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
  }
});
test('a later top-level message without identity cannot be skipped as child evidence', t => {
  const h = setup(t); h.write(child, [h.row(child), h.row(null)]);
  assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('bounded tail recovers a large child history without reading inherited rows as new identity', t => {
  const h = setup(t); h.write(child, [{ type: 'progress', data: 'x'.repeat(4 * 1024 * 1024) }, h.row(parent), h.row(child)]);
  assert.equal(api().recoverCodeAgentFork(h.meta, h.deps).meta.ccSessionId, child);
});
test('missing exact child file does not fall back to parent or another child', t => {
  const h = setup(t); h.write(other, [h.row(other)]);
  assert.throws(() => api().recoverCodeAgentFork(h.meta, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('a proven saved child outside the configured native history cannot degrade to fresh', t => {
  const h = setup(t), old = path.join(h.root, 'old-cac', 'projects', path.resolve(h.cwd).replace(/[^A-Za-z0-9]/g, '-'), child + '.jsonl');
  fs.mkdirSync(path.dirname(old), { recursive: true }); fs.writeFileSync(old, JSON.stringify(h.row(child)) + '\n');
  assert.throws(() => api().recoverCodeAgentFork({ ...h.meta, transcriptPath: old }, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('new unused pending branch replays fork source instead of starting without context', t => {
  const h = setup(t), result = api().recoverCodeAgentFork({ ...h.meta, ccSessionId: null, transcriptPath: null }, h.deps);
  assert.equal(result.forkCCSessionId, parent); assert.equal(result.meta.ccSessionId, null);
});
test('unbound branch with evidence of a prior turn cannot silently refork', t => {
  const h = setup(t);
  for (const evidence of [
    { lastRunStartedAt: 123 }, { runStartedAt: '2026-10-15T09:00:00.000Z' },
    { lastCompletedAt: '2026-10-15T09:00:30.000Z' }, { lastPrompt: 'a prior user message' },
    { lastOutputPreview: 'a prior answer' },
  ]) assert.throws(() => api().recoverCodeAgentFork({ ...h.meta, ccSessionId: null, transcriptPath: null, ...evidence }, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('pending branch with missing or empty source history cannot silently start fresh', t => {
  const h = setup(t), pending = { ...h.meta, ccSessionId: null, transcriptPath: null };
  fs.unlinkSync(h.file(parent));
  assert.throws(() => api().recoverCodeAgentFork(pending, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
  fs.writeFileSync(h.file(parent), '');
  assert.throws(() => api().recoverCodeAgentFork(pending, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
});
test('normal child and ordinary CodeAgent resumes keep the exact existing identity', t => {
  const h = setup(t); h.write(child, [h.row(child)]);
  const normal = api().recoverCodeAgentFork({ ...h.meta, ccSessionId: child }, h.deps);
  assert.equal(normal.meta.ccSessionId, child); assert.equal(normal.repaired, false); assert.equal(normal.forkCCSessionId, null);
  const plain = { kind: 'codeagent', ccSessionId: parent, transcriptPath: h.file(parent), cwd: h.cwd };
  assert.deepEqual(api().recoverCodeAgentFork(plain, h.deps).meta, plain);
});
test('bound fork requires exact native history, but an obsolete saved path does not hide that history', t => {
  const h = setup(t), bound = { ...h.meta, ccSessionId: child };
  assert.throws(() => api().recoverCodeAgentFork(bound, h.deps), { code: 'CODEAGENT_FORK_IDENTITY_UNRESOLVED' });
  h.write(child, [h.row(child)]);
  const result = api().recoverCodeAgentFork({ ...bound, transcriptPath: path.join(h.root, 'old-bucket', child + '.jsonl') }, h.deps);
  assert.equal(result.meta.ccSessionId, child); assert.equal(result.meta.transcriptPath, h.file(child));
  assert.equal(result.forkCCSessionId, null);
});
async function runResume(h, saved) {
  const store = require('../core/session-store'); store.saveSessionFile(h.source.id, h.source); store.saveSessionFile(saved.hubId, saved);
  let created = null, cancelled = null;
  const { createResumeSessionHandler } = require('../main/ipc/resume-session-handlers');
  const fn = createResumeSessionHandler({ fs, os, path, getHookPort: () => 0, getHubDataDir: () => process.env.CLAUDE_HUB_DATA_DIR,
    isClaudeFamily: require('../core/ai-kinds').isClaudeFamily, isCodexBaseKind: () => false, meetingManager: { getMeeting: () => null }, slotIds: [], scenes: {},
    findTranscriptByCCSessionId: id => fs.existsSync(h.file(id)) ? h.file(id) : null,
    sessionManager: { reserveSessionOpen: () => 'own-reservation', cancelReservedOpen: (id, nonce) => { cancelled = { id, nonce }; },
      getSession: id => id === h.source.id ? h.source : null, createSession(kind, opts) { created = { kind, opts }; return { id: opts.id, kind, ...opts }; } },
    registerSessionForTap() {}, sendToRenderer() {}, logger: { log() {}, warn() {} } });
  let error = null; try { await fn({ hubId: saved.hubId, kind: 'codeagent', cwd: h.cwd }); } catch (e) { error = e; }
  return { created, error, cancelled };
}
test('resume repairs proven saved child before discovery can replace its path with parent', async t => {
  const h = setup(t); h.write(child, [h.row(parent), h.row(child)]);
  const { created, error } = await runResume(h, h.meta);
  assert.equal(error, null); assert.equal(created.opts.resumeCCSessionId, child); assert.equal(created.opts.resumeTranscriptPath, h.file(child));
  assert.equal(created.opts.codeagentForkSourceSessionId, parent); assert.equal(created.opts.codeagentModelPick, false);
});
test('ambiguous old branch fails before creating a writer', async t => {
  const h = setup(t), result = await runResume(h, { ...h.meta, transcriptPath: h.file(parent) });
  assert.equal(result.error?.code, 'CODEAGENT_FORK_IDENTITY_UNRESOLVED'); assert.equal(result.created, null);
  assert.deepEqual(result.cancelled, { id: h.meta.hubId, nonce: 'own-reservation' });
});
test('pending branch resume actually passes forkCCSessionId through the handler', async t => {
  const h = setup(t), result = await runResume(h, { ...h.meta, ccSessionId: null, transcriptPath: null });
  assert.equal(result.error, null); assert.equal(result.created.opts.forkCCSessionId, parent);
  assert.equal(result.created.opts.resumeCCSessionId, undefined); assert.equal(result.created.opts.codeagentForkSourceSessionId, parent);
});
