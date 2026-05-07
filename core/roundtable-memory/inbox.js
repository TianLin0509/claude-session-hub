'use strict';
// 圆桌记忆 · pending-{identity}.json 读写 + 生命周期（plan §4.2 / §4.3 / §10 #7）
//
// Phase 3 identity 重构（2026-05-07）：
//   path 从 pending-{slot}.json 改为 pending-{identity}.json
//   identity = makeIdentity(aiKind, model)，e.g. 'claude-opus-4-7'
//   归档 {slot}-YYYYMM.json → {identity}-YYYYMM.json
//   caller（worker / main.js）传 identity 字符串；slot 仅 UI/日志用
//
// 路径：<projectCwd>/.arena/rooms/{scene}/memory/pending-{identity}.json
// 归档路径：<projectCwd>/.arena/rooms/{scene}/memory/inbox-archived/{identity}-YYYYMM.json
//
// schema:
// {
//   "items": [
//     {
//       "id": "pending-2026-05-07-001",
//       "created_at": "2026-05-07T10:30:00Z",
//       "source_checkpoint": "t6",
//       "reason": "用户在 t4-t6 反复提到下行风险偏好",
//       "kind": "preference",
//       "key": "downside-first",
//       "content": "用户重视下行风险",
//       "status": "pending" | "accepted" | "rejected" | "expired",
//       "priority": false,
//       "remind_count": 0
//     }
//   ]
// }
//
// 状态转移（plan §4.3）:
//   AI 采纳 (memory_write 的 entry key 与 pending key 一致) → accepted → 删除
//   AI 拒绝 → rejected → 移到归档
//   remind_count >= 3 → expired → 移到归档
//   created_at 超过 7 天 → expired → 移到归档
//   同 key 重复入 inbox → 自动合并 (更新 reason，保留旧 remind_count)

const fs = require('fs');
const path = require('path');

const MAX_REMIND_COUNT = 3;
const EXPIRE_AFTER_DAYS = 7;

function pendingFilePath(projectCwd, scene, identity) {
  if (!projectCwd || !scene || !identity) return null;
  return path.join(projectCwd, '.arena', 'rooms', scene, 'memory', `pending-${identity}.json`);
}

function archiveDirPath(projectCwd, scene) {
  return path.join(projectCwd, '.arena', 'rooms', scene, 'memory', 'inbox-archived');
}

function archiveFilePath(projectCwd, scene, identity, dateStr) {
  // dateStr 形如 2026-05 → 文件名 {identity}-202605.json
  const ym = dateStr.replace('-', '').slice(0, 6);
  return path.join(archiveDirPath(projectCwd, scene), `${identity}-${ym}.json`);
}

function loadPending(projectCwd, scene, identity) {
  const fp = pendingFilePath(projectCwd, scene, identity);
  if (!fp || !fs.existsSync(fp)) return { items: [], filePath: fp };
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return { items: Array.isArray(parsed.items) ? parsed.items : [], filePath: fp };
  } catch (e) {
    // 不静默：损坏 pending 文件应保留备份方便排查。
    console.warn('[inbox] loadPending parse failed, treating as empty + backing up:', fp, e.message);
    try { fs.renameSync(fp, fp + '.corrupted.' + Date.now()); } catch {}
    return { items: [], filePath: fp };
  }
}

// 原子写盘（write tmp + rename）
// [Bug 8 fix · v2 P1] 移除 unlink+rename 中间窗口，直接 renameSync 原子覆盖
function savePending(projectCwd, scene, identity, items) {
  const fp = pendingFilePath(projectCwd, scene, identity);
  if (!fp) throw new Error('savePending: invalid args');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, JSON.stringify({ items: items || [] }, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return fp;
}

function _genId() {
  const today = new Date().toISOString().slice(0, 10);
  return `pending-${today}-${Math.random().toString(36).slice(2, 7)}`;
}

// worker 调用：把候选追加到 pending（同 key 自动合并 — 更新 reason 但保留旧 remind_count）
//
// candidates: [{ kind, key, content, reason, source_checkpoint, priority? }]
// 返回 { added: N, merged: N }
function appendCandidates(projectCwd, scene, identity, candidates, sourceCheckpoint) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { added: 0, merged: 0, file: null };
  const { items } = loadPending(projectCwd, scene, identity);
  const now = new Date().toISOString();
  let added = 0, merged = 0;
  for (const c of candidates) {
    if (!c || !c.key || !c.content) continue;
    const fullKey = c.kind ? `${c.kind}:${c.key}` : c.key;
    const existing = items.find(it => (it.kind ? `${it.kind}:${it.key}` : it.key) === fullKey && it.status === 'pending');
    if (existing) {
      existing.reason = c.reason || existing.reason;
      existing.content = c.content;
      existing.source_checkpoint = sourceCheckpoint || existing.source_checkpoint;
      merged++;
    } else {
      items.push({
        id: _genId(),
        created_at: now,
        source_checkpoint: sourceCheckpoint || null,
        reason: c.reason || '',
        kind: c.kind || 'preference',
        key: c.key,
        content: String(c.content).trim(),
        status: 'pending',
        priority: !!c.priority,
        remind_count: 0,
      });
      added++;
    }
  }
  savePending(projectCwd, scene, identity, items);
  return { added, merged, file: pendingFilePath(projectCwd, scene, identity) };
}

