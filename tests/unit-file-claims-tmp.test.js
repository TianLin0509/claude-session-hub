'use strict';
// 2026-09-26：Hub 数据目录攒了 252 个 file-claims.json.tmp.<pid>（内容全是截断的 JSON）。
// 写入方是用户自己的 Claude PreToolUse hook ~/.claude/scripts/file-scope-guard.py（不归 Hub 管，
// 2026-09-27 已在用户本机直接修好：任何异常都删自己的 tmp）。进程被硬杀时仍可能留下孤儿，
// 这里守 Hub 启动清理：只删 1 小时前、精确匹配 file-claims.json.tmp.* 的普通文件。

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { cleanupFileClaimsTmp, FILE_CLAIMS_TMP_MAX_AGE_MS } = require('../core/file-claims-tmp-cleanup.js');

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
