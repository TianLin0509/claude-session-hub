// tests/roundtable-memory-phase1.test.js
// Phase 1 单测：checkpoint-state / profile / inbox / worker prompt builder
// 风格同 tests/meeting-store.test.js（裸 node assert + console.log("PASS ...")）

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-mem-p1-'));
const SCENE = 'general';

const ckptState = require('../core/roundtable-memory/checkpoint-state.js');
const profile = require('../core/roundtable-memory/profile.js');
const inbox = require('../core/roundtable-memory/inbox.js');
const worker = require('../core/checkpoint-worker.js');

(async () => {
  // ============================================================
  // checkpoint-state.js
  // ============================================================
  const stateCwd = path.join(TEMP, 'state-test');
  fs.mkdirSync(stateCwd, { recursive: true });

  // S1: readState 默认值
  const s1 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s1.last_user_msg_count, 0);
  assert.strictEqual(s1.consecutive_failures, 0);
  assert.strictEqual(s1.last_checkpoint_at, null);
  console.log('PASS S1 readState default');

  // S2: bumpUserMsgCount
  ckptState.bumpUserMsgCount(stateCwd, SCENE);
  ckptState.bumpUserMsgCount(stateCwd, SCENE);
  const s2 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s2.last_user_msg_count, 2);
  console.log('PASS S2 bumpUserMsgCount');

  // S3: markCheckpoint reset count + 写 turn
  ckptState.markCheckpoint(stateCwd, SCENE, 't6');
  const s3 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s3.last_user_msg_count, 0);
  assert.strictEqual(s3.last_checkpoint_turn, 't6');
  assert.ok(s3.last_checkpoint_at);
  console.log('PASS S3 markCheckpoint reset');

  // S4: markFailure 累加
  ckptState.markFailure(stateCwd, SCENE, 'deepseek down');
  ckptState.markFailure(stateCwd, SCENE, 'deepseek down again');
  const s4 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s4.consecutive_failures, 2);
  assert.strictEqual(s4.last_failure_reason, 'deepseek down again');
  console.log('PASS S4 markFailure');

  // S5: markCheckpoint 清 failure
  ckptState.markCheckpoint(stateCwd, SCENE, 't9');
  const s5 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s5.consecutive_failures, 0);
  assert.strictEqual(s5.last_failure_reason, null);
  console.log('PASS S5 success clears failures');

  // S6: 文件破损时 readState 返回默认（不抛）
  fs.writeFileSync(ckptState.stateFilePath(stateCwd, SCENE), 'not-json{[', 'utf-8');
  const s6 = ckptState.readState(stateCwd, SCENE);
  assert.strictEqual(s6.last_user_msg_count, 0);
  console.log('PASS S6 corrupted file → default');

  // ============================================================
  // profile.js
  // ============================================================
  const profileCwd = path.join(TEMP, 'profile-test');
  fs.mkdirSync(profileCwd, { recursive: true });

  // P1: profileExists false 时 readProfile 返回空 entries
  assert.strictEqual(profile.profileExists(profileCwd, SCENE), false);
  const p1 = profile.readProfile(profileCwd, SCENE);
  assert.strictEqual(p1.entries.length, 0);
  console.log('PASS P1 profile not exists');

  // P2: parseProfileEntry round-trip（含 persisted + recall）
  const sampleEntry = { date: '2026-05-07', persisted: true, key: 'rule:no-mock', content: '不用 mock', recall: 5 };
  const rendered = profile.renderProfileEntry(sampleEntry);
  assert.ok(rendered.includes('[2026-05-07]'));
  assert.ok(rendered.includes('[persisted]'));
  assert.ok(rendered.includes('rule:no-mock'));
  assert.ok(rendered.includes('(recall:5)'));
  const parsed = profile.parseProfileEntry(rendered);
  assert.deepStrictEqual(parsed, sampleEntry);
  console.log('PASS P2 render/parse round-trip');

  // P3: writeProfile + readProfile（frontmatter）
  const initEntries = [
    { date: '2026-05-07', persisted: true, key: 'rule:scene-isolation', content: '通用 vs 投研隔离', recall: 8 },
    { date: '2026-05-07', persisted: false, key: 'preference:conclusion-first', content: '结论先行', recall: 3 },
  ];
  profile.writeProfile(profileCwd, SCENE, initEntries, { source_checkpoint: 't10' });
  assert.strictEqual(profile.profileExists(profileCwd, SCENE), true);
  const p3 = profile.readProfile(profileCwd, SCENE);
  assert.strictEqual(p3.entries.length, 2);
  assert.strictEqual(p3.frontmatter.source_checkpoint, 't10');
  assert.strictEqual(p3.frontmatter.scene, SCENE);
  assert.strictEqual(parseInt(p3.frontmatter.entry_count, 10), 2);
  console.log('PASS P3 write/read with frontmatter');

  // P4: 上限 20 条 + persisted 永远保留
  const big = [];
  for (let i = 0; i < 25; i++) {
    big.push({ date: '2026-05-07', persisted: false, key: `preference:k${i}`, content: `c${i}`, recall: i });
  }
  big.push({ date: '2026-05-07', persisted: true, key: 'rule:critical', content: 'never evict', recall: 0 });
  const wp4 = profile.writeProfile(profileCwd, SCENE, big);
  assert.strictEqual(wp4.finalEntries.length, 20, '上限 20');
  assert.ok(wp4.finalEntries.some(e => e.key === 'rule:critical'), 'persisted 必须留');
  // 高 recall 优先：k24 (recall=24) 必在
  assert.ok(wp4.finalEntries.some(e => e.key === 'preference:k24'), '高 recall 留');
  console.log('PASS P4 cap to 20 + persisted preserved');

  // P5: applyTrioUpdate（keep/evict/add）
  // 初始 5 条；keep 列出 2 条 + evict 1 条 + add 1 条 → 期望 4 条
  profile.writeProfile(profileCwd, SCENE, [
    { date: '2026-05-07', persisted: false, key: 'preference:a', content: 'A', recall: 5 },
    { date: '2026-05-07', persisted: false, key: 'preference:b', content: 'B', recall: 4 },
    { date: '2026-05-07', persisted: false, key: 'preference:c', content: 'C', recall: 3 },
    { date: '2026-05-07', persisted: true,  key: 'rule:fixed', content: 'X', recall: 0 },
    { date: '2026-05-07', persisted: false, key: 'preference:d', content: 'D', recall: 2 },
  ]);
  profile.applyTrioUpdate(profileCwd, SCENE, {
    keep:  ['preference:a', 'preference:b'],
    evict: ['preference:c'],
    add:   [{ key: 'preference:new1', content: 'NEW', persisted: false, recall: 0 }],
  }, 't20');
  const p5 = profile.readProfile(profileCwd, SCENE);
  const keys5 = p5.entries.map(e => e.key).sort();
  assert.ok(keys5.includes('preference:a'), 'keep a');
  assert.ok(keys5.includes('preference:b'), 'keep b');
  assert.ok(!keys5.includes('preference:c'), 'evict c');
  assert.ok(!keys5.includes('preference:d'), 'd not in keep → evicted');
  assert.ok(keys5.includes('rule:fixed'), 'persisted always kept');
  assert.ok(keys5.includes('preference:new1'), 'new1 added');
  console.log('PASS P5 applyTrioUpdate');

  // P6: persisted 不能被 evict（即使列出）
  profile.applyTrioUpdate(profileCwd, SCENE, {
    keep:  [],
    evict: ['rule:fixed'],
    add:   [],
  });
  const p6 = profile.readProfile(profileCwd, SCENE);
  assert.ok(p6.entries.some(e => e.key === 'rule:fixed'), 'persisted resists evict');
  console.log('PASS P6 persisted resists evict');

  // ============================================================
  // inbox.js
  // ============================================================
  const inboxCwd = path.join(TEMP, 'inbox-test');
  fs.mkdirSync(inboxCwd, { recursive: true });
  // Phase 3：inbox API 第三参从 slot 改为 identity（变量名 SLOT 保留作 test-internal 标识，但值是 identity）
  const SLOT = 'claude-opus-4-7';

  // I1: appendCandidates 创建 + 同 key 自动合并（保留 remind_count）
  const c1 = [
    { kind: 'preference', key: 'downside-first', content: '重视下行', reason: 'r1' },
    { kind: 'preference', key: 'no-preamble', content: '不铺背景', reason: 'r2' },
  ];
  const r1 = inbox.appendCandidates(inboxCwd, SCENE, SLOT, c1, 't10');
  assert.strictEqual(r1.added, 2);
  assert.strictEqual(r1.merged, 0);
  console.log('PASS I1 appendCandidates create');

  // I2: 同 key 重复 → merged，updated reason but remind_count 保留
  // 先 bump remind_count
  inbox.pickForInject(inboxCwd, SCENE, SLOT, 5);
  const beforeRemind = inbox.loadPending(inboxCwd, SCENE, SLOT).items.find(it => it.key === 'downside-first').remind_count;
  assert.strictEqual(beforeRemind, 1);
  const r2 = inbox.appendCandidates(inboxCwd, SCENE, SLOT, [
    { kind: 'preference', key: 'downside-first', content: '重视下行（更新）', reason: 'updated reason' },
  ], 't11');
  assert.strictEqual(r2.merged, 1);
  const afterMerge = inbox.loadPending(inboxCwd, SCENE, SLOT).items.find(it => it.key === 'downside-first');
  assert.strictEqual(afterMerge.remind_count, 1, 'remind_count 保留');
  assert.strictEqual(afterMerge.reason, 'updated reason');
  assert.ok(afterMerge.content.includes('更新'));
  console.log('PASS I2 same key merged, remind_count preserved');

  // I3: pickForInject 按 priority 排序 + bump remind_count
  // 给 no-preamble 设 priority:true（手动改文件 = 用户编辑 = plan §8.2）
  let items = inbox.loadPending(inboxCwd, SCENE, SLOT).items;
  items.find(it => it.key === 'no-preamble').priority = true;
  inbox.savePending(inboxCwd, SCENE, SLOT, items);
  const inject = inbox.pickForInject(inboxCwd, SCENE, SLOT, 5);
  assert.strictEqual(inject.items[0].key, 'no-preamble', 'priority 排前');
  // 两条都 bump
  const after3 = inbox.loadPending(inboxCwd, SCENE, SLOT).items;
  assert.strictEqual(after3.find(it => it.key === 'downside-first').remind_count, 2);
  assert.strictEqual(after3.find(it => it.key === 'no-preamble').remind_count, 2);
  console.log('PASS I3 pickForInject priority + bump');

  // I4: pickForInject 第三次 → no-preamble remind_count = 3 → 下次 reconcile 应 expire
  inbox.pickForInject(inboxCwd, SCENE, SLOT, 5);
  const after4 = inbox.loadPending(inboxCwd, SCENE, SLOT).items;
  assert.strictEqual(after4.find(it => it.key === 'no-preamble').remind_count, 3);

  // reconcile：individual entries 含 downside-first → accepted；no-preamble remind_count=3 → expired
  const fakeIndividual = [
    { date: '2026-05-07', scope: 'scene', source: 'inbox', recall: 0, last: null, key: 'preference:downside-first', content: '...' },
  ];
  const rec = inbox.reconcile(inboxCwd, SCENE, SLOT, fakeIndividual);
  assert.strictEqual(rec.accepted, 1, 'downside-first accepted');
  assert.strictEqual(rec.expired, 1, 'no-preamble expired');
  // Bug 4 fix: accepted 也归档（保留审计），所以 archived = accepted + expired = 2
  assert.strictEqual(rec.archived, 2, 'accepted + expired archived');
  // 现在 pending 应空
  const after5 = inbox.loadPending(inboxCwd, SCENE, SLOT).items;
  assert.strictEqual(after5.length, 0, 'pending now empty');
  // 归档文件存在
  const archDir = inbox.archiveDirPath(inboxCwd, SCENE);
  assert.ok(fs.existsSync(archDir), 'archive dir created');
  const archFiles = fs.readdirSync(archDir);
  assert.ok(archFiles.length >= 1, 'at least 1 archive file');
  console.log('PASS I4 reconcile accepted + expired + archived');

  // I5: pendingCount helper
  inbox.appendCandidates(inboxCwd, SCENE, SLOT, [
    { kind: 'preference', key: 'fresh', content: '新候选' },
  ], 't20');
  assert.strictEqual(inbox.pendingCount(inboxCwd, SCENE, SLOT), 1);
  console.log('PASS I5 pendingCount');

  // I6: gcArchive (Phase 2 P2 · 2026-05-07) — 删除超过 180 天的归档文件
  const gcCwd = path.join(TEMP, 'gc-test');
  const gcArchDir = inbox.archiveDirPath(gcCwd, SCENE);
  fs.mkdirSync(gcArchDir, { recursive: true });
  // 当月（保留）
  const now = new Date();
  const ymNow = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}`;
  // 8 个月前（应删除，超过 180 天）
  const old = new Date(); old.setMonth(old.getMonth() - 8);
  const ymOld = `${old.getFullYear()}${String(old.getMonth() + 1).padStart(2, '0')}`;
  // 5 个月前（保留，未超 180 天）
  const mid = new Date(); mid.setMonth(mid.getMonth() - 5);
  const ymMid = `${mid.getFullYear()}${String(mid.getMonth() + 1).padStart(2, '0')}`;
  fs.writeFileSync(path.join(gcArchDir, `${SLOT}-${ymNow}.json`), '[]');
  fs.writeFileSync(path.join(gcArchDir, `${SLOT}-${ymOld}.json`), '[]');
  fs.writeFileSync(path.join(gcArchDir, `${SLOT}-${ymMid}.json`), '[]');
  fs.writeFileSync(path.join(gcArchDir, 'random-not-matching.txt'), 'noise');
  const gcResult = inbox.gcArchive(gcCwd, SCENE);
  assert.strictEqual(gcResult.scanned, 3, 'should scan 3 matching json files');
  assert.strictEqual(gcResult.removed, 1, 'should remove 1 (8mo old)');
  assert.ok(fs.existsSync(path.join(gcArchDir, `${SLOT}-${ymNow}.json`)), 'current month preserved');
  assert.ok(!fs.existsSync(path.join(gcArchDir, `${SLOT}-${ymOld}.json`)), '8-month-old removed');
  assert.ok(fs.existsSync(path.join(gcArchDir, `${SLOT}-${ymMid}.json`)), '5-month-old preserved');
  assert.ok(fs.existsSync(path.join(gcArchDir, 'random-not-matching.txt')), 'non-matching file untouched');
  console.log('PASS I6 gcArchive (180-day retention)');

  // ============================================================
  // worker buildDerivePrompt（pure，可单测）
  // ============================================================
  // Phase 3：buildDerivePrompt 入参从 individualBySlot 改 individualByIdentity
  const prompts = worker.buildDerivePrompt({
    timelineTail: '## 第 5 轮\n用户: 我喜欢结论先行\nClaude: 已记下',
    individualByIdentity: {
      'claude-opus-4-7': [{ key: 'preference:conclusion-first', content: '结论先行' }],
      'gemini-3-pro': [],
      'codex-gpt-5-2-codex': [],
    },
    profileEntries: [{ date: '2026-05-07', persisted: false, key: 'preference:foo', content: 'F', recall: 1 }],
  });
  assert.ok(prompts.system.includes('提炼器'));
  assert.ok(prompts.system.includes('严格禁止'), 'system contains anti-fixation');
  assert.ok(prompts.system.includes('JSON'), 'system requests JSON output');
  assert.ok(prompts.user.includes('preference:conclusion-first'), 'user has identity entries');
  assert.ok(prompts.user.includes('claude-opus-4-7'), 'user has identity section header (Phase 3)');
  assert.ok(prompts.user.includes('结论先行'), 'user has timeline');
  console.log('PASS W1 buildDerivePrompt structure (identity-based)');

  // ============================================================
  // Bug 2 fix · markCheckpoint 计数补偿
  // ============================================================
  const ckptDir = path.join(TEMP, 'ckpt2-test');
  fs.mkdirSync(ckptDir, { recursive: true });
  // 模拟 worker 启动时 count=2，运行期间主进程 bump 到 5
  ckptState.bumpUserMsgCount(ckptDir, SCENE);
  ckptState.bumpUserMsgCount(ckptDir, SCENE);
  const startSnapshot = ckptState.readState(ckptDir, SCENE).last_user_msg_count;
  assert.strictEqual(startSnapshot, 2);
  // worker 运行中主进程又 bump 3 次
  ckptState.bumpUserMsgCount(ckptDir, SCENE);
  ckptState.bumpUserMsgCount(ckptDir, SCENE);
  ckptState.bumpUserMsgCount(ckptDir, SCENE);
  // worker 完成 markCheckpoint 带 startCount = 2
  const after = ckptState.markCheckpoint(ckptDir, SCENE, 't1', { startCount: startSnapshot });
  // 5 - 2 = 3 应该保留
  assert.strictEqual(after.last_user_msg_count, 3, 'window-period bump preserved');
  console.log('PASS S7 markCheckpoint window compensation');

  // 没传 startCount 时退化到 reset = 0
  ckptState.bumpUserMsgCount(ckptDir, SCENE); // 4
  const after2 = ckptState.markCheckpoint(ckptDir, SCENE, 't2');
  assert.strictEqual(after2.last_user_msg_count, 0, 'no startCount → full reset');
  console.log('PASS S8 markCheckpoint without startCount falls back to 0');

  // ============================================================
  // Bug 3 fix · parseDeepSeekJson + sanitizePendingCandidates
  // ============================================================
  // 裸 JSON
  const j1 = worker.parseDeepSeekJson('{"a":1}');
  assert.deepStrictEqual(j1, { a: 1 });
  // ```json fenced
  const j2 = worker.parseDeepSeekJson('```json\n{"b":2}\n```');
  assert.deepStrictEqual(j2, { b: 2 });
  // ``` 裸 fenced
  const j3 = worker.parseDeepSeekJson('```\n{"c":3}\n```');
  assert.deepStrictEqual(j3, { c: 3 });
  // 前后多嘴 + 提取最外层 {}
  const j4 = worker.parseDeepSeekJson('我看完了，下面是结果：\n{"d":4}\n希望有用。');
  assert.deepStrictEqual(j4, { d: 4 });
  // 完全无 JSON → throw
  let threw = false;
  try { worker.parseDeepSeekJson('hello world'); } catch { threw = true; }
  assert.ok(threw, 'no-JSON input throws');
  console.log('PASS W2 parseDeepSeekJson handles fence/garble/missing');

  // sanitizePendingCandidates
  const sanitized = worker.sanitizePendingCandidates([
    { kind: 'preference', key: 'good', content: 'yes' },                 // OK
    { kind: 'invalid_kind', key: 'bad-kind', content: 'x' },              // 越界 kind
    { key: 'no-kind-default-ok', content: 'x' },                          // kind 缺省 OK
    { kind: 'fact', key: '', content: 'x' },                              // 空 key
    { kind: 'fact', key: 'no-content', content: '   ' },                  // 空 content
    null,                                                                 // null
    'string',                                                             // 非对象
  ]);
  assert.strictEqual(sanitized.length, 2, 'sanitize keeps valid only');
  assert.strictEqual(sanitized[0].key, 'good');
  assert.strictEqual(sanitized[1].key, 'no-kind-default-ok');
  console.log('PASS W3 sanitizePendingCandidates filters bad items');

  // ============================================================
  // Bug 6 fix · lock 原子获取 + token release
  // ============================================================
  const trigger = require('../core/roundtable-memory/checkpoint-trigger.js');
  const lockTestDir = path.join(TEMP, 'lock-test');
  fs.mkdirSync(lockTestDir, { recursive: true });

  // 写 lock，返回 token
  const lockA = trigger.writeLock(lockTestDir, SCENE, process.pid);
  assert.ok(lockA.filePath && lockA.token);
  // 再写应该 EEXIST
  let writeAgainThrew = false;
  try { trigger.writeLock(lockTestDir, SCENE, process.pid); }
  catch { writeAgainThrew = true; }
  assert.ok(writeAgainThrew, 'second writeLock throws EEXIST');
  console.log('PASS L1 writeLock atomic (EEXIST on second write)');

  // 错 token 不能 release
  const wrongRelease = trigger.releaseLockOwner(lockA.filePath, 'wrong-token');
  assert.strictEqual(wrongRelease, false);
  assert.ok(fs.existsSync(lockA.filePath), 'lock still exists after wrong-token release');
  console.log('PASS L2 releaseLockOwner rejects wrong token');

  // 正确 token release
  const okRelease = trigger.releaseLockOwner(lockA.filePath, lockA.token);
  assert.strictEqual(okRelease, true);
  assert.ok(!fs.existsSync(lockA.filePath));
  console.log('PASS L3 releaseLockOwner accepts correct token');

  // isLocked PID 存活校验：写一个假 PID 的 lock，应被识别为僵尸
  const lockB = trigger.writeLock(lockTestDir, SCENE, process.pid);
  // 替换 lock 内容为不存在的 PID
  const fakePid = 999999; // 几乎肯定不存在
  fs.writeFileSync(lockB.filePath, JSON.stringify({ pid: fakePid, token: 'x', at: new Date().toISOString() }));
  assert.strictEqual(trigger.isLocked(lockTestDir, SCENE), false, 'isLocked clears stale-PID lock');
  assert.ok(!fs.existsSync(lockB.filePath), 'stale lock auto-removed');
  console.log('PASS L4 isLocked detects dead PID + clears');

  // ============================================================
  // Bug 9 fix · v2 P2 · pickForInject TOCTOU lock 守卫
  // ============================================================
  const lockedDir = path.join(TEMP, 'lock-toctou-test');
  fs.mkdirSync(lockedDir, { recursive: true });
  // 准备 1 条 pending
  inbox.appendCandidates(lockedDir, SCENE, SLOT, [
    { kind: 'preference', key: 'toctou-test', content: 'test' },
  ], 't1');
  // mock isLockedCheck 始终返回 true（模拟 worker 正好抢到 lock）
  // [Bug 14 fix · v3 P2] lock 时返回**空数组**，避免无限提醒
  const r9 = inbox.pickForInject(lockedDir, SCENE, SLOT, 5, { isLockedCheck: () => true });
  assert.strictEqual(r9.skippedSave, true, 'isLockedCheck=true → skip save');
  assert.strictEqual(r9.items.length, 0, 'lock → return empty items (avoid infinite reminder)');
  // disk 中 remind_count 应仍为 0（没写回）
  const beforeL5 = inbox.loadPending(lockedDir, SCENE, SLOT).items.find(i => i.key === 'toctou-test');
  assert.strictEqual(beforeL5.remind_count, 0, 'remind_count not persisted when locked');
  console.log('PASS L5 pickForInject empty when locked (TOCTOU + no infinite reminder)');

  // 解锁 → 正常保存
  const r9b = inbox.pickForInject(lockedDir, SCENE, SLOT, 5, { isLockedCheck: () => false });
  assert.strictEqual(r9b.skippedSave, false);
  const afterL6 = inbox.loadPending(lockedDir, SCENE, SLOT).items.find(i => i.key === 'toctou-test');
  assert.strictEqual(afterL6.remind_count, 1, 'remind_count persisted when unlocked');
  console.log('PASS L6 pickForInject saves when unlocked');

  // ============================================================
  // Bug 11 fix · v2 P2 · updateLockWithChildPid
  // ============================================================
  const childPidDir = path.join(TEMP, 'child-pid-test');
  fs.mkdirSync(childPidDir, { recursive: true });
  const lockX = trigger.writeLock(childPidDir, SCENE, process.pid);
  // 验证写入的是 process.pid
  let lockData = JSON.parse(fs.readFileSync(lockX.filePath, 'utf-8'));
  assert.strictEqual(lockData.pid, process.pid);
  // 用错 token 更新失败
  const failUpdate = trigger.updateLockWithChildPid(lockX.filePath, 'wrong-token', 12345);
  assert.strictEqual(failUpdate, false);
  lockData = JSON.parse(fs.readFileSync(lockX.filePath, 'utf-8'));
  assert.strictEqual(lockData.pid, process.pid, 'wrong token did not change pid');
  // 正确 token 更新
  const okUpdate = trigger.updateLockWithChildPid(lockX.filePath, lockX.token, 99999);
  assert.strictEqual(okUpdate, true);
  lockData = JSON.parse(fs.readFileSync(lockX.filePath, 'utf-8'));
  assert.strictEqual(lockData.pid, 99999, 'pid updated to child pid');
  assert.strictEqual(lockData.parent_pid, process.pid, 'parent_pid recorded');
  // 释放仍用 token（不是 pid）
  const releaseOK = trigger.releaseLockOwner(lockX.filePath, lockX.token);
  assert.strictEqual(releaseOK, true);
  console.log('PASS L7 updateLockWithChildPid replaces pid + preserves token release');

  // ============================================================
  // Bug 8 fix · v2 P1 · 直接 renameSync 覆盖（无 unlink 窗口）
  // ============================================================
  // 验证 writeState 不再有 unlink+rename 窗口（通过观察文件持续存在）
  const winDir = path.join(TEMP, 'rename-window-test');
  fs.mkdirSync(winDir, { recursive: true });
  ckptState.writeState(winDir, SCENE, { last_user_msg_count: 7 });
  const fp = ckptState.stateFilePath(winDir, SCENE);
  assert.ok(fs.existsSync(fp));
  // 多次重写应该一直存在
  for (let i = 0; i < 10; i++) {
    ckptState.bumpUserMsgCount(winDir, SCENE);
    assert.ok(fs.existsSync(fp), 'state file persists during rename loop');
  }
  const final = ckptState.readState(winDir, SCENE);
  assert.strictEqual(final.last_user_msg_count, 17);
  console.log('PASS L8 writeState atomic rename (no unlink window)');

  // ============================================================
  // Bug 19 + Bug 20 fix · v4/v5 · Sidecar 机制 token-scoped
  // ============================================================
  // 模拟：worker 本地 fallback 写 markFailure + 写 token-scoped sidecar；
  // 主进程 exit handler 读 sidecar 校验 token → 匹配跳过兜底，不匹配 + consume + 兜底。
  const sidecarTestDir = path.join(TEMP, 'sidecar-test');
  fs.mkdirSync(path.join(sidecarTestDir, '.arena', 'rooms', SCENE), { recursive: true });
  const sidecarFp = path.join(sidecarTestDir, '.arena', 'rooms', SCENE, '.checkpoint.failure-reported');
  const currentToken = 'token-current-run';

  // 场景 A: token 匹配本次 run → 主进程跳过兜底（不双倍）
  ckptState.markFailure(sidecarTestDir, SCENE, 'first failure (from worker local)');
  fs.writeFileSync(sidecarFp, JSON.stringify({ reason: 'first', token: currentToken, at: new Date().toISOString() }));
  const before = ckptState.readState(sidecarTestDir, SCENE).consecutive_failures;
  assert.strictEqual(before, 1);

  let sidecarValid = false;
  if (fs.existsSync(sidecarFp)) {
    const content = JSON.parse(fs.readFileSync(sidecarFp, 'utf-8'));
    sidecarValid = content.token === currentToken;
    fs.unlinkSync(sidecarFp);
  }
  assert.strictEqual(sidecarValid, true, 'token matches → exit handler skips bottom');
  // 失败计数仍是 1（不双倍）
  assert.strictEqual(ckptState.readState(sidecarTestDir, SCENE).consecutive_failures, 1);
  console.log('PASS L9 sidecar token matches → no double count (Bug 19)');

  // 场景 B: token 不匹配（陈旧 sidecar） → 主进程仍兜底 + consume 旧 marker（Bug 20 修复）
  fs.writeFileSync(sidecarFp, JSON.stringify({ reason: 'stale', token: 'token-OLD-run', at: new Date().toISOString() }));
  let staleValid = false;
  if (fs.existsSync(sidecarFp)) {
    const content = JSON.parse(fs.readFileSync(sidecarFp, 'utf-8'));
    staleValid = content.token === currentToken;
    fs.unlinkSync(sidecarFp);
  }
  assert.strictEqual(staleValid, false, 'stale token → not valid');
  if (!staleValid) {
    ckptState.markFailure(sidecarTestDir, SCENE, 'this-run failure');
  }
  assert.strictEqual(ckptState.readState(sidecarTestDir, SCENE).consecutive_failures, 2, 'stale sidecar → bottom kicks in');
  assert.ok(!fs.existsSync(sidecarFp), 'stale sidecar consumed');
  console.log('PASS L10 sidecar stale token → bottom fallback kicks in (Bug 20)');

  console.log('\nALL PASS · roundtable-memory-phase1.test.js');
  console.log('temp dir:', TEMP);
})().catch((e) => {
  console.error('FAIL:', e.stack || e);
  process.exit(1);
});
