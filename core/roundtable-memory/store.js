'use strict';
// 圆桌记忆存储层（plan 2026-05-05 阶段 0 / phase 3 identity 重构 2026-05-07 / phase 4 family 共享 2026-05-08）
//
// 文件路径：<projectCwd>/.arena/rooms/{scene}/memory/{identity}.md
//   - projectCwd 由 _resolveMemoryProjectCwd 给出（phase 2：scene 共享根 / 用户项目根双路径）
//   - scene = 'general' | 'research' | 'dev'
//   - identity = canonicalAiKind(aiKind)（phase 4：家族级 — 7 个家族 claude/gemini/gpt/deepseek/glm/kimi/qwen）
//       e.g. 'claude.md' (含 opus/sonnet/haiku) / 'gpt.md' (含 codex+packy-gpt) / 'gemini.md' / ...
//
// Phase 4 设计变更（2026-05-08）：从 model 粒度回退到家族粒度
//   理由：phase 3 严格隔离同家族不同 model（Opus 4.7 ≠ Sonnet 4.6），但用户视角"Anthropic 升级 Opus
//   不该失忆 / Claude 系列是同伙伴的不同档位"。家族级共享让升级无缝、跨家族隔离仍然存在。
//   API 兼容：保留 makeIdentity(aiKind, model) 签名，model 参数现仅日志用，不影响存储 key。
//
// Phase 3 历史（2026-05-07）：原来按 slot（pikachu/charmander/squirtle）存——slot 是 UI 槽位不是 AI 身份。
//   场 A Opus 坐 slot 1 写 pikachu.md，场 B Gemini 坐 slot 1 写同一文件→污染。
//   phase 3 改成 identity（kind+model 派生），phase 4 进一步回退到家族级（kind canonical）。
//
// 行格式（plan §4.6）：
//   [YYYY-MM-DD] [scope: scene] [source: self|inbox|explicit] [recall: N, last: YYYY-MM-DD|-] kind:key
//   <content 一行>
//
// 同 key 写入 = 覆盖最新 + recall+1（dedup）。

const fs = require('fs');
const path = require('path');

const VALID_KINDS = ['preference', 'fact', 'observation', 'persisted'];
const VALID_SOURCES = ['self', 'inbox', 'explicit'];
const VALID_SCOPES = ['scene'];

// Phase 4 helper（2026-05-08）：identity = canonicalAiKind(aiKind)，model 仅日志用。
//   保留 (aiKind, model) 签名兼容 phase 3 调用点 + 测试断言。
//   canonical 映射：codex→gpt（OpenAI 家族合并）、claude-resume→claude；详见 core/ai-kinds.js。
//   例：makeIdentity('codex','gpt-5.2') → 'gpt'；makeIdentity('claude','claude-opus-4-7') → 'claude'。
const { canonicalAiKind, FAMILY_KINDS } = require('../ai-kinds.js');

function makeIdentity(aiKind, _model) {
  const sanitize = (s) => String(s || '').toLowerCase().trim()
    .replace(/[\s.]+/g, '-')
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  const raw = sanitize(aiKind) || 'unknown';
  const canonical = canonicalAiKind(raw);
  // [Phase 4 三路评审 · DeepSeek/Codex 共识] 白名单防御：
  //   若 caller 误传带 model 后缀的 aiKind（如 'gemini-2.0-flash'），canonicalAiKind 会原样返回
  //   → identity 变成 'gemini-2-0-flash' 破坏家族共享。这里反向尝试家族前缀提取：
  //   遍历 FAMILY_KINDS 找 raw 的前缀匹配（'gemini-2-0-flash'.startsWith('gemini-') → 'gemini'）。
  //   匹配不到则保留 canonical（如 'mistral' 仍按 unknown family 处理）。
  if (!FAMILY_KINDS.includes(canonical)) {
    for (const fam of FAMILY_KINDS) {
      if (raw === fam || raw.startsWith(fam + '-')) return fam;
    }
  }
  return canonical;
}

// 防护性：从外部输入（HTTP body 等）解析 identity 时直接用 makeIdentity。
// 不接受用户传 raw identity 字符串——必须经 (aiKind, model) 派生，否则容易造路径穿越。
function isValidIdentity(s) {
  return typeof s === 'string' && /^[a-z0-9_-]+$/.test(s) && s.length > 0 && s.length < 80
    && s !== '_profile' && !s.startsWith('pending-') && !s.startsWith('inbox-');
}

