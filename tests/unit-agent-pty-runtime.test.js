'use strict';
// 2026-09-25：Claude / Codex 默认跑 PTY 里的真实 CLI，原生后端只是回退开关。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('runtime mode defaults to pty; native only by explicit switch; junk falls back to pty', () => {
  const { agentRuntimeMode, usesNativeAgentRuntime, usesPtyAgentRuntime } = require('../core/agent-runtime-mode');
  assert.equal(agentRuntimeMode({}), 'pty');
  assert.equal(agentRuntimeMode({ agentRuntime: 'native' }), 'native');
  assert.equal(agentRuntimeMode({ agentRuntime: 'NATIVE ' }), 'native');
  const warn = console.warn; console.warn = () => {};
  try { assert.equal(agentRuntimeMode({ agentRuntime: 'app-server' }), 'pty'); } finally { console.warn = warn; }
  for (const kind of ['claude', 'claude-resume', 'codex', 'codex-resume']) {
    assert.equal(usesPtyAgentRuntime(kind, {}), true, kind);
    assert.equal(usesNativeAgentRuntime(kind, { agentRuntime: 'native' }), true, kind);
  }
  for (const kind of ['deepseek', 'kimi', 'gemini', 'powershell', 'qwen']) {
    assert.equal(usesPtyAgentRuntime(kind, {}), false, kind);
    assert.equal(usesNativeAgentRuntime(kind, { agentRuntime: 'native' }), false, kind);
  }
});

test('PTY Claude launch fixes its identity before the CLI starts', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pty-launch-'));
  const configDir = path.join(root, 'claude');
  const cwd = path.join(root, 'work');
  fs.mkdirSync(cwd, { recursive: true });
  const previous = process.env.CLAUDE_HUB_DATA_DIR;
  process.env.CLAUDE_HUB_DATA_DIR = path.join(root, 'hub');
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  });
  const { buildClaudePtyLaunch } = require('../core/session-manager')._private;
  const env = { CLAUDE_CONFIG_DIR: configDir };
  const cv = { CLAUDE_BACKEND: 'subscription' };
  const fresh = buildClaudePtyLaunch('hub-1', 'claude', { model: 'claude-opus-5-5', effort: 'high' }, cwd, env, cv);
  assert.match(fresh.sessionId, /^[0-9a-f-]{36}$/);
  assert.match(fresh.cmd, new RegExp(`^ claude --session-id ${fresh.sessionId} --model claude-opus-5-5 --effort high`));
  assert.ok(fresh.cmd.endsWith('\r\n'));

  // 原生时代分配过 id 但从未开聊的席位：没有历史 → 用同一个 id 新开，而不是 --resume 失败。
  const seat = '11111111-2222-4333-8444-555555555555';
  const unstarted = buildClaudePtyLaunch('hub-2', 'claude', { model: 'm', resumeCCSessionId: seat }, cwd, env, cv);
  assert.equal(unstarted.sessionId, seat);
  assert.match(unstarted.cmd, new RegExp(`--session-id ${seat}`));
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  fs.mkdirSync(path.join(configDir, 'projects', slug), { recursive: true });
  fs.writeFileSync(path.join(configDir, 'projects', slug, seat + '.jsonl'), '{}\n');
  const resumed = buildClaudePtyLaunch('hub-2', 'claude', { model: 'm', resumeCCSessionId: seat }, cwd, env, cv);
  assert.match(resumed.cmd, new RegExp(`--resume ${seat}`));
  assert.doesNotMatch(resumed.cmd, /--session-id/);

  const fork = buildClaudePtyLaunch('hub-3', 'claude', { model: 'm', forkCCSessionId: seat }, cwd, env, cv);
  assert.notEqual(fork.sessionId, seat);
  assert.match(fork.cmd, new RegExp(`--resume ${seat} --fork-session --session-id ${fork.sessionId}`));

  const spaced = buildClaudePtyLaunch('hub-4', 'claude', { model: 'm', appendSystemPromptFile: "C:\\a b\\it's.md" }, cwd, env, cv);
  assert.ok(spaced.cmd.includes("'C:\\a b\\it''s.md'"), 'paths are passed as PowerShell literals');
});

test('PTY agent sessions open in the terminal and remember an explicit card choice', () => {
  const { selectionViewModeFor, rememberViewMode } = require('../core/session-view-mode');
  const set = new Set();
  assert.equal(selectionViewModeFor(set, 's1', { cardCapable: true, rememberChoice: true }), 'pty');
  rememberViewMode(set, 's1', 'card');
  assert.equal(selectionViewModeFor(set, 's1', { cardCapable: true, rememberChoice: true }), 'card');
  // 其他会话（原生回退、Kimi 等）保持现有的卡片默认。
  assert.equal(selectionViewModeFor(new Set(), 's2', { cardCapable: true }), 'card');
  assert.equal(selectionViewModeFor(set, 's1', { cardCapable: false, rememberChoice: true }), 'pty');
});

test('PTY Codex keeps Hub hook identity in env and enables hooks on the command line', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'core', 'session-manager.js'), 'utf8');
  const block = source.slice(source.indexOf("for (const key of ['CODEX_THREAD_ID'"));
  assert.match(block.slice(0, 900), /if \(!isNativeCodex\) \{[\s\S]*?sessionEnv\.CLAUDE_HUB_SESSION_ID = id;/);
  assert.match(source, /ensureCodexHookIntegration\(\{[\s\S]*?cmd \+= ` -c features\.hooks=true`;/);
  // 原生回退仍然不能让 hook 拿到 Hub 身份：App Server 自己是状态来源。
  assert.match(source, /isNativeCodex\n?\s*\? new CodexSessionClass/);
});

test('screen evidence cannot drag a PTY turn that hooks/transcripts already settled back to running', () => {
  // 2026-09-25 真机：Codex 内联界面的旧「• Working … esc to interrupt」行留在缓冲区里，
  // 每次完成约一秒后都被屏幕识别改回运行。新一轮只能由 hook / task_started 开启。
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  const fn = source.slice(source.indexOf('function applyPtyRuntimeObservation('));
  assert.match(fn.slice(0, 2500), /runtime\.state === 'running' && session\.agentRuntime === 'pty'[\s\S]{0,200}truthBefore\.confidence === CONFIDENCE_AUTHORITATIVE\)[\s\S]{0,400}return false;/);
});

test('renderer defines the showToast helper its error paths call', () => {
  // 2026-09-25：14 处调用、零处定义，「消息未发送」的提示路径一执行就 ReferenceError。
  const source = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(source, /\nfunction showToast\(message, level\) \{/);
});
