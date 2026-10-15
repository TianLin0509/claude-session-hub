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
  const real = fs.symlinkSync; let calls = 0; const nativeRetryErrors = [];
  fs.symlinkSync = (...args) => {
    calls++;
    if (calls <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
    try { return real.apply(fs, args); }
    catch (error) { nativeRetryErrors.push(error.code); throw error; }
  };
  try { linkWithRetry(target, path.join(root, 'link')); } finally { fs.symlinkSync = real; }
  // 注入的两次占用之后，真实 Windows 仍可能短暂占用；逐次记录，而非假设第三次一定成功。
  assert.equal(calls, 3 + nativeRetryErrors.length);
  assert.ok(calls <= 5, '目录链接最多尝试 5 次');
  assert.ok(nativeRetryErrors.every(code => ['EBUSY', 'EPERM'].includes(code)));
  assert.equal(fs.realpathSync(path.join(root, 'link')), fs.realpathSync(target));
});

test('连续占用达到 5 次后必须返回原错误', () => {
  const real = fs.symlinkSync; let calls = 0;
  const busy = Object.assign(new Error('still busy'), { code: 'EBUSY' });
  const link = path.join(os.tmpdir(), `hub-acp-link-exhausted-${process.pid}-${Date.now()}`);
  fs.symlinkSync = () => { calls++; if (calls > 5) throw new Error('超过重试上限'); throw busy; };
  try { assert.throws(() => linkWithRetry('C:/nonexistent-target', link), error => error === busy); }
  finally { fs.symlinkSync = real; }
  assert.equal(calls, 5);
});

test('其他错误不重试，直接抛出', () => {
  const real = fs.symlinkSync; let calls = 0;
  fs.symlinkSync = () => { calls++; throw Object.assign(new Error('nope'), { code: 'ENOENT' }); };
  try { assert.throws(() => linkWithRetry('C:/nonexistent-target', path.join(os.tmpdir(), 'hub-acp-link-none')), /nope/); } finally { fs.symlinkSync = real; }
  assert.equal(calls, 1);
});
