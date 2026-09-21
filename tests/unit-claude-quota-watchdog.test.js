'use strict';
// Contract test for the native-Claude quota watchdog.
//
// The feature's whole value is that it only ever resumes when it can prove the
// quota came back, so most of what follows asserts the *refusals*: every gate
// gets a case showing it delays a resume, and the send paths get cases showing
// an unconfirmed write is never retried.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  HORIZON_MS,
  STALE_AFTER_MS,
  RESET_GRACE_MS,
  MAX_REARMS,
  MAX_SEND_ATTEMPTS,
  CONTINUATION_PROMPT,
  armQuotaWait,
  bindingQuotaWindow,
  decideQuotaResume,
  describeQuotaWait,
  verifyRecovered,
} = require('../core/claude-quota-watchdog');
const { createClaudeQuotaResume } = require('../main/claude-quota-resume');

const T0 = 1_760_000_000_000;
const RESET = T0 + 3 * 60 * 60 * 1000;

function usageAt(pct5h, resets5h, extra = {}) {
  return {
    usage5h: { pct: pct5h, resetsAt: resets5h },
    usage7d: { pct: 20, resetsAt: T0 + 4 * 86400000 },
    observedAt: T0,
    ...extra,
  };
}

function readyRuntime(extra = {}) {
  return { present: true, dormant: false, connection: 'connected', state: 'failed',
    pendingRequests: 0, cancelling: false, unreconciled: false, backgroundBusy: false, startedAt: T0 - 1000, ...extra };
}

function armed(overrides = {}) {
  const result = armQuotaWait({ sessionId: 'sid-1', userMessageId: 'u1', reason: "You've hit your usage limit",
    usage: usageAt(100, RESET), usageObservedAt: T0, now: T0, rearms: 0 });
  assert.equal(result.ok, true, 'fixture should arm');
  // Jitter is random by design; pin it so the tests are about the gates.
  return { ...result.record, jitterMs: 0, ...overrides };
}

function testArming() {
  // The binding window is the exhausted one still counting down.
  assert.equal(bindingQuotaWindow(usageAt(100, RESET), T0).window, '5h');
  assert.equal(bindingQuotaWindow(usageAt(40, RESET), T0), null, 'a healthy window never binds');
  assert.equal(bindingQuotaWindow(usageAt(100, T0 - 1), T0), null, 'an already-past reset never binds');

  // No quota reading => no wait. Without it recovery could never be verified,
  // so the honest outcome is to refuse rather than to wait on the clock alone.
  assert.equal(armQuotaWait({ sessionId: 's', reason: 'usage limit reached', usage: null, usageObservedAt: 0, now: T0 }).code,
    'usage_unavailable');

  // Unrecognised failure text + merely high utilization is not enough: the
  // reading has to be unambiguous when the message does not corroborate.
  assert.equal(armQuotaWait({ sessionId: 's', reason: 'tool exploded', usage: usageAt(96, RESET), usageObservedAt: T0, now: T0 }).code,
    'not_quota_failure');
  // ...but an unambiguous reading carries the claim by itself. This is the path
  // that matters in production: the canonical limit message comes from the
  // server, so no local pattern can be trusted to match it.
  const quotaOnly = armQuotaWait({ sessionId: 's', reason: 'API Error: 429 something new', usage: usageAt(100, RESET), usageObservedAt: T0, now: T0 });
  assert.equal(quotaOnly.ok, true);
  assert.equal(quotaOnly.record.evidence, 'quota');
  assert.equal(armed().evidence, 'message+quota');

  // CLI parity refusals.
  assert.equal(armQuotaWait({ sessionId: 's', reason: 'usage limit reached', usage: usageAt(100, T0 + HORIZON_MS + 60000),
    usageObservedAt: T0, now: T0 }).code, 'horizon_exceeded');
  assert.equal(armQuotaWait({ sessionId: 's', reason: 'usage limit reached', usage: usageAt(100, RESET),
    usageObservedAt: T0, now: T0, rearms: MAX_REARMS }).code, 'rearm_cap');
  console.log('PASS arming refuses everything it cannot prove');
}

