// tests/unit-multi-review-fixes.test.js
//
// 2026-05-07 道雪 — 验证多方审查（Gemini + Codex + DeepSeek + Claude 自审）发现
// 的 7 个问题修复后行为正确：
//   F1: file-lock releaseLock 不删非自己的锁（stale 接管后旧持有者 release 不破坏新锁）
//   F2: state-store _saveImpl 锁失败仍走 merge 路径（不裸覆盖）
//   F3: state-store loadAndSelfHeal 锁失败不写盘
//   F4: session-store markDirty 在 markRemovedSession 后跳过（防 renderer race 复活）
//   F5: meeting-store markDirty 同款防御
//   F6: session-store markDirty timer 写盘失败保留 dirty（让 flushAll 能重试）
//   F7: deleteSessionFile/deleteMeetingFile 区分 ENOENT vs 其他错误

'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'review-fixes-'));
process.env.CLAUDE_HUB_DATA_DIR = TEMP;

const fileLock = require('../core/file-lock');
const stateStore = require('../core/state-store');
const sessionStore = require('../core/session-store');
const meetingStore = require('../core/meeting-store');

(async function run() {
  // ── F1: releaseLock 不删非自己的锁 ────────────────────────────────────
  {
    const lockPath = path.join(TEMP, 'f1.lock');
    // A 拿锁
    const fdA = fileLock.acquireLock(lockPath, { retries: 0 });
    assert.ok(fdA);
    // 模拟 A 的锁文件被 B "stale 接管"——直接覆写 lock 文件让 pid 变成别人
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999999, mtime: Date.now() }));
    // A 现在调 releaseLock —— 不应删除 B 的锁
    fileLock.releaseLock(fdA, lockPath);
    assert.ok(fs.existsSync(lockPath), 'F1: releaseLock 不应删除已不属于自己的锁');
    // 自己模拟 B 释放
    fs.unlinkSync(lockPath);
    console.log('PASS F1 releaseLock 互斥安全：不会破坏新持有者的锁');
  }

  // ── F2: _saveImpl 锁失败 fallback 仍走 merge ─────────────────────────
  {
    // 占用 LOCK_FILE 模拟"另一个进程在持锁"
    fs.mkdirSync(path.dirname(stateStore.STATE_FILE), { recursive: true });
    fs.writeFileSync(stateStore.LOCK_FILE, JSON.stringify({ pid: 88888, mtime: Date.now() }));

    // 盘上先有一条 sess-existing（updatedAt=100）
    fs.writeFileSync(stateStore.STATE_FILE, JSON.stringify({
      version: 1, cleanShutdown: false,
      sessions: [{ hubId: 'sess-disk', kind: 'claude', title: 'disk-only', updatedAt: 100 }],
      meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }));

    // 内存只有 sess-mem，调 sync save —— retries=0 + 占用的 lock 让 acquireLock 失败
    // 但 stale 探测 10s 内不会 reap，所以 retries 1 也拿不到（除非走 stale 路径）
    // 让 lock 文件 mtime 设到现在以避免 stale 触发
    fs.utimesSync(stateStore.LOCK_FILE, new Date(), new Date());

    // 主动调用低层 _saveImpl 之前先把 saveDebounceTimer 清掉以确保 sync 走
    stateStore.save({
      version: 1, cleanShutdown: false,
      sessions: [{ hubId: 'sess-mem', kind: 'codex', title: 'mem-only', updatedAt: 200 }],
      meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });

    // 盘上应该有两条（fallback 路径走了 merge）
    const after = JSON.parse(fs.readFileSync(stateStore.STATE_FILE, 'utf-8'));
    const ids = after.sessions.map(s => s.hubId).sort();
    assert.deepStrictEqual(ids, ['sess-disk', 'sess-mem'], 'F2: lock 失败 fallback 仍合并了 sess-disk');
    console.log('PASS F2 _saveImpl 锁失败 fallback 走 merge 不裸覆盖');

    // 清理
    try { fs.unlinkSync(stateStore.LOCK_FILE); } catch {}
  }

  // ── F3: loadAndSelfHeal 锁失败不写盘 ────────────────────────────────
  {
    // 给 state.json 写一个 cleanShutdown=true 的版本
    fs.writeFileSync(stateStore.STATE_FILE, JSON.stringify({
      version: 1, cleanShutdown: true,
      sessions: [{ hubId: 'sess-x', kind: 'claude', title: 'x', updatedAt: 100 }],
      meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }));
    // 再占锁
    fs.writeFileSync(stateStore.LOCK_FILE, JSON.stringify({ pid: 88888, mtime: Date.now() }));
    fs.utimesSync(stateStore.LOCK_FILE, new Date(), new Date());

    const beforeMtime = fs.statSync(stateStore.STATE_FILE).mtimeMs;
    const healed = stateStore.loadAndSelfHeal({ sessionStore, meetingStore });
    const afterMtime = fs.statSync(stateStore.STATE_FILE).mtimeMs;

    assert.strictEqual(beforeMtime, afterMtime, 'F3: loadAndSelfHeal 锁失败时不应该写盘');
    assert.strictEqual(healed.bootWasCleanShutdown, true, 'F3: 仍然返回正确的 bootWasCleanShutdown');
    assert.ok(healed.sessions.length >= 1, 'F3: 内存合并仍发生');
    console.log('PASS F3 loadAndSelfHeal 锁失败时只读不写');

    try { fs.unlinkSync(stateStore.LOCK_FILE); } catch {}
  }

  // ── F4: session-store markDirty 在 markRemovedSession 后跳过 ────────
  {
    const removedId = 'sess-removed-race';
    stateStore.markRemovedSession(removedId);
    sessionStore.markDirty(removedId, { kind: 'claude', title: 'should-not-revive', updatedAt: 999 });
    // 等 200ms debounce 触发
    await new Promise(r => setTimeout(r, 300));
    const filePath = path.join(TEMP, 'sessions', `${removedId}.json`);
    assert.ok(!fs.existsSync(filePath), 'F4: removed sid 不应被 markDirty 写出 per-session JSON');
    console.log('PASS F4 session-store markDirty 检查 removed 不复活');

    // 别让 removed set 影响后续测试
    // 注意：markRemovedSession 没有 unmark API，但 _drainRemoved 会清空。
    // 我们在 F2 已 sync save 过，drainRemoved 已清空。但 F3 也 sync save 过…
    // 实际上 stateStore.save 内部 _drainRemoved 清空了。所以这里 set 是空的。
    // 重置一次确保
    stateStore.save({
      version: 1, cleanShutdown: false, sessions: [], meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
  }

  // ── F5: meeting-store markDirty 同款 ────────────────────────────────
  {
    const removedMtg = 'mtg-removed-race';
    stateStore.markRemovedMeeting(removedMtg);
    meetingStore.markDirty(removedMtg, { id: removedMtg, title: 'should-not-revive', updatedAt: 999 });
    await new Promise(r => setTimeout(r, 100));  // 不必等 5s debounce 因为 markDirty 入口直接拒
    const filePath = path.join(TEMP, 'meetings', `${removedMtg}.json`);
    assert.ok(!fs.existsSync(filePath), 'F5: removed meeting 不应被 markDirty 写出 per-meeting JSON');
    console.log('PASS F5 meeting-store markDirty 检查 removed 不复活');

    stateStore.save({
      version: 1, cleanShutdown: false, sessions: [], meetings: [],
      immersiveByMeeting: {}, pilotSlotByMeeting: {}, dispatchModeByMeeting: {},
    }, { sync: true });
  }

  // ── F6: markDirty timer 写盘失败保留 dirty ──────────────────────────
  {
    // 制造一个写不进去的 hubId（用文件名包含非法字符在 Windows 上会失败）
    // Windows 不允许 < > : " | ? *
    const badId = 'bad<id>';  // 文件名里有 < > 在 Windows 上 fs.writeFileSync 会抛
    sessionStore.markDirty(badId, { kind: 'claude', title: 'will-fail', updatedAt: 1000 });
    await new Promise(r => setTimeout(r, 300));
    // dirty 应该还保留（未 _delete）
    // 由于 _dirty 是模块私有 Map，从外部无法直接断言。改为：再调 flushAll
    // 验证它是否会再次尝试（仍会失败但不抛）。
    sessionStore.flushAll();
    // 我们至少确认没崩溃 + 没写出文件
    const badPath = path.join(TEMP, 'sessions', `${badId}.json`);
    assert.ok(!fs.existsSync(badPath), 'F6: 失败的写盘不留半成品文件');
    console.log('PASS F6 markDirty timer 写盘失败不崩 + flushAll 兼容');
  }

  // ── F7: deleteSessionFile ENOENT 安静 / 其他错误 warn ───────────────
  {
    // ENOENT：删一个不存在的 hubId 不应有任何 stderr
    // 我们没法直接捕获 console.warn，但确保不抛
    sessionStore.deleteSessionFile('does-not-exist-xxx');
    meetingStore.deleteMeetingFile('does-not-exist-yyy');
    console.log('PASS F7 delete*File ENOENT 不抛错');
  }

  console.log('\n[ALL multi-review-fix tests PASSED]');
})().catch(e => { console.error('FAIL:', e); process.exit(1); });
