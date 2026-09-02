// 2026-08-09 [休眠卡时间回填] 回归测试：
//   T1: transcript mtime 比 lastMessageTime 新 → 回填为 mtime
//   T2: lastMessageTime 更新 → 不回退（只增不减）
//   T3: transcript 文件缺失/无 transcriptPath → 不动，不抛错
//   T4: 缺 lastMessageTime → 直接采用 mtime
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { backfillDormantLastMessageTime } = require('../main/ipc/persistence-handlers.js');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-backfill-'));
  const transcript = path.join(dir, 'wire.jsonl');
  fs.writeFileSync(transcript, '{}\n', 'utf8');

  const DAY = 24 * 3600 * 1000;
  const now = Date.now();
  const mtime = now - 1 * DAY; // 昨天有活动
  fs.utimesSync(transcript, new Date(mtime), new Date(mtime));

  // T1：6 天前的 lastMessageTime → 回填到昨天
  const s1 = { hubId: 'a', lastMessageTime: now - 6 * DAY, transcriptPath: transcript };
  await backfillDormantLastMessageTime([s1]);
  const statMtime = Math.round(fs.statSync(transcript).mtimeMs);
  assert.strictEqual(s1.lastMessageTime, statMtime, 'T1 应回填为 transcript mtime');
  console.log('PASS T1 mtime 更新 → 回填');

  // T2：lastMessageTime 是 1 小时前（比 mtime 新）→ 保持
  const s2 = { hubId: 'b', lastMessageTime: now - 3600 * 1000, transcriptPath: transcript };
  await backfillDormantLastMessageTime([s2]);
  assert.strictEqual(s2.lastMessageTime, now - 3600 * 1000, 'T2 不应回退');
  console.log('PASS T2 lastMessageTime 更新 → 不回退');

  // T3：文件不存在 + 无 transcriptPath
  const s3 = { hubId: 'c', lastMessageTime: 12345, transcriptPath: path.join(dir, 'gone.jsonl') };
  const s4 = { hubId: 'd', lastMessageTime: 12345 };
  await backfillDormantLastMessageTime([s3, s4, null]);
  assert.strictEqual(s3.lastMessageTime, 12345);
  assert.strictEqual(s4.lastMessageTime, 12345);
  console.log('PASS T3 缺失文件/无路径 → 不动不抛');

  // T4：没有 lastMessageTime → 采用 mtime
  const s5 = { hubId: 'e', transcriptPath: transcript };
  await backfillDormantLastMessageTime([s5]);
  assert.strictEqual(s5.lastMessageTime, statMtime);
  console.log('PASS T4 缺 lastMessageTime → 采用 mtime');

  fs.rmSync(dir, { recursive: true, force: true });
  console.log('ALL PASS persistence-backfill');
  process.exit(0);
})().catch((err) => { console.error(err); process.exit(1); });