function testVerification() {
  const record = armed();
  // A reading taken before the reset says nothing about after it.
  assert.equal(verifyRecovered(record, usageAt(3, RESET + 18000000), T0, RESET + 60000).note, 'usage_predates_reset');
  // The window has to have actually rolled; a lower number alone is not proof.
  assert.equal(verifyRecovered(record, usageAt(3, RESET), RESET + 1000, RESET + 60000).note, 'window_not_rolled');
  // Rolled, but still pinned near the limit (another seat is burning it).
  assert.equal(verifyRecovered(record, usageAt(97, RESET + 18000000), RESET + 1000, RESET + 60000).note, 'quota_still_high');
  // The other window is now the wall, so resuming would just burn the turn.
  const sevenDayWall = usageAt(3, RESET + 18000000, { usage7d: { pct: 100, resetsAt: RESET + 86400000 } });
  assert.equal(verifyRecovered(record, sevenDayWall, RESET + 1000, RESET + 60000).note, 'other_window_exhausted');
  // All four conditions met.
  assert.equal(verifyRecovered(record, usageAt(3, RESET + 18000000), RESET + 1000, RESET + 60000).ok, true);
  console.log('PASS recovery needs a post-reset reading, a rolled window and both windows healthy');
}

function testDecisions() {
  const record = armed();
  const after = RESET + RESET_GRACE_MS + 1000;
  const good = usageAt(3, RESET + 18000000);
  const base = { now: after, enabled: true, runtime: readyRuntime(), usage: good, usageObservedAt: RESET + 1000 };

  assert.equal(decideQuotaResume(record, base).action, 'fire');
  assert.equal(decideQuotaResume(record, { ...base, enabled: false }).action, 'cancel');
  assert.equal(decideQuotaResume(record, { ...base, runtime: { present: false } }).action, 'cancel');
  // The user speaking supersedes the wait, exactly as manual_submit does in the CLI.
  assert.equal(decideQuotaResume(record, { ...base, runtime: readyRuntime({ startedAt: record.armedAt + 5 }) }).note, 'manual_submit');

  // Every one of these can only postpone.
  const holds = {
    session_dormant: { dormant: true },
    not_connected: { connection: 'disconnected' },
    needs_reconciliation: { unreconciled: true },
    cancelling: { cancelling: true },
    awaiting_permission: { pendingRequests: 1 },
    session_busy: { state: 'running' },
  };
  for (const [note, patch] of Object.entries(holds)) {
    const decision = decideQuotaResume(record, { ...base, runtime: readyRuntime(patch) });
    assert.equal(decision.action, 'hold', note);
    assert.equal(decision.note, note);
  }
  // Background work counts as busy too.
  assert.equal(decideQuotaResume(record, { ...base, runtime: readyRuntime({ backgroundBusy: true }) }).note, 'session_busy');

  // Before the reset (plus grace) nothing is even looked at.
  assert.equal(decideQuotaResume(record, { ...base, now: RESET - 1 }).note, 'waiting_for_reset');
  assert.equal(decideQuotaResume(record, { ...base, now: RESET + 1 }).note, 'waiting_for_reset');

  // No reading yet -> hold, and ask the host to go get one.
  const unverified = decideQuotaResume(record, { ...base, usage: null, usageObservedAt: 0 });
  assert.equal(unverified.action, 'hold');
  assert.equal(unverified.needsUsage, true);

  // Held this long past its reset, the wait stops being invisible and becomes
  // a button. A wait nobody can see is the bug this feature exists to remove.
  const expired = { ...base, now: RESET + STALE_AFTER_MS + 1000 };
  assert.equal(decideQuotaResume(record, { ...expired, runtime: readyRuntime({ dormant: true }) }).action, 'stale');
  assert.equal(decideQuotaResume(record, { ...expired, usage: null, usageObservedAt: 0 }).action, 'stale');
  assert.equal(decideQuotaResume(record, { ...expired, usage: null, usageObservedAt: 0 }).needsUsage, undefined,
    'a stale record must not trigger another control call');
  // ...but a fully verified late record still resumes: being late is free.
  assert.equal(decideQuotaResume(record, expired).action, 'fire');

  assert.equal(decideQuotaResume({ ...record, sendAttempts: MAX_SEND_ATTEMPTS }, base).action, 'stale');
  assert.equal(decideQuotaResume({ ...record, status: 'stale' }, base).action, 'hold');
  console.log('PASS every gate can only delay a resume, never invent one');
}

