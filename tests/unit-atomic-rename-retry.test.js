'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { renameWithRetrySync } = require('../core/claude-project-trust');
const retryCodes = new Set(['EPERM', 'EBUSY']);

function files(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-atomic-rename-'));
  const source = path.join(dir, 'owned.tmp'), target = path.join(dir, 'state.json');
  fs.writeFileSync(source, 'next'); fs.writeFileSync(target, 'previous');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { source, target };
}

test('短暂 EPERM/EBUSY 只重试同一次 rename，成功前源和旧目标始终保留', t => {
  const { source, target } = files(t), waits = [], argumentsSeen = [];
  let calls = 0;
  const used = renameWithRetrySync(source, target, { retries: 8, retryDelayMs: 15, retryCodes,
    sleep: ms => waits.push(ms), fsImpl: { renameSync(from, to) {
      calls++; argumentsSeen.push([from, to]);
      assert.equal(fs.readFileSync(source, 'utf8'), 'next');
      assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
      if (calls < 3) throw Object.assign(new Error('short file hold'), { code: calls === 1 ? 'EPERM' : 'EBUSY', path: from, dest: to });
      fs.renameSync(from, to);
    } } });
  assert.equal(used, 2); assert.equal(calls, 3); assert.deepEqual(waits, [15, 15]);
  assert.deepEqual(argumentsSeen, Array(3).fill([source, target]));
  assert.equal(fs.existsSync(source), false); assert.equal(fs.readFileSync(target, 'utf8'), 'next');
});

test('未列入调用方重试集合的永久错误立即抛原对象，不删除或覆盖源/目标', t => {
  const { source, target } = files(t);
  for (const code of ['EACCES', 'ENOENT', 'ENOSPC']) {
    let calls = 0, sleeps = 0;
    const error = Object.assign(new Error('permanent refusal'), { code, path: source, dest: target, syscall: 'rename' });
    assert.throws(() => renameWithRetrySync(source, target, { retries: 8, retryDelayMs: 15, retryCodes,
      sleep: () => { sleeps++; }, fsImpl: { renameSync() { calls++; throw error; } } }), actual => actual === error);
    assert.equal(calls, 1, code); assert.equal(sleeps, 0, code);
    assert.equal(fs.readFileSync(source, 'utf8'), 'next'); assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
  }
});

test('持续占用耗尽固定 8×15ms 预算，最后一次原错误和路径上下文不丢', t => {
  const { source, target } = files(t), waits = [], errors = [];
  assert.throws(() => renameWithRetrySync(source, target, { retries: 8, retryDelayMs: 15, retryCodes,
    sleep: ms => waits.push(ms), fsImpl: { renameSync(from, to) {
      const error = Object.assign(new Error('still held ' + errors.length), { code: 'EPERM', path: from, dest: to, syscall: 'rename' });
      errors.push(error); throw error;
    } } }), actual => actual === errors.at(-1));
  assert.equal(errors.length, 9); assert.deepEqual(waits, Array(8).fill(15));
  assert.equal(waits.reduce((a, b) => a + b, 0), 120);
  assert.equal(errors.at(-1).path, source); assert.equal(errors.at(-1).dest, target);
  assert.equal(fs.readFileSync(source, 'utf8'), 'next'); assert.equal(fs.readFileSync(target, 'utf8'), 'previous');
});

test('旧调用方不传 retryCodes 时仍保留 EACCES 重试语义', () => {
  let calls = 0;
  assert.equal(renameWithRetrySync('tmp', 'target', { retries: 1, sleep() {}, fsImpl: {
    renameSync() { if (calls++ === 0) throw Object.assign(new Error('legacy'), { code: 'EACCES' }); },
  } }), 1);
  assert.equal(calls, 2);
});
