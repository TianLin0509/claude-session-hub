'use strict';

// Claude 握手等待预算按历史体积放宽（2026-09-18 事故修复）。
//
// 事故记录：从 17.1 MB 的会话分支出群聊成员，初始化实测 124.6 秒（未分段归因）；
// initialize 等待写死 60 秒 → 判连接失败 →
// 群聊那条提交被标「待核对」、侧栏亮异常 → 一分钟后引擎其实连上并跑完了这一轮。
//
// 守住超时容错，同时确保不把等待预算说成引擎进度或预计耗时。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  BASE_MS, MAX_MS, initializeTimeoutMsForBytes, resolveHandshakeBudget,
} = require('../core/claude-handshake-timeout.js');
const { ClaudeNativeSession } = require('../core/claude-native-session.js');
const { buildComposerStatusModel } = require('../core/session-status-summary.js');
const { deriveSessionRuntimeStatus } = require('../renderer/session-runtime-status.js');

const MB = 1024 * 1024;
const UUID = '11111111-2222-3333-4444-555555555555';
const PARENT = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

test('全新会话仍然是原来的 60 秒', () => {
  assert.equal(initializeTimeoutMsForBytes(0), BASE_MS);
  assert.equal(resolveHandshakeBudget({}).timeoutMs, BASE_MS);
  assert.equal(resolveHandshakeBudget({ resumeSessionId: '' }).timeoutMs, BASE_MS);
});

test('历史越大等得越久，但有封顶', () => {
  // 事故里那 17.1 MB 实测要 ≥125 秒，新预算必须明显大于它才有意义。
  const real = initializeTimeoutMsForBytes(17.1 * MB);
  assert.ok(real > 125_000, `17.1 MB 的预算必须覆盖实测的 125 秒，实际 ${real}ms`);
  assert.ok(initializeTimeoutMsForBytes(50 * MB) > real, '更大的历史应该给更久');
  assert.equal(initializeTimeoutMsForBytes(10_000 * MB), MAX_MS, '再大也要封顶，否则坏掉的启动会无限等');
  assert.ok(MAX_MS > BASE_MS);
});

test('量不到父会话文件时回落到基准，不因为量不准而启动失败', () => {
  const budget = resolveHandshakeBudget({
    resumeSessionId: PARENT,
    homeDir: path.join(os.tmpdir(), 'hub-handshake-no-such-home-' + Date.now()),
  });
  assert.equal(budget.timeoutMs, BASE_MS);
  assert.equal(budget.bytes, 0);
  assert.equal(budget.reason, null);
  // stat 抛错同样只能降级，不能抛给启动链路。
  const thrown = resolveHandshakeBudget({
    resumeSessionId: PARENT,
    statFile: () => { throw new Error('probe: stat failed'); },
  });
  assert.equal(thrown.timeoutMs, BASE_MS);
});

test('真的有大历史时按文件大小放宽，并给出一句能显示的说明', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handshake-'));
  const projectDir = path.join(home, '.claude', 'projects', 'C--AIWork');
  fs.mkdirSync(projectDir, { recursive: true });
  const transcript = path.join(projectDir, `${PARENT}.jsonl`);
  fs.writeFileSync(transcript, 'x'.repeat(4 * MB));
  try {
    const budget = resolveHandshakeBudget({ resumeSessionId: PARENT, homeDir: home });
    assert.equal(budget.transcriptPath, transcript);
    assert.equal(budget.bytes, 4 * MB);
    assert.equal(budget.timeoutMs, initializeTimeoutMsForBytes(4 * MB));
    assert.ok(budget.timeoutMs > BASE_MS);
    assert.match(budget.reason, /正在连接 Claude/);
    assert.doesNotMatch(budget.reason, /一两分钟|正在载入|秒/);
    assert.match(budget.reason, /4\.0 MB/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('启动时传递超时预算，但界面只说明正在连接', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-handshake-start-'));
  const projectDir = path.join(home, '.claude', 'projects', 'C--AIWork');
  fs.mkdirSync(projectDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, `${PARENT}.jsonl`), 'x'.repeat(6 * MB));
  try {
    const native = new ClaudeNativeSession({
      id: 's1', kind: 'claude', cwd: process.cwd(), sessionId: UUID,
      resumeSessionId: PARENT, fork: true, homeDir: home,
    });
    const reasons = [];
    native.on('state', snapshot => reasons.push(snapshot.reason));
    let seen = null;
    native.options.clientFactory = (options) => {
      seen = options;
      throw new Error('probe: no engine in this test');
    };
    await assert.rejects(() => native.start(), /probe: no engine/);
    assert.ok(seen, 'clientFactory 必须拿到启动参数');
    assert.equal(seen.initializeTimeoutMs, initializeTimeoutMsForBytes(6 * MB));
    assert.ok(seen.launchArgs.includes('--fork-session'), '分支仍然走 --fork-session');
    assert.ok(reasons.some(r => /正在连接 Claude/.test(String(r || ''))),
      '载入期必须把正在做什么发出去，而不是让界面干等「等待连接响应」');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('调用方显式给了 initializeTimeoutMs 就听它的', async () => {
  const native = new ClaudeNativeSession({
    id: 's1', kind: 'claude', cwd: process.cwd(), sessionId: UUID,
    resumeSessionId: PARENT, initializeTimeoutMs: 1234,
  });
  let seen = null;
  native.options.clientFactory = (options) => { seen = options; throw new Error('probe'); };
  await assert.rejects(() => native.start(), /probe/);
  assert.equal(seen.initializeTimeoutMs, 1234);
});

test('载入期的输入框说人话，连接真断了才说断了', () => {
  const loading = {
    runtimeBackend: 'claude-stream-json',
    nativeRuntime: { state: 'unknown', connection: 'connecting', reason: '正在连接 Claude（历史 17.1 MB）' },
  };
  const model = buildComposerStatusModel(loading, { runtime: deriveSessionRuntimeStatus(loading) });
  assert.match(model.text, /正在连接 Claude/);

  // 没有理由可说时保持原样。
  const bare = { runtimeBackend: 'claude-stream-json', nativeRuntime: { state: 'unknown', connection: 'connecting' } };
  assert.equal(buildComposerStatusModel(bare, { runtime: deriveSessionRuntimeStatus(bare) }).text, '等待连接响应');

  // 真的断了仍然要说断了 —— 载入中的措辞不能盖掉故障。
  const dead = {
    runtimeBackend: 'claude-stream-json',
    nativeRuntime: { state: 'unknown', connection: 'disconnected', reason: '正在载入历史（17.1 MB）' },
  };
  assert.equal(buildComposerStatusModel(dead, { runtime: deriveSessionRuntimeStatus(dead) }).text, '连接已断开');
});