function testDescription() {
  const record = armed();
  assert.match(describeQuotaWait(record, T0).text, /预计 \d\d:\d\d 继续/);
  assert.equal(describeQuotaWait(record, T0).canCancel, true);
  assert.match(describeQuotaWait({ ...record, status: 'stale', message: 'x' }, T0).text, /未自动继续/);
  assert.equal(describeQuotaWait({ ...record, status: 'resuming' }, T0).canResume, false);
  console.log('PASS the wait always states what it waits on and when');
}

// ── host ────────────────────────────────────────────────────────────────────
function harness({ sendImpl, usage = usageAt(100, RESET), statePath, clock = { t: T0 } } = {}) {
  const sent = [];
  const native = {
    runtime: { connection: 'connected', state: 'failed', requests: [], startedAt: T0 - 1000,
      reason: "You've hit your usage limit", userMessageId: 'u1', backgroundTasks: [], backgroundActivities: [] },
    unreconciled: false,
    published: [],
    prepareForNewPrompt: async () => {},
    readAccountUsage: async () => usage,
    setQuotaWait(wait) { this.published.push(wait ? { ...wait } : null); },
  };
  const session = { id: 'sid-1', kind: 'claude', status: 'active', runtimeBackend: 'claude-stream-json' };
  const controller = createClaudeQuotaResume({
    sessionManager: {
      getSession: id => (id === 'sid-1' ? session : null),
      getNativeClaude: id => (id === 'sid-1' ? native : null),
    },
    statePath,
    now: () => clock.t,
    logger: { log() {}, warn() {} },
    sendToPty: async (sid, text, kind, options) => {
      sent.push({ sid, text, kind, options });
      return sendImpl ? sendImpl(sent.length) : { ok: true, status: 'accepted', sendStatus: 'ok' };
    },
  });
  return { controller, native, session, sent, clock };
}

async function testHostResumes() {
  const h = harness();
  await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  assert.equal(h.controller.snapshot('sid-1').status, 'armed');
  assert.equal(h.native.published.at(-1).status, 'armed', 'the wait is published onto the runtime snapshot');

  // Before the reset, ticking does nothing at all.
  h.clock.t = RESET - 60000;
  await h.controller.tick();
  assert.equal(h.sent.length, 0);
  assert.equal(h.controller.snapshot('sid-1').note, 'waiting_for_reset');

  // After it, with a rolled window, the continuation goes out once.
  h.clock.t = RESET + RESET_GRACE_MS + 30000;
  h.native.readAccountUsage = async () => usageAt(4, RESET + 18000000, { observedAt: RESET + 1000 });
  h.controller.snapshot('sid-1').jitterMs = 0;
  await h.controller.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].text, CONTINUATION_PROMPT);
  assert.equal(h.sent[0].options.requireReady, false, 'the composer loop, not a cold-start wait');
  assert.equal(h.controller.snapshot('sid-1'), null, 'a confirmed resume clears the wait');
  assert.equal(h.native.published.at(-1), null);

  // A second tick must not send again.
  await h.controller.tick();
  assert.equal(h.sent.length, 1);
  console.log('PASS host waits, verifies, then resumes exactly once');
}

