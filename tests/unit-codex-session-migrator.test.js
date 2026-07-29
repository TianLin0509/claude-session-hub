'use strict';
// Codex 归档 cwd 迁移（2026-07-28）。
//
// 事故复盘：workspace 归档后群聊里的 Codex 成员静默失联，Hub 显示 idle。
// 实为 CLI 弹出 "Choose working directory to resume this session" 等按键 ——
// rollout 首行 session_meta.payload.cwd 还记着被移走的旧目录。
//
// 这里锁：改写只动首行、正文一字不改、格式仍是合法 JSONL、写坏之前先备份。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { rewriteRolloutCwd } = require('../core/codex-session-migrator.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log('  OK ' + name); }
  catch (error) { failed += 1; console.error('  FAIL ' + name + '\n    ' + (error && error.message)); }
}

// 备份一律落在临时 backupDir：单测绝不能写进生产 ~/.claude-session-hub。
function withRollout(fn, { meta, body } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migrate-'));
  const opts = { backupDir: path.join(dir, 'hub-backups') };
  const file = path.join(dir, 'rollout-test.jsonl');
  const head = JSON.stringify(meta || {
    timestamp: '2026-07-28T10:39:06.688Z',
    type: 'session_meta',
    payload: {
      session_id: '019fa84b-dc6b-7210-abaa-7723ed2c4e74',
      cwd: 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e',
      originator: 'codex-tui',
      cli_version: '0.144.0',
    },
  });
  const rest = body !== undefined ? body : [
    JSON.stringify({ type: 'message', payload: { role: 'user', text: '带 cwd 字样的正文不许被动' } }),
    JSON.stringify({ type: 'shell', payload: { command: 'pwd', cwd: 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e' } }),
  ].join('\n');
  fs.writeFileSync(file, head + '\n' + rest + '\n', 'utf8');
  try { return fn(file, dir, opts); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

console.log('Running codex session migrator tests...');

test('把首行 session_meta.cwd 改写成新目录', () => {
  withRollout((file, dir, opts) => {
    const target = 'C:\\Vibe\\AI\\AI-HUB-工作区重构与机制排查';
    const res = rewriteRolloutCwd(file, target, opts);
    assert.strictEqual(res.ok, true, res.reason);
    const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    assert.strictEqual(meta.payload.cwd, target);
  });
});

test('正文里的 cwd 一律不动（只有首行是权威）', () => {
  withRollout((file, dir, opts) => {
    rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\new-home', opts);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    const shell = JSON.parse(lines[2]);
    assert.strictEqual(shell.payload.cwd, 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e',
      'shell 记录里的历史 cwd 是事实，不能被改写');
  });
});

test('改写后仍是合法 JSONL，行数不变', () => {
  withRollout((file, dir, opts) => {
    const before = fs.readFileSync(file, 'utf8').trim().split('\n').length;
    rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\new-home', opts);
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.strictEqual(lines.length, before, '行数必须不变');
    lines.forEach((l, i) => assert.doesNotThrow(() => JSON.parse(l), `第 ${i} 行不是合法 JSON`));
  });
});

test('目标目录与当前一致时短路返回，不重写文件', () => {
  withRollout((file, dir, opts) => {
    const same = 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e';
    const mtimeBefore = fs.statSync(file).mtimeMs;
    const res = rewriteRolloutCwd(file, same, opts);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.alreadyCurrent, true);
    assert.strictEqual(fs.statSync(file).mtimeMs, mtimeBefore, '短路时不该碰文件');
  });
});

// 备份策略 2026-07-29 改为「只存首行的 sidecar」：rollout 有多大都只备份第一行，
// 因为迁移本来就只改第一行。累积/撞名/失败残留的完整回归见
// tests/unit-codex-migrator-backup.test.js。
test('改写前留下备份（只存首行，不在 rollout 旁边落全量 .bak）', () => {
  withRollout((file, dir, opts) => {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\new-home', opts);
    assert.strictEqual(res.ok, true, res.reason);

    const strays = fs.readdirSync(dir).filter(n => n !== path.basename(file) && n !== 'hub-backups');
    assert.deepStrictEqual(strays, [], 'rollout 目录里不许多出任何文件（.bak/.tmp 都不行）');

    const backups = fs.readdirSync(opts.backupDir);
    assert.strictEqual(backups.length, 1, '必须有且只有一份备份');
    assert.strictEqual(res.backup, path.join(opts.backupDir, backups[0]));

    const record = JSON.parse(fs.readFileSync(res.backup, 'utf8'));
    assert.strictEqual(record.originalCwd, 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e',
      '备份里应保留改写前的原值');
    const restoredMeta = JSON.parse(record.originalFirstLine);
    assert.strictEqual(restoredMeta.payload.cwd, 'C:\\Vibe\\_scratch\\inbox-20260728-183610-6ade8e',
      '首行原文必须可直接还原');
    assert.ok(fs.statSync(res.backup).size < 4096, '备份是 KB 级 sidecar，不是整份 rollout');
  });
});

test('首行不是 session_meta 时拒绝改写', () => {
  withRollout((file, dir, opts) => {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\new-home', opts);
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /session_meta/);
  }, { meta: { type: 'message', payload: { text: 'not a meta line' } } });
});

test('首行不是合法 JSON 时拒绝改写而不是抛异常', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-migrate-bad-'));
  const file = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(file, '{ this is not json\n{"type":"message"}\n', 'utf8');
  try {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\new-home', { backupDir: path.join(dir, 'hub-backups') });
    assert.strictEqual(res.ok, false);
    assert.match(res.reason, /首行不是合法 JSON/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('单行 rollout（没有正文）也能改写', () => {
  withRollout((file, dir, opts) => {
    const res = rewriteRolloutCwd(file, 'C:\\Vibe\\AI\\solo', opts);
    assert.strictEqual(res.ok, true, res.reason);
    const meta = JSON.parse(fs.readFileSync(file, 'utf8').split('\n')[0]);
    assert.strictEqual(meta.payload.cwd, 'C:\\Vibe\\AI\\solo');
  }, { body: '' });
});

if (failed > 0) {
  console.error(`codex session migrator: ${failed} FAILED`);
  process.exitCode = 1;
} else {
  console.log('All codex session migrator tests passed.');
}
