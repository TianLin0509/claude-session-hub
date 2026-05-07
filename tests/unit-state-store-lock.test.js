// tests/unit-state-store-lock.test.js
//
// 验证 file-lock 自研模块 + state-store 的 lock + read-merge-write 在并发场景下正确。
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'state-lock-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const { acquireLock, releaseLock } = require('../core/file-lock');
const stateStore = require('../core/state-store');

(function run() {
  // L1: 互斥 — 第二个 acquireLock 应该拿不到（短超时下）
  {
    const lockPath = path.join(TEMP, 'mutex.lock');
    const fd1 = acquireLock(lockPath, { retries: 0 });
    assert.ok(fd1, 'first acquireLock should succeed');
    const fd2 = acquireLock(lockPath, { retries: 1, retryDelayMs: 10 });
    assert.strictEqual(fd2, null, 'second acquireLock should fail under contention');
    releaseLock(fd1, lockPath);
    const fd3 = acquireLock(lockPath, { retries: 0 });
    assert.ok(fd3, 'after release, lock acquirable again');
    releaseLock(fd3, lockPath);
    console.log('PASS L1 mutex semantics');
  }

  // L2: stale lock 探测 — mtime 太老的 lock 文件被自动 reap
  {
    const lockPath = path.join(TEMP, 'stale.lock');
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 99999, mtime: 0 }));
    // 把 mtime 改到 100s 前（远超 staleMs=50ms 阈值）
    const past = (Date.now() - 100000) / 1000;
    fs.utimesSync(lockPath, past, past);
    const fd = acquireLock(lockPath, { retries: 0, staleMs: 50 });
    assert.ok(fd, 'stale lock should be reaped + acquired');
    releaseLock(fd, lockPath);
    console.log('PASS L2 stale lock reap');
  }

  // L3: state-store sync save round-trip with lock active
  {
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [{ hubId: 'h1', kind: 'claude', title: 'T1', updatedAt: 1000 }],
      meetings: [], immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
    const loaded = stateStore.load();
    assert.strictEqual(loaded.sessions.length, 1);
    assert.strictEqual(loaded.sessions[0].hubId, 'h1');
    console.log('PASS L3 sync save round-trip');
  }

  // L4: read-merge-write — 写入前盘上有别的 Hub 数据 → 不丢
  {
    // 直接写入 state.json 模拟"另一个 Hub 刚写了 h2"
    const stateFile = path.join(TEMP, 'state.json');
    const cur = JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    cur.sessions.push({ hubId: 'h2', kind: 'codex', title: 'T2', updatedAt: 2000 });
    fs.writeFileSync(stateFile, JSON.stringify(cur, null, 2));

    // 本 Hub save 一份只包含 h1 + 新加的 h3 的内存视图（不含 h2）
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [
        { hubId: 'h1', kind: 'claude', title: 'T1-updated', updatedAt: 1500 },
        { hubId: 'h3', kind: 'gemini', title: 'T3', updatedAt: 1500 },
      ],
      meetings: [], immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });

    const loaded = stateStore.load();
    const ids = loaded.sessions.map(s => s.hubId).sort();
    assert.deepStrictEqual(ids, ['h1', 'h2', 'h3'], 'h2 (other hub) preserved through merge');
    const h1 = loaded.sessions.find(s => s.hubId === 'h1');
    assert.strictEqual(h1.title, 'T1-updated', 'h1 mem update wins');
    console.log('PASS L4 read-merge-write — 另一 Hub 的 h2 被保留');
  }

  // L5: removed session 显式删除
  {
    stateStore.markRemovedSession('h2');
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [
        { hubId: 'h1', kind: 'claude', title: 'T1-updated', updatedAt: 1500 },
        { hubId: 'h3', kind: 'gemini', title: 'T3', updatedAt: 1500 },
      ],
      meetings: [], immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
    const loaded = stateStore.load();
    const ids = loaded.sessions.map(s => s.hubId).sort();
    assert.deepStrictEqual(ids, ['h1', 'h3'], 'h2 explicitly removed');
    console.log('PASS L5 markRemovedSession works');
  }

  console.log('\n[ALL state-store lock tests PASSED]');
})();
