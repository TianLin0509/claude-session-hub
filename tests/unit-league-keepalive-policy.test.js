'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  decideLeagueKeepalive,
  KEEP_REASONS,
  DROP_REASONS,
} = require('../core/league-keepalive-policy.js');

const SELF = 1000;
const OTHER = 2000;
const enabledSchedule = { enabled: true, keepAliveOnClose: true };
const aliveOnly = (pids) => (pid) => pids.includes(Number(pid));

function decide(overrides = {}) {
  return decideLeagueKeepalive({
    selfPid: SELF,
    schedule: enabledSchedule,
    isProcessAlive: aliveOnly([SELF, OTHER]),
    ...overrides,
  });
}

test('standby Hub quits on window close instead of becoming a useless tray daemon', () => {
  // 这是本次修复的核心行为：另一个活着的 Hub 是调度主控，本实例留下来也不会执行赛程，
  // 却会一直攥着它名下 Codex 的 thread writer 锁。
  const decision = decide({
    election: { enabled: true, available: true, isPreferred: false, preferred: { pid: OTHER } },
  });
  assert.equal(decision.keep, false);
  assert.equal(decision.reason, DROP_REASONS.PREFERRED_ELSEWHERE);
  assert.equal(decision.preferredPid, OTHER);
});

test('the preferred Hub still keeps the schedule alive in the tray', () => {
  const decision = decide({
    election: { enabled: true, available: true, isPreferred: true, preferred: { pid: SELF } },
  });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, KEEP_REASONS.SELF_PREFERRED);
});

test('a stale preference pointing at a dead Hub does not leave the league unattended', () => {
  const decision = decide({
    election: { enabled: true, available: true, isPreferred: false, preferred: { pid: 4242 } },
    isProcessAlive: aliveOnly([SELF]),
  });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, KEEP_REASONS.PREFERRED_GONE);
});

test('an unavailable election falls back to staying resident, never to dropping the last Hub', () => {
  for (const election of [null, undefined, { enabled: false }, { enabled: true, available: false }]) {
    const decision = decide({ election });
    assert.equal(decision.keep, true, `election=${JSON.stringify(election)} 必须兜底留守`);
    assert.equal(decision.reason, KEEP_REASONS.ELECTION_UNAVAILABLE);
  }
});

test('an election with no preferred pid yet also falls back to staying resident', () => {
  const decision = decide({ election: { enabled: true, available: true, isPreferred: false, preferred: null } });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, KEEP_REASONS.PREFERRED_UNKNOWN);
});

test('an in-flight run this Hub owns outranks the election', () => {
  // 主控可能刚被更新的实例抢走，但本轮的检查点在本进程里，关窗不能把它丢掉。
  const decision = decide({
    activeRun: { runId: 'league-20260904-x', mode: 'daily' },
    election: { enabled: true, available: true, isPreferred: false, preferred: { pid: OTHER } },
  });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, KEEP_REASONS.ACTIVE_RUN);
});

test('explicit quit, env kill-switch and the user preference all still win', () => {
  assert.equal(decide({ explicitQuitRequested: true }).reason, DROP_REASONS.EXPLICIT_QUIT);
  assert.equal(decide({ disabledByEnv: true }).reason, DROP_REASONS.DISABLED_BY_ENV);
  assert.equal(decide({ schedule: { enabled: true, keepAliveOnClose: false } }).reason, DROP_REASONS.KEEPALIVE_OFF);
  assert.equal(decide({ schedule: { enabled: false, keepAliveOnClose: true } }).reason, DROP_REASONS.NO_SCHEDULE);
  for (const reason of Object.values(DROP_REASONS)) {
    assert.equal(typeof reason, 'string');
  }
});

test('a disabled schedule with an in-flight run still keeps the Hub resident', () => {
  const decision = decide({
    schedule: { enabled: false, keepAliveOnClose: true },
    activeRun: { runId: 'league-20260904-x' },
  });
  assert.equal(decision.keep, true);
  assert.equal(decision.reason, KEEP_REASONS.ACTIVE_RUN);
});

test('two Hubs closing at the same time leave exactly one resident', () => {
  // 同一份选举结果喂给两个实例：只有被选中的那个留守，另一个退出。
  const election = { enabled: true, available: true, preferred: { pid: OTHER } };
  const standby = decideLeagueKeepalive({
    selfPid: SELF,
    schedule: enabledSchedule,
    election: { ...election, isPreferred: false },
    isProcessAlive: aliveOnly([SELF, OTHER]),
  });
  const preferred = decideLeagueKeepalive({
    selfPid: OTHER,
    schedule: enabledSchedule,
    election: { ...election, isPreferred: true },
    isProcessAlive: aliveOnly([SELF, OTHER]),
  });
  assert.deepEqual([standby.keep, preferred.keep], [false, true]);
});