function memoryDir(projectCwd, scene) {
  if (!projectCwd || !scene) return null;
  return path.join(projectCwd, '.arena', 'rooms', scene, 'memory');
}

function memoryFile(projectCwd, scene, identity) {
  const dir = memoryDir(projectCwd, scene);
  if (!dir || !identity) return null;
  if (!isValidIdentity(identity)) return null;
  return path.join(dir, identity + '.md');
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function todayDate() {
  return new Date().toISOString().slice(0, 10);
}

function parseEntry(headerLine, contentLine) {
  const re = /^\[(\d{4}-\d{2}-\d{2})\] \[scope: ([^\]]+)\] \[source: ([^\]]+)\] \[recall: (\d+), last: ([^\]]+)\] (.+)$/;
  const m = re.exec(headerLine || '');
  if (!m) return null;
  return {
    date: m[1],
    scope: m[2],
    source: m[3],
    recall: parseInt(m[4], 10),
    last: m[5] === '-' ? null : m[5],
    key: m[6].trim(),
    content: (contentLine || '').trim(),
  };
}

function loadEntries(projectCwd, scene, identity) {
  const fp = memoryFile(projectCwd, scene, identity);
  if (!fp || !fs.existsSync(fp)) return [];
  const text = fs.readFileSync(fp, 'utf-8');
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line || line.startsWith('#') || line.startsWith('---')) continue;
    if (line.startsWith('[')) {
      const e = parseEntry(line, lines[i + 1]);
      if (e) {
        entries.push(e);
        i++;
      }
    }
  }
  return entries;
}

function renderHeader(e) {
  const last = e.last || '-';
  return `[${e.date}] [scope: ${e.scope}] [source: ${e.source}] [recall: ${e.recall}, last: ${last}] ${e.key}`;
}

function renderEntry(e) {
  return `${renderHeader(e)}\n${e.content}\n`;
}

function rewriteAll(fp, entries) {
  const header = '# Roundtable Memory\n# 行格式见 core/roundtable-memory/store.js · plan §4.6\n---\n';
  const body = entries.map(renderEntry).join('\n');
  fs.writeFileSync(fp, header + '\n' + body, 'utf-8');
}

function ensureFileWithHeader(fp) {
  if (fs.existsSync(fp)) return;
  ensureDir(path.dirname(fp));
  const header = '# Roundtable Memory\n# 行格式见 core/roundtable-memory/store.js · plan §4.6\n---\n\n';
  fs.writeFileSync(fp, header, 'utf-8');
}

// 追加一条 memory（含同 key dedup：覆盖最新，recall+1）
//
// args:
//   projectCwd, scene, identity
//   scope='scene', kind, key, content, source='self'
//
// Phase 3：identity 是 makeIdentity(aiKind, model) 派生的字符串。
// caller（hookServer / 测试）应优先用 (aiKind, model) 调 appendMemoryEntryByKindModel。
function appendMemoryEntry(args) {
  const {
    projectCwd, scene, identity,
    scope = 'scene', kind, key, content, source = 'self',
  } = args || {};
  if (!projectCwd) return { ok: false, error: 'projectCwd required' };
  if (!scene) return { ok: false, error: 'scene required' };
  if (!identity) return { ok: false, error: 'identity required' };
  if (!isValidIdentity(identity)) return { ok: false, error: 'invalid identity (must be sanitized): ' + identity };
  if (!VALID_SCOPES.includes(scope)) return { ok: false, error: 'invalid scope: ' + scope };
  if (!VALID_KINDS.includes(kind)) return { ok: false, error: 'invalid kind: ' + kind };
  if (!VALID_SOURCES.includes(source)) return { ok: false, error: 'invalid source: ' + source };
  if (!key || !String(key).trim()) return { ok: false, error: 'key required' };
  if (!content || !String(content).trim()) return { ok: false, error: 'content required' };

  const fp = memoryFile(projectCwd, scene, identity);
  if (!fp) return { ok: false, error: 'memoryFile null (invalid args)' };
  ensureFileWithHeader(fp);

  const fullKey = `${kind}:${String(key).trim()}`;
  const cleanContent = String(content).trim().replace(/\s+/g, ' ');
  const entries = loadEntries(projectCwd, scene, identity);
  const existing = entries.find(e => e.key === fullKey);

  let entry, action;
  if (existing) {
    existing.date = todayDate();
    existing.scope = scope;
    existing.source = source;
    existing.recall = (existing.recall || 0) + 1;
    existing.last = todayDate();
    existing.content = cleanContent;
    entry = existing;
    action = 'update';
    rewriteAll(fp, entries);
  } else {
    entry = {
      date: todayDate(),
      scope,
      source,
      recall: 0,
      last: null,
      key: fullKey,
      content: cleanContent,
    };
    fs.appendFileSync(fp, renderEntry(entry) + '\n', 'utf-8');
    action = 'create';
  }
  return { ok: true, file: fp, entry, action };
}

