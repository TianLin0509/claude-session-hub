'use strict';
// DSH 扩展包的目录链接：Windows 上偶发 EBUSY 时短暂重试，而不是让会话启动失败。
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { linkWithRetry } = require('../core/acp-profiles');

test('目录链接遇到两次 EBUSY 后恰好第三次成功', t => {
  // 重试计数使用受控文件系统；真实 Windows 建链接还可能额外遇到 EBUSY/EPERM。
  // Atomics.wait 是同步等待，mock timers 无法控制它；直接记录请求的等待时长。
  const target = path.join(os.tmpdir(), 'hub-acp-link-controlled-target');
  const link = path.join(os.tmpdir(), 'hub-acp-link-controlled-link');
  const attempts = [], waits = [];
  t.mock.method(fs, 'symlinkSync', (...args) => {
    attempts.push(args);
    if (attempts.length <= 2) throw Object.assign(new Error('busy'), { code: 'EBUSY' });
  });
  t.mock.method(fs, 'existsSync', checked => { assert.equal(checked, link); return false; });
  t.mock.method(Atomics, 'wait', (_array, _index, _value, timeout) => { waits.push(timeout); return 'timed-out'; });
  linkWithRetry(target, link);
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts, Array.from({ length: 3 }, () => [target, link, process.platform === 'win32' ? 'junction' : 'dir']));
  assert.deepEqual(waits, [100, 200]);
});

test('目录链接确实建成并指向目标', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-acp-link-'));
  t.after(() => { try { fs.unlinkSync(path.join(root, 'link')); } catch {} fs.rmSync(root, { recursive: true, force: true }); });
  const target = path.join(root, 'target'); fs.mkdirSync(target);
  linkWithRetry(target, path.join(root, 'link'));
  assert.equal(fs.realpathSync(path.join(root, 'link')), fs.realpathSync(target));
});

test('其他错误不重试，直接抛出', t => {
  const error = Object.assign(new Error('nope'), { code: 'ENOENT' });
  const symlink = t.mock.method(fs, 'symlinkSync', () => { throw error; });
  t.mock.method(fs, 'existsSync', () => false);
  const wait = t.mock.method(Atomics, 'wait', () => 'timed-out');
  assert.throws(() => linkWithRetry('C:/nonexistent-target', path.join(os.tmpdir(), 'hub-acp-link-none')), thrown => thrown === error);
  assert.equal(symlink.mock.callCount(), 1);
  assert.equal(wait.mock.callCount(), 0);
});
