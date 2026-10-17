'use strict';
// 退出时避开 Node 平台关闭竞态（2026-10-18）：退出前做一次只回收大对象的新生代 GC，
// 让 V8 内存池「刚排过归还任务」；接线在优雅关闭的 app.quit() 之前和 'quit' 事件里。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const guard = require('../core/v8-exit-guard.js');

const ROOT = path.join(__dirname, '..');

test('先试新生代 GC（同步），不支持选项时退回普通 GC；分配的大对象超过 128 KB', () => {
  const calls = [];
  const res = guard.primeV8MemoryPoolForExit({ gc: opts => calls.push(opts) });
  assert.equal(res.ok, true);
  assert.deepEqual(calls, [{ type: 'minor', execution: 'sync' }]);
  assert.ok(guard.LARGE_ELEMENTS * 4 > 128 * 1024, '指针压缩下每格 4 字节也超过普通对象上限');

  const fallback = [];
  const res2 = guard.primeV8MemoryPoolForExit({ gc: opts => { fallback.push(opts); if (opts) throw new TypeError('options unsupported'); } });
  assert.equal(res2.ok, true);
  assert.deepEqual(fallback, [{ type: 'minor', execution: 'sync' }, undefined]);
});

test('拿不到 gc 或 gc 出错都不挡退出', () => {
  guard._reset();
  const none = guard.resolveGc({ v8Ref: { setFlagsFromString() { throw new Error('frozen'); } }, vmRef: { runInNewContext() { return undefined; } }, globalRef: {} });
  assert.equal(none, null);
  const bad = guard.primeV8MemoryPoolForExit({ gc: () => { throw new Error('boom'); } });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /boom/);
  guard._reset();
});

test('真实 Node：运行时打开 expose-gc 拿到 gc，做一次新生代 GC 成功', () => {
  guard._reset();
  const gc = guard.resolveGc();
  assert.equal(typeof gc, 'function');
  const res = guard.primeV8MemoryPoolForExit();
  assert.equal(res.ok, true, JSON.stringify(res));
  assert.ok(res.ms < 2000);
});

test('接线：优雅关闭在 app.quit() 之前刷新并稍等；quit 事件里再刷新一次', () => {
  const main = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.match(main, /require\('\.\/core\/v8-exit-guard\.js'\)/);
  const drain = main.slice(main.indexOf('function beginGracefulHubShutdown'), main.indexOf("app.on('before-quit', (event)"));
  const prime = drain.indexOf('primeV8MemoryPoolForExit()');
  const quit = drain.indexOf('app.quit();');
  assert.ok(prime > 0 && quit > prime, '先刷新再 app.quit');
  assert.match(drain.slice(prime, quit), /setTimeout\(resolve, \d+\)/, '给后台线程留时间跑完');
  assert.match(main, /app\.on\('quit', \(\) => \{\s*try \{ primeV8MemoryPoolForExit\(\); \} catch \(_\) \{\}/);
});
