'use strict';
// 圆桌记忆 · _profile.md 读写（plan §4.4 / §4.5）
//
// 路径：<projectCwd>/.arena/rooms/{scene}/memory/_profile.md
// 角色：worker 派生的"共识层"（三家共现的稳定偏好/规则），AI 只读不写
// 上限：≤ 20 条 entry
//
// 文件结构：
//   ---
//   updated_at: 2026-05-07T10:30:00Z
//   source_checkpoint: t6
//   scene: general
//   entry_count: 12
//   ---
//   [2026-05-07] preference:conclusion-first 用户喜欢结论先行 (recall:5)
//   [2026-05-07] [persisted] rule:no-fundamental-pollution 通用 vs 投研记忆隔离 (recall:8)

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 20;

function profileFilePath(projectCwd, scene) {
  if (!projectCwd || !scene) return null;
  return path.join(projectCwd, '.arena', 'rooms', scene, 'memory', '_profile.md');
}

function profileExists(projectCwd, scene) {
  const fp = profileFilePath(projectCwd, scene);
  return !!(fp && fs.existsSync(fp));
}

// 解析单行 entry：`[2026-05-07] [persisted]? key 内容 (recall:N)?`
// 返回 { date, persisted: bool, key, content, recall }
function parseProfileEntry(line) {
  if (!line) return null;
  const re = /^\[(\d{4}-\d{2}-\d{2})\]\s*(\[persisted\])?\s*([^\s]+)\s+(.+?)(?:\s+\(recall:(\d+)\))?$/;
  const m = re.exec(line.trim());
  if (!m) return null;
  return {
    date: m[1],
    persisted: !!m[2],
    key: m[3],
    content: m[4],
    recall: m[5] != null ? parseInt(m[5], 10) : 0,
  };
}

function renderProfileEntry(e) {
  const persistedTag = e.persisted ? ' [persisted]' : '';
  const recallTag = (typeof e.recall === 'number' && e.recall > 0) ? ` (recall:${e.recall})` : '';
  return `[${e.date}]${persistedTag} ${e.key} ${e.content}${recallTag}`;
}

// 读 _profile.md → { frontmatter, entries }
// 容错：文件不存在返回空；frontmatter 无效保留 raw
function readProfile(projectCwd, scene) {
  const fp = profileFilePath(projectCwd, scene);
  if (!fp || !fs.existsSync(fp)) {
    return { frontmatter: {}, entries: [], filePath: fp };
  }
  const text = fs.readFileSync(fp, 'utf-8');
  // 提取 frontmatter（首两 --- 之间）
  const fmMatch = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  let frontmatter = {};
  let body = text;
  if (fmMatch) {
    const fmText = fmMatch[1];
    body = fmMatch[2];
    for (const ln of fmText.split(/\r?\n/)) {
      const kv = /^([^:]+):\s*(.*)$/.exec(ln);
      if (kv) frontmatter[kv[1].trim()] = kv[2].trim();
    }
  }
  const entries = [];
  for (const ln of body.split(/\r?\n/)) {
    if (!ln.trim() || !ln.startsWith('[')) continue;
    const e = parseProfileEntry(ln);
    if (e) entries.push(e);
  }
  return { frontmatter, entries, filePath: fp };
}

// 写 _profile.md：原子覆写（write tmp + rename）
//
// args:
//   projectCwd, scene
//   entries: [{ date, persisted, key, content, recall }]
//   meta: { source_checkpoint, scene? }（updated_at 自动填）
function writeProfile(projectCwd, scene, entries, meta = {}) {
  const fp = profileFilePath(projectCwd, scene);
  if (!fp) throw new Error('writeProfile: invalid projectCwd/scene');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  // 应用淘汰：persisted 永远保留，其余按 recall 降序 + date 新优先排序，截 MAX_ENTRIES
  const persisted = entries.filter(e => e.persisted);
  const others = entries.filter(e => !e.persisted)
    .sort((a, b) => {
      const ra = a.recall || 0, rb = b.recall || 0;
      if (rb !== ra) return rb - ra;
      return (b.date || '').localeCompare(a.date || '');
    });
  const room = Math.max(0, MAX_ENTRIES - persisted.length);
  const finalEntries = [...persisted, ...others.slice(0, room)];

  const fm = {
    updated_at: new Date().toISOString(),
    source_checkpoint: meta.source_checkpoint || null,
    scene,
    entry_count: finalEntries.length,
  };
  const fmLines = Object.entries(fm)
    .map(([k, v]) => `${k}: ${v == null ? '' : v}`)
    .join('\n');
  const body = finalEntries.map(renderProfileEntry).join('\n');
  const text = `---\n${fmLines}\n---\n${body}\n`;

  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, text, 'utf-8');
  // [Bug 8 fix · v2 P1] 直接 renameSync 原子覆盖（Node 18+ Windows 已支持），消除 unlink/rename 窗口
  fs.renameSync(tmp, fp);
  return { filePath: fp, finalEntries };
}

// 增量：worker 输出 keep/evict/new 三清单 → 应用到现有 _profile.md
//
// keep:  保留的 keys（其余非 persisted 的可能被 evict）
// evict: 显式淘汰的 keys（即使 recall 高）
// new:   新增 entries（{ date?, persisted?, key, content, recall? }，date/recall 可缺省）
function applyTrioUpdate(projectCwd, scene, { keep = [], evict = [], add = [] }, sourceCheckpoint) {
  const cur = readProfile(projectCwd, scene);
  const keepSet = new Set(keep);
  const evictSet = new Set(evict);
  // Persisted 永远不动（即使 evict 列出也忽略）
  const survivors = cur.entries.filter(e => {
    if (e.persisted) return true;
    if (evictSet.has(e.key)) return false;
    if (keepSet.size > 0 && !keepSet.has(e.key)) return false; // 显式 keep 时未列入即淘汰
    return true;
  });
  // 新 entries 合并（同 key 去重，新内容覆盖旧）
  const merged = [...survivors];
  const today = new Date().toISOString().slice(0, 10);
  for (const ne of add) {
    if (!ne || !ne.key || !ne.content) continue;
    const idx = merged.findIndex(e => e.key === ne.key);
    const candidate = {
      date: ne.date || today,
      persisted: !!ne.persisted,
      key: ne.key,
      content: String(ne.content).trim(),
      recall: ne.recall || 0,
    };
    if (idx >= 0) merged[idx] = candidate;
    else merged.push(candidate);
  }
  return writeProfile(projectCwd, scene, merged, { source_checkpoint: sourceCheckpoint });
}

module.exports = {
  MAX_ENTRIES,
  profileFilePath,
  profileExists,
  parseProfileEntry,
  renderProfileEntry,
  readProfile,
  writeProfile,
  applyTrioUpdate,
};
