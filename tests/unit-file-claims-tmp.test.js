'use strict';
// 2026-09-26：Hub 数据目录攒了 252 个 file-claims.json.tmp.<pid>（内容全是截断的 JSON）。
// 写入方是 Claude PreToolUse hook scripts/file-scope-guard.py：原子写只在 OSError 时删 tmp，
// 用户中断 Claude 时落进 hook 进程的 KeyboardInterrupt 会把半截内容刷进 tmp 后穿出去。
// 这里守三件事：脚本任何异常都清 tmp；Hub 启动清 1 小时前的孤儿且只认这个精确前缀；
// 修好的脚本只升级用户已装的那份，不替用户新装。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const { cleanupFileClaimsTmp, FILE_CLAIMS_TMP_MAX_AGE_MS } = require('../core/file-claims-tmp-cleanup.js');
const { ensureClaudeHookIntegration, UPGRADE_ONLY_SCRIPT_FILES } = require('../core/claude-hook-integration.js');

const GUARD = path.resolve(__dirname, '..', 'scripts', 'file-scope-guard.py');

function tmpDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function touch(file, ageMs, now) {
  fs.writeFileSync(file, '{"x":', 'utf8');
  const t = new Date(now - ageMs);
  fs.utimesSync(file, t, t);
}

test('启动清理：只删 1 小时前的 file-claims.json.tmp.* 普通文件，其他一概不碰', () => {
  const dir = tmpDir('hub-claims-clean-');
  const now = Date.now();
  const hour = FILE_CLAIMS_TMP_MAX_AGE_MS;
  touch(path.join(dir, 'file-claims.json.tmp.111'), hour + 60_000, now);
  touch(path.join(dir, 'file-claims.json.tmp.222'), 2 * hour, now);
  touch(path.join(dir, 'file-claims.json.tmp.333'), 60_000, now); // 可能正在写，保留
  touch(path.join(dir, 'file-claims.json'), 5 * hour, now);
  touch(path.join(dir, 'file-claims.json.tmp.'), 5 * hour, now); // 没有后缀，不是那个模式
  touch(path.join(dir, 'other.json.tmp.444'), 5 * hour, now);
  touch(path.join(dir, 'xfile-claims.json.tmp.555'), 5 * hour, now);
  fs.mkdirSync(path.join(dir, 'file-claims.json.tmp.dir'));
  const old = new Date(now - 5 * hour);
  fs.utimesSync(path.join(dir, 'file-claims.json.tmp.dir'), old, old);

  const summary = cleanupFileClaimsTmp(dir, { now });
  assert.equal(summary.removed, 2);
  assert.deepEqual(summary.errors, []);
  const left = fs.readdirSync(dir).sort();
  assert.deepEqual(left, [
    'file-claims.json',
    'file-claims.json.tmp.',
    'file-claims.json.tmp.333',
    'file-claims.json.tmp.dir',
    'other.json.tmp.444',
    'xfile-claims.json.tmp.555',
  ]);
});

test('启动清理：数据目录不存在时安静返回', () => {
  const summary = cleanupFileClaimsTmp(path.join(os.tmpdir(), `hub-claims-missing-${process.pid}-${Date.now()}`));
  assert.deepEqual(summary, { scanned: 0, removed: 0, kept: 0, errors: [] });
});

const python = (() => {
  for (const cmd of ['python', 'python3']) {
    const r = spawnSync(cmd, ['--version'], { windowsHide: true });
    if (r.status === 0) return cmd;
  }
  return null;
})();

function runGuardHarness(dataDir, failure) {
  // 按文件路径加载脚本，把 json.dump / os.replace 换成抛指定异常，再调 save_claims。
  const code = `
import importlib.util, json, os, sys
spec = importlib.util.spec_from_file_location("guard", sys.argv[1])
guard = importlib.util.module_from_spec(spec)
spec.loader.exec_module(guard)
failure = sys.argv[2]
real_dump = json.dump
def partial_dump(obj, f, **kw):
    f.write("{\\n  ")
    raise KeyboardInterrupt()
def bad_replace(a, b):
    raise PermissionError(13, "locked")
if failure == "interrupt":
    guard.json.dump = partial_dump
elif failure == "oserror":
    guard.os.replace = bad_replace
try:
    guard.save_claims({"c:\\\\x": {"sessionId": "s"}})
    print("RETURNED")
except KeyboardInterrupt:
    print("RAISED_INTERRUPT")
`;
  return spawnSync(python, ['-c', code, GUARD, failure], {
    env: { ...process.env, CLAUDE_HUB_DATA_DIR: dataDir, PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
    windowsHide: true,
  });
}

test('file-scope-guard：写到一半被 KeyboardInterrupt 打断也删掉自己的 tmp，并照常抛出', { skip: !python && 'python 不可用' }, () => {
  const dir = tmpDir('hub-claims-guard-');
  const r = runGuardHarness(dir, 'interrupt');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RAISED_INTERRUPT/);
  assert.deepEqual(fs.readdirSync(dir).filter(n => n.startsWith('file-claims.json.tmp.')), []);
});

test('file-scope-guard：replace 被锁（OSError）时删 tmp 且不抛，与原行为一致', { skip: !python && 'python 不可用' }, () => {
  const dir = tmpDir('hub-claims-guard-');
  const r = runGuardHarness(dir, 'oserror');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /RETURNED/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('file-scope-guard：正常写入落到 file-claims.json，不留 tmp', { skip: !python && 'python 不可用' }, () => {
  const dir = tmpDir('hub-claims-guard-');
  const r = runGuardHarness(dir, 'none');
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readdirSync(dir), ['file-claims.json']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'file-claims.json'), 'utf8'))['c:\\x'].sessionId, 's');
});

test('部署：file-scope-guard.py 只升级用户已装的那份，不替用户新装', () => {
  assert.ok(UPGRADE_ONLY_SCRIPT_FILES.includes('file-scope-guard.py'));
  const root = tmpDir('hub-claims-deploy-');
  const src = path.join(root, 'src');
  fs.mkdirSync(src);
  fs.writeFileSync(path.join(src, 'file-scope-guard.py'), 'fixed\n', 'utf8');
  const quiet = { log() {}, warn() {} };

  const fresh = path.join(root, 'fresh', '.claude');
  const first = ensureClaudeHookIntegration({ claudeDir: fresh, sourceScriptsDir: src, logger: quiet });
  assert.ok(!first.scriptsUpdated.includes('file-scope-guard.py'));
  assert.equal(fs.existsSync(path.join(fresh, 'scripts', 'file-scope-guard.py')), false);

  const installed = path.join(root, 'installed', '.claude');
  fs.mkdirSync(path.join(installed, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(installed, 'scripts', 'file-scope-guard.py'), 'old\n', 'utf8');
  const second = ensureClaudeHookIntegration({ claudeDir: installed, sourceScriptsDir: src, logger: quiet });
  assert.ok(second.scriptsUpdated.includes('file-scope-guard.py'));
  assert.equal(fs.readFileSync(path.join(installed, 'scripts', 'file-scope-guard.py'), 'utf8'), 'fixed\n');
});
