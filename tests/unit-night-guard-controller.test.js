'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_RECOVERY_PROMPT,
  createNightGuardController,
} = require('../core/night-guard-controller.js');

class FakeClock {
  constructor(now = 1000) { this.time = now; this.nextId = 1; this.timers = new Map(); }
  now = () => this.time;
  setTimeout = (fn, delay) => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.time + Number(delay || 0), fn });
    return id;
  };
  clearTimeout = id => { this.timers.delete(id); };
  async flush() {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  }
  async advance(ms) {
    const target = this.time + ms;
    while (true) {
      const next = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next) break;
      this.timers.delete(next[0]);
      this.time = next[1].at;
      next[1].fn();
      await this.flush();
    }
    this.time = target;
    await this.flush();
  }
}

function fixture(options = {}) {
  const clock = new FakeClock();
  const session = {
    id: 's1', kind: options.kind || 'codex',
    ...(options.kind === 'claude'
      ? { ccSessionId: '11111111-1111-4111-8111-111111111111' }
      : { codexSid: '11111111-1111-4111-8111-111111111111' }),
    currentModel: { id: 'gpt-5.6-sol' }, cwd: 'C:\\work',
  };
  const writes = [];
  const probes = [];
  const probeProviders = [];
  const audits = [];
  const controller = createNightGuardController({
    now: clock.now,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    graceMs: options.graceMs == null ? 0 : options.graceMs,
    healthyRoundIntervalMs: 10,
    quietMs: 0,
    failedProbeBackoffMs: [20],
    submitAckMs: 50,
    completionGraceMs: 0,
    goalCompletionFallbackMs: 20,
    getSession: () => session,
    updateSession(_id, state) { session.nightGuard = state; return session; },
    getProxy: () => 'http://127.0.0.1:7890',
    probeNetwork: async input => {
      const next = options.probeResults && options.probeResults.length
        ? options.probeResults.shift()
        : true;
      probes.push(next);
      probeProviders.push(input.provider);
      return { ok: next, endpoints: [] };
    },
    inspectRuntime: async () => ({ state: options.runtime || 'idle' }),
    continueLiveSession: async action => { writes.push({ route: 'live', ...action }); return { ok: true }; },
    resumeInPlace: async action => { writes.push({ route: 'host-shell', ...action }); return { ok: true }; },
    resumeDormant: async action => { writes.push({ route: 'missing', ...action }); return { ok: true }; },
    audit: record => audits.push(record),
  });
  return { clock, controller, session, writes, probes, probeProviders, audits };
}

async function reachRecovery(fx) {
  await fx.clock.advance(0);
  await fx.clock.advance(10);
  await fx.clock.advance(10);
}

test('final stream error waits for three healthy rounds then continues the same live PTY once', async () => {
  const fx = fixture();
  fx.controller.setEnabled('s1', true);
  fx.controller.handlePromptSubmitted({ hubSessionId: 's1', text: 'overnight task', turnId: 'turn-1', submittedAt: 1000 });
  assert.equal(fx.controller.handlePtyData('s1', 'Reconnecting... 5/5\n'), false);
  assert.equal(fx.controller.handlePtyData('s1', '\x1b[31m■ stream disconnected before completion: ECONNRESET\x1b[0m\r\n'), true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1001 });
  assert.equal(fx.controller.getStatus('s1').status, 'grace', 'late same-turn task_started must not cancel the incident');
  assert.equal(fx.controller.handlePtyData('s1', 'ordinary repaint after the old red line\n'), false);
  await reachRecovery(fx);
  assert.equal(fx.probes.length, 3);
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.writes[0].route, 'live');
  assert.equal(fx.writes[0].prompt, DEFAULT_RECOVERY_PROMPT);
  assert.equal(fx.controller.getStatus('s1').status, 'resuming');
  assert.equal(fx.controller.canSubmitRecoveryInput('s1', fx.controller.getStatus('s1').incidentId), true);
  assert.equal(fx.controller.handlePtyData('s1', 'recovery prompt echo\n'), false);
  assert.equal(fx.writes.length, 1, 'historical red line must not re-fire on later output');

  fx.controller.handlePromptSubmitted({
    hubSessionId: 's1', text: DEFAULT_RECOVERY_PROMPT, turnId: 'turn-2', submittedAt: fx.clock.now(),
  });
  fx.controller.handleTurnComplete({ hubSessionId: 's1', turnId: 'turn-2', completedAt: fx.clock.now() + 5 });
  assert.equal(fx.controller.getStatus('s1').enabled, false);
  assert.equal(fx.controller.getStatus('s1').status, 'completed');
  assert.equal(fx.controller.canSubmitRecoveryInput('s1', fx.writes[0].incidentId), false);
  assert.equal(fx.writes.length, 1, 'recovery prompt must be at-most-once');
});