async function testHostSendOutcomes() {
  // Unconfirmed write: surfaced, never retried. This is the resend iron rule.
  const unknown = harness({ sendImpl: () => { throw Object.assign(new Error('timeout'), { code: 'CLAUDE_SUBMISSION_TIMEOUT' }); } });
  await unknown.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  await unknown.controller.resumeNow('sid-1');
  assert.equal(unknown.sent.length, 1);
  assert.equal(unknown.controller.snapshot('sid-1').status, 'stale');
  assert.match(unknown.controller.snapshot('sid-1').message, /无法确认|不会重发/);
  await unknown.controller.tick();
  assert.equal(unknown.sent.length, 1, 'an unconfirmed send is never retried');

  // A receipt that reports the submission as unknown is the same situation.
  const rejected = harness({ sendImpl: () => ({ ok: true, status: 'unknown' }) });
  await rejected.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  await rejected.controller.resumeNow('sid-1');
  assert.equal(rejected.controller.snapshot('sid-1').status, 'stale');

  // Provably-not-sent: retryable, but bounded.
  let attempts = 0;
  const notSent = harness({ sendImpl: () => { attempts++; throw Object.assign(new Error('reconnecting'), { code: 'CLAUDE_RECONNECTING' }); } });
  await notSent.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  notSent.clock.t = RESET + RESET_GRACE_MS + 30000;
  notSent.native.readAccountUsage = async () => usageAt(4, RESET + 18000000, { observedAt: RESET + 1000 });
  for (let i = 0; i < MAX_SEND_ATTEMPTS + 2; i++) {
    const record = notSent.controller.snapshot('sid-1');
    if (record) record.jitterMs = 0;
    await notSent.controller.tick();
  }
  assert.equal(attempts, MAX_SEND_ATTEMPTS, 'retries stop at the cap');
  assert.equal(notSent.controller.snapshot('sid-1').status, 'stale');
  console.log('PASS unconfirmed sends go stale; only provably-unsent ones retry, and only a bounded number of times');
}

async function testHostEpisodeAccounting() {
  const h = harness();
  const fresh = async () => {
    h.clock.t = T0;
    h.native.readAccountUsage = async () => usageAt(100, RESET);
    await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  };
  for (let round = 0; round < MAX_REARMS; round++) {
    await fresh();
    const record = h.controller.snapshot('sid-1');
    assert.equal(record.status, 'armed', `round ${round} arms`);
    assert.equal(record.rearms, round);
    record.jitterMs = 0;
    h.clock.t = RESET + RESET_GRACE_MS + 30000;
    h.native.readAccountUsage = async () => usageAt(4, RESET + 18000000, { observedAt: RESET + 1000 });
    await h.controller.tick();
    assert.equal(h.controller.snapshot('sid-1'), null);
  }
  // Repeated limit hits stop the loop rather than continuing forever.
  await fresh();
  assert.equal(h.controller.snapshot('sid-1').status, 'stale');
  assert.equal(h.sent.length, MAX_REARMS);

  // A turn that actually succeeds ends the episode, so the next quota wall
  // starts counting from zero again.
  await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'completed' });
  h.controller.cancel('sid-1');
  await fresh();
  assert.equal(h.controller.snapshot('sid-1').rearms, 0);
  console.log('PASS rearms are capped per episode and reset by a successful turn');
}

async function testHostPersistence() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-unit-'));
  const statePath = path.join(dir, 'claude-quota-waits.json');
  try {
    const first = harness({ statePath });
    await first.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).waits.length, 1);

    // A Hub restart must not silently forget the wait...
    const restarted = harness({ statePath, clock: { t: RESET - 60000 } });
    assert.equal(restarted.controller.snapshot('sid-1').status, 'armed');
    restarted.controller.start();
    assert.equal(restarted.native.published.at(-1).status, 'armed', 'a restored wait republishes itself');
    restarted.controller.stop();

    // ...but a Hub that was closed across the whole window hands the decision
    // back instead of resuming a task the user walked away from long ago.
    const late = harness({ statePath, clock: { t: RESET + STALE_AFTER_MS + 60000 } });
    late.native.readAccountUsage = async () => { throw new Error('offline'); };
    await late.controller.tick();
    assert.equal(late.controller.snapshot('sid-1').status, 'stale');
    assert.equal(late.sent.length, 0);

    late.controller.cancel('sid-1');
    assert.equal(JSON.parse(fs.readFileSync(statePath, 'utf8')).waits.length, 0);

    // A record persisted as `resuming` means the Hub died between the send and
    // its receipt. That write's fate is unknown, so it must come back as the
    // user's decision -- not as a wait parked in a status ticks skip forever,
    // and above all not as a second send.
    fs.writeFileSync(statePath, JSON.stringify({ schemaVersion: 1, waits: [
      { sessionId: 'sid-1', status: 'resuming', resetsAt: RESET, armedAt: T0, rearms: 0, sendAttempts: 1, window: '5h' },
    ] }));
    const crashed = harness({ statePath, clock: { t: RESET + 60000 } });
    assert.equal(crashed.controller.snapshot('sid-1').status, 'stale');
    assert.match(crashed.controller.snapshot('sid-1').message, /未确认/);
    await crashed.controller.tick();
    assert.equal(crashed.sent.length, 0, 'an interrupted resume is never re-sent on restart');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('PASS waits survive a restart and expire into a button rather than a surprise');
}

