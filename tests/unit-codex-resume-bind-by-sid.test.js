const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { CodexTap } = require('../core/transcript-tap');
const { FakeCodexRollout } = require('./helpers/fake-codex-rollout');

async function waitFor(fn, timeoutMs = 2000, intervalMs = 50) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

async function testResumeBindsExistingRolloutByCodexSid() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-resume-bind-'));
  const cwd = path.join(os.tmpdir(), 'codex-resume-project');
  const codexSid = '019e9999-aaaa-7bbb-8ccc-123456789abc';
  const oldStart = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: codexSid, startAt: oldStart });
  await fr.start();
  await fr.writeTaskComplete('resume final answer', 100, { at: new Date() });
  await fr.close();

  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const hubSid = 'hub-resume-codex';
  try {
    tap.registerSession(hubSid, { cwd, codexSid });
    const bound = await waitFor(() => {
      const snap = tap.getDebugSnapshot();
      return snap.bound.find((b) => b.hubSessionId === hubSid);
    });
    assert.ok(bound, 'CodexTap should bind an existing resume rollout by codexSid');
    assert.strictEqual(bound.rolloutPath, fr.rolloutPath);

    const extracted = await tap.extractLatestTurn(hubSid, 0);
    assert.strictEqual(extracted.extractMode, 'final_answer');
    assert.strictEqual(extracted.text, 'resume final answer');
  } finally {
    tap.unregisterSession(hubSid);
    await fr.cleanup();
  }
}

async function testResumeFallsBackToSidWhenPersistedPathIsStale() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-resume-stale-path-'));
  const cwd = path.join(os.tmpdir(), 'codex-resume-stale-path-project');
  const codexSid = '019e9999-dddd-7eee-8fff-123456789abc';
  const fr = new FakeCodexRollout({
    sessionsRoot: tmpRoot,
    cwd,
    sid: codexSid,
    startAt: new Date(Date.now() - 60 * 60 * 1000),
  });
  await fr.start();
  await fr.writeTaskComplete('sid repaired answer', 100, { at: new Date() });
  await fr.close();

  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const hubSid = 'hub-resume-codex-stale-path';
  try {
    tap.registerSession(hubSid, {
      cwd,
      codexSid,
      transcriptPath: path.join(tmpRoot, 'missing-rollout.jsonl'),
    });
    const bound = await waitFor(() => {
      const snap = tap.getDebugSnapshot();
      return snap.bound.find((b) => b.hubSessionId === hubSid);
    });
    assert.ok(bound, 'a stale persisted path must fall back to the exact codexSid');
    assert.strictEqual(bound.rolloutPath, fr.rolloutPath);
  } finally {
    tap.unregisterSession(hubSid);
    await fr.cleanup();
  }
}

async function testResumeSidLookupStaysInsideRequestedProfileRoot() {
  const tmpBase = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-resume-profile-root-'));
  const mainRoot = path.join(tmpBase, 'main', 'sessions');
  const secondRoot = path.join(tmpBase, 'second', 'sessions');
  const cwd = path.join(tmpBase, 'workspace');
  const codexSid = '019e9999-eeee-7fff-8aaa-123456789abc';
  const startAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  const mainRollout = new FakeCodexRollout({ sessionsRoot: mainRoot, cwd, sid: codexSid, startAt });
  const secondRollout = new FakeCodexRollout({ sessionsRoot: secondRoot, cwd, sid: codexSid, startAt });
  await mainRollout.start();
  await mainRollout.writeTaskComplete('wrong profile answer');
  await mainRollout.close();
  await secondRollout.start();
  await secondRollout.writeTaskComplete('second profile answer');
  await secondRollout.close();

  const tap = new CodexTap({ sessionsRoot: mainRoot, pollIntervalMs: 50 });
  const hubSid = 'hub-resume-codex-second-profile';
  try {
    tap.registerSession(hubSid, { cwd, codexSid, sessionsRoot: secondRoot });
    const bound = await waitFor(() => {
      const snap = tap.getDebugSnapshot();
      return snap.bound.find((b) => b.hubSessionId === hubSid);
    });
    assert.ok(bound, 'profile-scoped SID lookup should bind');
    assert.strictEqual(bound.rolloutPath, secondRollout.rolloutPath,
      'the same SID in the default profile must not win over the requested profile root');
  } finally {
    tap.unregisterSession(hubSid);
    await fs.promises.rm(tmpBase, { recursive: true, force: true });
  }
}

async function testResumeBindsOldRolloutByFreshMtimeWhenSidMissing() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-resume-mtime-'));
  const cwd = path.join(os.tmpdir(), 'codex-resume-project-mtime');
  const codexSid = '019e9999-bbbb-7ccc-8ddd-123456789abc';
  const oldStart = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: codexSid, startAt: oldStart });
  await fr.start();
  await fr.writeTaskComplete('mtime fallback final answer', 100, { at: new Date() });
  await fr.close();

  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const hubSid = 'hub-resume-codex-mtime';
  try {
    tap.registerSession(hubSid, { cwd, allowMtimeFallback: true });
    const bound = await waitFor(() => {
      const snap = tap.getDebugSnapshot();
      return snap.bound.find((b) => b.hubSessionId === hubSid);
    });
    assert.ok(bound, 'CodexTap should bind old resume rollout by fresh mtime when codexSid is missing');

    const extracted = await tap.extractLatestTurn(hubSid, 0);
    assert.strictEqual(extracted.extractMode, 'final_answer');
    assert.strictEqual(extracted.text, 'mtime fallback final answer');
  } finally {
    tap.unregisterSession(hubSid);
    await fr.cleanup();
  }
}

async function testFreshSessionDoesNotBindOldRolloutByFreshMtime() {
  const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'codex-fresh-no-mtime-'));
  const cwd = path.join(os.tmpdir(), 'codex-fresh-project-no-mtime');
  const codexSid = '019e9999-cccc-7ddd-8eee-123456789abc';
  const oldStart = new Date(Date.now() - 6 * 60 * 60 * 1000);
  const fr = new FakeCodexRollout({ sessionsRoot: tmpRoot, cwd, sid: codexSid, startAt: oldStart });
  await fr.start();
  await fr.writeTaskComplete('external session answer should not bind to fresh hub session', 100, { at: new Date() });
  await fr.close();

  const tap = new CodexTap({ sessionsRoot: tmpRoot, pollIntervalMs: 50 });
  const hubSid = 'hub-fresh-codex-no-mtime';
  try {
    tap.registerSession(hubSid, { cwd });
    const bound = await waitFor(() => {
      const snap = tap.getDebugSnapshot();
      return snap.bound.find((b) => b.hubSessionId === hubSid);
    }, 500, 50);
    assert.strictEqual(bound, null, 'fresh Codex sessions must not bind old rollout files by mtime fallback');
  } finally {
    tap.unregisterSession(hubSid);
    await fr.cleanup();
  }
}

(async () => {
  console.log('Running Codex resume bind-by-sid test...');
  await testResumeBindsExistingRolloutByCodexSid();
  await testResumeFallsBackToSidWhenPersistedPathIsStale();
  await testResumeSidLookupStaysInsideRequestedProfileRoot();
  await testResumeBindsOldRolloutByFreshMtimeWhenSidMissing();
  await testFreshSessionDoesNotBindOldRolloutByFreshMtime();
  console.log('  OK');
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