test('human input cancels a queued incident before any network probe', async () => {
  const fx = fixture({ graceMs: 100 });
  fx.controller.setEnabled('s1', true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  assert.equal(fx.controller.handleUserInput('s1', '\r'), false, 'submit safety Enter is not human takeover');
  assert.equal(fx.controller.handleUserInput('s1', '继续'), true);
  await fx.clock.advance(200);
  assert.equal(fx.probes.length, 0);
  assert.equal(fx.writes.length, 0);
  assert.equal(fx.controller.getStatus('s1').status, 'armed');
});

test('a failed health round resets the counter and backs off', async () => {
  const fx = fixture({ probeResults: [false, true, true, true] });
  fx.controller.setEnabled('s1', true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  await fx.clock.advance(0);
  assert.equal(fx.controller.getStatus('s1').healthyRounds, 0);
  assert.equal(fx.writes.length, 0);
  await fx.clock.advance(20);
  await fx.clock.advance(10);
  await fx.clock.advance(10);
  assert.equal(fx.probes.length, 4);
  assert.equal(fx.writes.length, 1);
});

test('host-shell recovery uses precise resume and /goal closes on terminal goal status', async () => {
  const fx = fixture({ runtime: 'host-shell' });
  fx.controller.handleGoalUpdated({ hubSessionId: 's1', status: 'active', objective: 'finish safely', observedAt: 1000 });
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'goal-turn', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  await reachRecovery(fx);
  assert.equal(fx.writes[0].route, 'host-shell');
  fx.controller.handleGoalUpdated({ hubSessionId: 's1', status: 'completed', objective: 'finish safely', observedAt: 1100 });
  assert.equal(fx.controller.getStatus('s1').enabled, false);
  assert.equal(fx.controller.getStatus('s1').status, 'completed');
  assert.equal(fx.controller.getStatus('s1').goalStatus, 'completed');
});

test('same-turn late completion cancels recovery during the grace window', async () => {
  const fx = fixture({ graceMs: 100 });
  fx.controller.setEnabled('s1', true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  fx.controller.handleTurnComplete({ hubSessionId: 's1', turnId: 'turn-1', completedAt: 1050 });
  await fx.clock.advance(200);
  assert.equal(fx.writes.length, 0);
  assert.equal(fx.controller.getStatus('s1').status, 'completed');
});

test('missing PTY uses dormant exact-resume route', async () => {
  const fx = fixture({ runtime: 'missing' });
  fx.controller.setEnabled('s1', true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  await reachRecovery(fx);
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.writes[0].route, 'missing');
});

test('unacknowledged recovery blocks without resending the prompt', async () => {
  const fx = fixture();
  fx.controller.setEnabled('s1', true);
  fx.controller.handleTurnStarted({ hubSessionId: 's1', turnId: 'turn-1', startedAt: 1000 });
  fx.controller.handlePtyData('s1', '■ stream disconnected before completion: timeout\n');
  await reachRecovery(fx);
  assert.equal(fx.writes.length, 1);
  await fx.clock.advance(1000);
  assert.equal(fx.controller.getStatus('s1').status, 'blocked');
  assert.equal(fx.controller.getStatus('s1').enabled, false);
  assert.equal(fx.writes.length, 1, 'submit timeout must never replay the prompt');
});

test('Claude Code API Error uses the same guarded flow with Anthropic provider identity', async () => {
  const fx = fixture({ kind: 'claude' });
  fx.controller.setEnabled('s1', true);
  fx.controller.handlePromptSubmitted({
    hubSessionId: 's1', text: 'run overnight', submittedAt: 1000, signalSource: 'hook_prompt',
  });
  assert.equal(fx.controller.handleTurnFailed({
    hubSessionId: 's1',
    message: 'API Error: Connection dropped (ECONNRESET)',
    failedAt: 1001,
    signalSource: 'claude-stop-failure',
  }), true);
  const incidentId = fx.controller.getStatus('s1').incidentId;
  assert.equal(fx.controller.handleTurnComplete({
    hubSessionId: 's1',
    text: 'API Error: Connection dropped (ECONNRESET)',
    completedAt: 1002,
    signalSource: 'stop_hook',
  }), true);
  assert.equal(fx.controller.getStatus('s1').incidentId, incidentId,
    'synthetic Claude API error must not masquerade as late success');
  await reachRecovery(fx);
  assert.deepEqual(fx.probeProviders, ['claude', 'claude', 'claude']);
  assert.equal(fx.writes.length, 1);
  assert.equal(fx.writes[0].route, 'live');
  assert.equal(fx.audits.find(item => item.type === 'incident-detected').source, 'claude-stop-failure');
});
