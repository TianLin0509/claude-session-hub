'use strict';
// 助理模块各保存点（先写临时文件再改名）遇到 Windows 短暂占用要重试，不能一次 EPERM 就让助理启动失败
// （2026-10-15 合并闸门里 connectBridge 写入口文件失败过一次）。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('助理模块的临时文件改名都经 renameRetry，只剩日志轮转这一处直接改名', () => {
  const dir = path.join(__dirname, '..', 'core', 'hub-assistant');
  const direct = [];
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js') && n !== 'atomic-rename.js')) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (/fs\.renameSync\(/.test(line)) direct.push(f);
  }
  assert.deepEqual(direct, ['service.js']);
});

test('renameRetry：Windows 上 EPERM 稍等重试后成功；其他错误立即抛出', { skip: process.platform !== 'win32' && '仅 Windows 重试' }, () => {
  const { renameRetry } = require('../core/hub-assistant/atomic-rename');
  const real = fs.renameSync;
  let calls = 0;
  fs.renameSync = () => { calls += 1; if (calls < 3) throw Object.assign(new Error('busy'), { code: 'EPERM' }); };
  try { assert.equal(renameRetry('a', 'b'), 2); } finally { fs.renameSync = real; }
  fs.renameSync = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  try { assert.throws(() => renameRetry('a', 'b'), /missing/); } finally { fs.renameSync = real; }
});
