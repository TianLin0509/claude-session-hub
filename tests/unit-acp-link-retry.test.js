'use strict';
// DSH 扩展包的目录链接：Windows 上偶发 EBUSY 时短暂重试，而不是让会话启动失败。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { linkWithRetry } = require('../core/acp-profiles');

test('目录链接遇到 EBUSY 会重试并建成', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acp-link-'));
  t.after(() => { try { fs.unlinkSync(path.join(root, 'link')); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  const real = fs.symlinkSync; let calls = 0;
  fs.symlinkSync = (...args) => { calls++; if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return real.apply(fs, args); };
  try { linkWithRetry(target, path.join(root, 'link')); } finally { fs.symlinkSync = real; }
  assert.equal(calls, 3);
  assert.equal(fs.realpathSync(path.join(root, 'link')), fs.realpathSync(target));
});

test('其他错误不重试，直接抛出', () => {
  const real = fs.symlinkSync; let calls = 0;
  fs.symlinkSync = () => { calls++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  try { assert.throws(() => linkWithRetry('C:/nonexistent-target', path.join(os.tmpdir(), 'hub-acp-link-none')), /nope/); } finally { fs.symlinkSync = real; }
  assert.equal(calls, 1);
});