async function testNonQuotaFailuresDoNotPoll() {
  let reads = 0;
  const h = harness();
  h.native.runtime.reason = 'Error: the tool exploded';
  h.native.readAccountUsage = async () => { reads++; return usageAt(31, RESET); };
  for (let i = 0; i < 5; i++) await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  assert.equal(h.controller.snapshot('sid-1'), null, 'an ordinary failure never arms a wait');
  assert.equal(reads, 1, 'a seat failing in a loop must not cost one get_usage per failure');

  // A successful turn invalidates that answer: quota may well have moved since.
  await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'completed' });
  await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  assert.equal(reads, 2);
  console.log('PASS ordinary failures neither arm a wait nor poll the account repeatedly');
}

// Reading the account takes real time. A prompt the user sends inside that
// window starts a turn whose startedAt must still count as "the user spoke
// first" -- otherwise the wait arms on a later stamp, never sees their turn,
// and continues on top of work they already resumed by hand.
async function testUserPromptDuringArmingWins() {
  const h = harness();
  const armAt = T0;
  h.clock.t = armAt;
  h.native.readAccountUsage = async () => {
    // The user hits Enter while we are still asking about quota.
    h.clock.t = armAt + 4000;
    h.native.runtime.startedAt = armAt + 2000;
    return usageAt(100, RESET);
  };
  await h.controller.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  const record = h.controller.snapshot('sid-1');
  assert.ok(record, 'the wait still arms; the user turn is noticed on the next tick');
  assert.ok(record.armedAt <= armAt + 2000, 'armedAt is stamped before the account read');
  assert.ok(record.baselineStartedAt < armAt + 2000, 'the baseline is the failed turn, not the user one');
  record.jitterMs = 0;
  h.clock.t = RESET + RESET_GRACE_MS + 30000;
  h.native.readAccountUsage = async () => usageAt(4, RESET + 18000000, { observedAt: RESET + 1000 });
  await h.controller.tick();
  assert.equal(h.sent.length, 0, 'nothing is sent on top of the turn the user started');
  assert.equal(h.controller.snapshot('sid-1'), null, 'the wait is cancelled, not parked');
  console.log('PASS a prompt sent while the account is being read cancels the wait');
}

async function testDisabled() {
  const h = harness();
  const off = createClaudeQuotaResume({
    sessionManager: { getSession: () => h.session, getNativeClaude: () => h.native },
    isEnabled: () => false,
    now: () => T0,
    logger: { log() {}, warn() {} },
    sendToPty: async () => { throw new Error('must not send when disabled'); },
  });
  await off.onTurnComplete({ sessionId: 'sid-1', status: 'failed' });
  assert.equal(off.snapshot('sid-1'), null);
  console.log('PASS the switch really is a switch');
}

async function main() {
  testArming();
  testVerification();
  testDecisions();
  testDescription();
  await testHostResumes();
  await testHostSendOutcomes();
  await testHostEpisodeAccounting();
  await testHostPersistence();
  await testNonQuotaFailuresDoNotPoll();
  await testUserPromptDuringArmingWins();
  await testDisabled();
  console.log('\nunit-claude-quota-watchdog: all checks passed');
}

main().catch(error => { console.error(error); process.exit(1); });