// dispatch 时调用：取出 pending items 注入到 prompt（按 priority 降序），同时 remind_count++
function pickForInject(projectCwd, scene, identity, limit = 5, opts = {}) {
  const { items, filePath } = loadPending(projectCwd, scene, identity);
  const pending = items.filter(it => it.status === 'pending');
  if (pending.length === 0) return { items: [], filePath, skippedSave: false };
  pending.sort((a, b) => {
    if (!!b.priority - !!a.priority !== 0) return (!!b.priority) - (!!a.priority);
    return (a.created_at || '').localeCompare(b.created_at || '');
  });
  for (const it of pending.slice(0, limit)) {
    it.remind_count = (it.remind_count || 0) + 1;
  }
  // [Bug 9 + Bug 14 fix · v2/v3 P2] 写盘前再次校验 isLocked
  if (typeof opts.isLockedCheck === 'function') {
    try {
      if (opts.isLockedCheck()) {
        return { items: [], filePath, skippedSave: true };
      }
    } catch {
      // isLockedCheck 抛错就当未锁继续保存
    }
  }
  savePending(projectCwd, scene, identity, items);
  return { items: pending.slice(0, limit), filePath, skippedSave: false };
}

// worker reconciliation：根据新写入的 individual .md entries 判断哪些 pending 被 accepted
function reconcile(projectCwd, scene, identity, individualEntries) {
  const { items } = loadPending(projectCwd, scene, identity);
  if (items.length === 0) return { accepted: 0, expired: 0, archived: 0, file: null };

  const acceptedKeys = new Set(individualEntries.map(e => e.key));
  const now = Date.now();
  const remaining = [];
  const archive = [];
  let accepted = 0, expired = 0;
  for (const it of items) {
    if (it.status !== 'pending') {
      archive.push(it);
      continue;
    }
    const fullKey = it.kind ? `${it.kind}:${it.key}` : it.key;
    if (acceptedKeys.has(fullKey)) {
      it.status = 'accepted';
      it.resolved_at = new Date().toISOString();
      archive.push(it);
      accepted++;
      continue;
    }
    const createdMs = it.created_at ? Date.parse(it.created_at) : now;
    const ageDays = (now - createdMs) / (1000 * 86400);
    if ((it.remind_count || 0) >= MAX_REMIND_COUNT || ageDays >= EXPIRE_AFTER_DAYS) {
      it.status = 'expired';
      it.resolved_at = new Date().toISOString();
      archive.push(it);
      expired++;
      continue;
    }
    remaining.push(it);
  }

  savePending(projectCwd, scene, identity, remaining);

  let archivedCount = 0;
  if (archive.length > 0) {
    const ymStr = new Date().toISOString().slice(0, 7);
    const archDir = archiveDirPath(projectCwd, scene);
    fs.mkdirSync(archDir, { recursive: true });
    const archFp = archiveFilePath(projectCwd, scene, identity, ymStr);
    let archItems = [];
    if (fs.existsSync(archFp)) {
      // [Phase 2 silent-failure-hunt fix] 损坏归档备份后写新
      try { archItems = JSON.parse(fs.readFileSync(archFp, 'utf-8')).items || []; }
      catch (e) {
        console.warn('[inbox] archive read failed, backing up corrupted file:', archFp, e.message);
        try { fs.renameSync(archFp, archFp + '.corrupted.' + Date.now()); } catch {}
        archItems = [];
      }
    }
    archItems.push(...archive);
    const archTmp = archFp + '.tmp.' + process.pid + '.' + Date.now();
    fs.writeFileSync(archTmp, JSON.stringify({ items: archItems }, null, 2), 'utf-8');
    fs.renameSync(archTmp, archFp);
    archivedCount = archive.length;
  }

  return { accepted, expired, archived: archivedCount, file: pendingFilePath(projectCwd, scene, identity) };
}

// 用于 UI / IPC：仅查 pending 数（不修改）
function pendingCount(projectCwd, scene, identity) {
  const { items } = loadPending(projectCwd, scene, identity);
  return items.filter(it => it.status === 'pending').length;
}

// Phase 2 P2（2026-05-07）：inbox-archived/ 自动 GC（180 天保留）
const ARCHIVE_RETENTION_DAYS = 180;
function gcArchive(projectCwd, scene, opts = {}) {
  const retention = opts.retentionDays || ARCHIVE_RETENTION_DAYS;
  const dir = archiveDirPath(projectCwd, scene);
  const result = { scanned: 0, removed: 0, errors: [] };
  if (!projectCwd || !scene || !fs.existsSync(dir)) return result;
  const cutoff = new Date(Date.now() - retention * 24 * 60 * 60 * 1000);
  const cutoffYM = cutoff.getFullYear() * 100 + (cutoff.getMonth() + 1);
  let entries;
  try { entries = fs.readdirSync(dir); }
  catch (e) { result.errors.push(e.message); return result; }
  for (const name of entries) {
    // identity 含字母/数字/下划线/横杠，与原 slot 同 charset，regex 不变
    if (!/^[a-z0-9_-]+-(\d{6})\.json$/i.test(name)) continue;
    result.scanned += 1;
    const m = name.match(/-(\d{6})\.json$/);
    if (!m) continue;
    const ym = parseInt(m[1], 10);
    if (Number.isFinite(ym) && ym < cutoffYM) {
      try {
        fs.unlinkSync(path.join(dir, name));
        result.removed += 1;
      } catch (e) {
        result.errors.push(`${name}: ${e.message}`);
      }
    }
  }
  return result;
}

module.exports = {
  MAX_REMIND_COUNT,
  EXPIRE_AFTER_DAYS,
  ARCHIVE_RETENTION_DAYS,
  pendingFilePath,
  archiveDirPath,
  loadPending,
  savePending,
  appendCandidates,
  pickForInject,
  reconcile,
  pendingCount,
  gcArchive,
};