// Phase 3 便利包装：从 (aiKind, model) 直接派生 identity 后调 appendMemoryEntry。
function appendMemoryEntryByKindModel(args) {
  const { aiKind, model } = args || {};
  return appendMemoryEntry({ ...args, identity: makeIdentity(aiKind, model) });
}

function searchMemory(args) {
  const { projectCwd, scene, identity, query, limit = 5 } = args || {};
  if (!query || !identity) return { ok: false, error: 'query and identity required', results: [] };
  if (!isValidIdentity(identity)) return { ok: false, error: 'invalid identity: ' + identity, results: [] };
  const entries = loadEntries(projectCwd, scene, identity);
  const q = String(query).toLowerCase();
  const hits = entries.filter(e =>
    e.key.toLowerCase().includes(q) || e.content.toLowerCase().includes(q));
  if (hits.length > 0) {
    for (const e of hits) {
      e.recall = (e.recall || 0) + 1;
      e.last = todayDate();
    }
    rewriteAll(memoryFile(projectCwd, scene, identity), entries);
  }
  return { ok: true, results: hits.slice(0, limit) };
}

function searchMemoryByKindModel(args) {
  const { aiKind, model } = args || {};
  return searchMemory({ ...args, identity: makeIdentity(aiKind, model) });
}

function listMemory(args) {
  const { projectCwd, scene, identity, kind } = args || {};
  if (!identity) return { ok: false, error: 'identity required', results: [] };
  if (!isValidIdentity(identity)) return { ok: false, error: 'invalid identity: ' + identity, results: [] };
  const entries = loadEntries(projectCwd, scene, identity);
  if (!kind) return { ok: true, results: entries };
  return { ok: true, results: entries.filter(e => e.key.startsWith(kind + ':')) };
}

function listMemoryByKindModel(args) {
  const { aiKind, model } = args || {};
  return listMemory({ ...args, identity: makeIdentity(aiKind, model) });
}

// Phase 3：扫 memDir 找出所有 identity（排除 _profile.md / pending-*.json / legacy-by-slot）
//   worker / GC 等需要遍历"所有 AI 的 .md"时使用，不再写死 SLOTS=['pikachu',...]。
function listAllIdentities(projectCwd, scene) {
  const dir = memoryDir(projectCwd, scene);
  if (!dir || !fs.existsSync(dir)) return [];
  let names;
  // [Phase 4 silent-failure-hunt] readdir 失败时静默返回空会让 worker/GC 误以为"无 AI"跳过整个 scene。
  try { names = fs.readdirSync(dir); }
  catch (e) { console.warn('[mem] listAllIdentities readdir failed:', dir, e.message); return []; }
  const ids = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    if (id === '_profile') continue;
    if (id.startsWith('pending-')) continue; // 防御（pending 是 .json，不该 .md，但还是排除）
    if (!isValidIdentity(id)) continue;
    ids.push(id);
  }
  return ids;
}

module.exports = {
  VALID_KINDS,
  VALID_SOURCES,
  VALID_SCOPES,
  makeIdentity,
  isValidIdentity,
  memoryDir,
  memoryFile,
  parseEntry,
  loadEntries,
  renderHeader,
  renderEntry,
  appendMemoryEntry,
  appendMemoryEntryByKindModel,
  searchMemory,
  searchMemoryByKindModel,
  listMemory,
  listMemoryByKindModel,
  listAllIdentities,
};
