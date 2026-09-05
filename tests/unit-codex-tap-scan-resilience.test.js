'use strict';
/**
 * CodexTap 扫描自愈 —— 守住「绑定机制整体静默停摆」这个最坏故障。
 *
 * 实测事故（2026-09-05 验收）：codex 干完了活、发了 task_complete，
 * Hub 却一直转、循环挂住 17 分钟。取证下来：
 *   · 扫描跑了 32 轮（间隔 1 秒）后**停止输出**
 *   · 17 秒后新会话的 rollout 才出生，此后再没被检查过一次
 *   · pending 始终为 1，说明会话在等一个永远不会来的绑定
 *
 * 成因在 `_scanOnce` 开头那句 `if (this._scanning) return;` ——
 * 它只进不出：一次扫描里任何一个 await 挂住，后续每轮都直接 return，
 * 而外面完全看不出来（没有报错、没有日志、定时器还在跑）。
 *
 * 这支测试锁两件事：单个文件卡住不拖垮整轮；整轮卡死能自愈。
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { CodexTap } = require('../core/transcript-tap.js');

let pass = 0;
const queue = [];
function test(name, fn) { queue.push({ name, fn }); }

const ROOT = path.join(os.tmpdir(), 'codex-tap-scan-' + Date.now());
const DAY = path.join(ROOT, '2026', '09', '05');
fs.mkdirSync(DAY, { recursive: true });

function writeRollout(name, cwd, ts) {
  const p = path.join(DAY, name);
  fs.writeFileSync(p, JSON.stringify({
    type: 'session_meta',
    payload: { id: name, session_id: name, cwd, timestamp: ts, source: 'cli', thread_source: 'user' },
  }) + '\n', 'utf-8');
  return p;
}

console.log('codex-tap-scan-resilience');

test('单个文件的绑定尝试挂住时，整轮扫描仍然走完后面的文件', async () => {
  const tap = new CodexTap({ pollIntervalMs: 100000 });   // 手动驱动，不让定时器插手
  const cwd = 'C:\\some\\project';
  writeRollout('rollout-2026-09-05T01-00-00-aaa.jsonl', cwd, '2026-09-05T01:00:00.000Z');
  writeRollout('rollout-2026-09-05T02-00-00-bbb.jsonl', cwd, '2026-09-05T02:00:00.000Z');

  const examined = [];
  const realTryBind = tap._tryBind.bind(tap);
  tap._tryBind = (p) => {
    examined.push(path.basename(p));
    // 第一个文件永远不 resolve —— 模拟真实世界里那次把扫描焊死的 await
    if (p.includes('aaa')) return new Promise(() => {});
    return realTryBind(p);
  };
  tap._candidateDirs = () => [DAY];
  tap._pending.set('s1', { cwd, spawnTime: Date.now(), allowMtimeFallback: false, requirePromptMatch: false });

  const t0 = Date.now();
  await tap._scanOnce();
  const spent = Date.now() - t0;

  assert(examined.length >= 2,
    '卡住的那个文件不能挡住后面的，实际只检查了：' + examined.join(', '));
  assert(spent < 60000, '整轮不该被无限拖住，实耗 ' + spent + 'ms');
  assert.strictEqual(tap._scanning, false, '扫描结束必须把闸放开，否则后续每轮都会被跳过');
  tap._stopWatcher();
});

test('上一轮扫描焊死时，下一轮超时后强行接管（不然绑定永久停摆）', async () => {
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  tap._candidateDirs = () => [DAY];
  tap._pending.set('s2', { cwd: 'C:\\x', spawnTime: Date.now(), allowMtimeFallback: false, requirePromptMatch: false });

  // 伪造「上一轮还在跑，且已经卡了很久」
  tap._scanning = true;
  tap._scanStartedAt = Date.now() - 10 * 60 * 1000;

  let ran = false;
  tap._tryBind = async () => { ran = true; };
  await tap._scanOnce();
  assert.strictEqual(ran, true, '卡够久之后必须强行重来，否则永远不会再扫');
  assert.strictEqual(tap._scanning, false);
  tap._stopWatcher();
});

test('上一轮刚开始跑时不抢闸（避免并发扫描互相踩）', async () => {
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  tap._candidateDirs = () => [DAY];
  tap._pending.set('s3', { cwd: 'C:\\x', spawnTime: Date.now(), allowMtimeFallback: false, requirePromptMatch: false });

  tap._scanning = true;
  tap._scanStartedAt = Date.now();          // 刚开始
  let ran = false;
  tap._tryBind = async () => { ran = true; };
  await tap._scanOnce();
  assert.strictEqual(ran, false, '正常并发保护还得在');
  assert.strictEqual(tap._scanning, true, '不该把别人的闸放掉');
  tap._scanning = false;
  tap._stopWatcher();
});

test('没有待绑会话时不做无谓扫描', async () => {
  const tap = new CodexTap({ pollIntervalMs: 100000 });
  let ran = false;
  tap._candidateDirs = () => { ran = true; return []; };
  await tap._scanOnce();
  assert.strictEqual(ran, false);
  tap._stopWatcher();
});

(async () => {
  for (const { name, fn } of queue) { await fn(); pass++; console.log('  ✓ ' + name); }
  try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (e) {}
  console.log('\n──────────────');
  console.log('通过 ' + pass + ' / 失败 0');
})().catch((e) => {
  console.error('失败：' + (e && e.stack || e));
  try { require('child_process').execSync(`cmd /c rmdir /S /Q "${ROOT}"`, { stdio: 'ignore' }); } catch (x) {}
  process.exit(1);
});
