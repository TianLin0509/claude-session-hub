'use strict';

// 自动休眠对所有可恢复 CLI 一视同仁——这里用测试把它钉死。
//
// 起因：用户观察到「Codex 会话会自动休眠，Claude Code 好像不会」。
// 排查结论是功能本来就覆盖 Claude（core/session-capabilities.js 里
// supportsRecoverableSession 含 claude，nativeSessionIdentity 对 claude 认
// ccSessionId），线上也确有 Claude 会话按 idle-timeout 休眠的记录；
// 真正的问题是 suspendIdleSessions 把 skipped 原因丢掉了，界面只显示
// 「已请求 N 个」，于是「有没有休眠」在 UI 上无从验证。
//
// 所以这份测试锁两件事：
//   1. 同等条件下 claude / codex / gemini / kimi 的判定结果必须一致；
//   2. 预演与真执行共用同一套闸门，不会漂移。

const assert = require('node:assert/strict');
const test = require('node:test');

const { SessionManager } = require('../core/session-manager.js');
const { createSessionAutoSuspendScheduler } = require('../main/session-auto-suspend.js');

const HOUR = 60 * 60 * 1000;

// 造一个只带 info 的假会话：闸门只读 info + 活动时间戳，不碰 pty。
function seed(manager, id, info, activityAt) {
  manager.sessions.set(id, {
    info: { hubId: id, ...info },
    pty: null,
    pendingTimers: [],
    startedAt: activityAt,
    lastInputAt: activityAt,
    lastOutputAt: activityAt,
    suspendRequestedAt: 0,
  });
}

test('闲置够久时，四家 CLI 的休眠判定完全一致（Claude 不被区别对待）', () => {
  const manager = new SessionManager();
  const now = Date.now();
  const longIdle = now - 9 * HOUR;

  seed(manager, 's-claude', { kind: 'claude', title: 'C', ccSessionId: 'cc-1' }, longIdle);
  seed(manager, 's-codex', { kind: 'codex', title: 'X', codexSid: 'sid-1' }, longIdle);
  seed(manager, 's-gemini', { kind: 'gemini', title: 'G', geminiChatId: 'gid-1' }, longIdle);
  seed(manager, 's-kimi', { kind: 'kimi', title: 'K', kimiSid: 'kid-1' }, longIdle);

  const preview = manager.previewIdleSuspend({ idleMs: 5 * HOUR, now });
  assert.equal(preview.ok, true);
  assert.equal(preview.total, 4);
  assert.equal(preview.eligibleCount, 4, `应当四家全部够钟，实际: ${JSON.stringify(preview.byReason)}`);

  for (const item of preview.items) {
    assert.equal(item.eligible, true, `${item.kind} 未通过闸门：${item.message}`);
    assert.ok(item.idleMs >= 9 * HOUR - 1000, `${item.kind} 闲置时长计算异常`);
  }
});

test('缺原生会话 ID 时同样一视同仁地被拦住，且原因可读', () => {
  const manager = new SessionManager();
  const now = Date.now();
  const longIdle = now - 9 * HOUR;

  seed(manager, 'no-cc', { kind: 'claude', title: 'C' }, longIdle);
  seed(manager, 'no-sid', { kind: 'codex', title: 'X' }, longIdle);

  const preview = manager.previewIdleSuspend({ idleMs: 5 * HOUR, now });
  assert.equal(preview.eligibleCount, 0);
  for (const item of preview.items) {
    assert.equal(item.reason, 'native-session-id-missing');
    assert.match(item.message, /原生会话 ID/);
  }
});

test('还没到钟的会话会报出「还差多久」，这是界面上解释原因的依据', () => {
  const manager = new SessionManager();
  const now = Date.now();

  seed(manager, 'fresh', { kind: 'claude', title: 'C', ccSessionId: 'cc-1' }, now - 2 * HOUR);

  const preview = manager.previewIdleSuspend({ idleMs: 5 * HOUR, now });
  const item = preview.items[0];
  assert.equal(item.eligible, false);
  assert.equal(item.reason, 'recently-active');
  assert.ok(Math.abs(item.remainingMs - 3 * HOUR) < 1000, `还差的时间应约为 3 小时，实际 ${item.remainingMs}`);
});

test('预演绝不动任何会话：跑完 sessions 一个不少', () => {
  const manager = new SessionManager();
  const now = Date.now();
  seed(manager, 'a', { kind: 'claude', title: 'C', ccSessionId: 'cc-1' }, now - 9 * HOUR);
  seed(manager, 'b', { kind: 'codex', title: 'X', codexSid: 'sid-1' }, now - 9 * HOUR);

  const before = [...manager.sessions.keys()].sort();
  manager.previewIdleSuspend({ idleMs: 5 * HOUR, now });
  assert.deepEqual([...manager.sessions.keys()].sort(), before, '预演不应删除或改动任何会话');
  for (const session of manager.sessions.values()) {
    assert.equal(session.suspendRequestedAt, 0, '预演不应把会话置为 suspending');
  }
});

test('调度器的预演与真实巡检共用同一份参数', () => {
  const seen = [];
  const scheduler = createSessionAutoSuspendScheduler({
    sessionManager: {
      suspendIdleSessions: options => { seen.push(['sweep', options]); return { ok: true, count: 0 }; },
      previewIdleSuspend: options => { seen.push(['preview', options]); return { ok: true, items: [] }; },
    },
    getProtectedSessionIds: () => new Set(['protected-1']),
    now: () => 1000,
    logger: { log() {}, warn() {} },
  });

  scheduler.preview();
  scheduler.sweep();

  const [previewOptions, sweepOptions] = [seen[0][1], seen[1][1]];
  for (const key of ['idleMs', 'excludePinned', 'excludeFocused', 'excludeMeeting']) {
    assert.equal(previewOptions[key], sweepOptions[key], `${key} 在预演和巡检之间不一致`);
  }
  assert.deepEqual([...previewOptions.excludeSessionIds], [...sweepOptions.excludeSessionIds]);
  // 只有真执行才带 reason；预演不写任何状态。
  assert.equal(sweepOptions.reason, 'idle-timeout');
  assert.equal(previewOptions.reason, undefined);
});
