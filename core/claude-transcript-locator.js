'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CLAUDE_PROJECT_ROOT_DIRS = [
  '.claude',
  '.claude-deepseek',
];

function defaultHomeDir() {
  return process.env.USERPROFILE || process.env.HOME || os.homedir();
}

function claudeProjectRoots(homeDir = defaultHomeDir()) {
  return CLAUDE_PROJECT_ROOT_DIRS.map(dir => path.join(homeDir, dir, 'projects'));
}

// DeepSeek 跑同一个 claude CLI，但 session-manager 把 CLAUDE_CONFIG_DIR 指到
// ~/.claude-deepseek（见 core/session-manager.js 的 sessionEnv.CLAUDE_CONFIG_DIR）。
// 按 kind 收窄根目录，可让"同一 cwd 下 claude + deepseek 两位群聊成员"的 transcript
// 落在互不相交的目录里，发现期不会互相当成候选。kind 不认识时退回全部根。
function claudeProjectRootDirsForKind(kind) {
  const normalized = String(kind || '').toLowerCase();
  if (normalized.startsWith('deepseek')) return ['.claude-deepseek'];
  if (normalized.startsWith('claude')) return ['.claude'];
  return CLAUDE_PROJECT_ROOT_DIRS.slice();
}

function findTranscriptByCCSessionId(ccSessionId, homeDir = defaultHomeDir()) {
  if (!ccSessionId) return null;
  for (const projectsDir of claudeProjectRoots(homeDir)) {
    try {
      const entries = fs.readdirSync(projectsDir, { withFileTypes: true });
      for (const d of entries) {
        if (!d.isDirectory()) continue;
        const candidate = path.join(projectsDir, d.name, ccSessionId + '.jsonl');
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

// Claude CLI buckets transcripts by cwd: every non-alphanumeric char becomes '-'.
// `claude --resume <id>` only looks inside the bucket for the *current* cwd, so a
// workspace that moves on disk (scratch → 正式分类归档) leaves its transcript behind
// and the resume fails with "No conversation found with session ID".
function projectSlug(cwd) {
  return path.resolve(String(cwd || '')).replace(/[^A-Za-z0-9]/g, '-');
}

// B1（2026-07-29）：全新 Claude 会话的 <ccSessionId>.jsonl 要到 CLI 真正开始写第一轮
// 才被创建，注册时既没有 ccSessionId 也没有文件 —— 只能反过来盯 cwd 对应的 bucket 目录。
// 返回该 cwd 在各 CLAUDE_CONFIG_DIR 下的 projects/<slug> 目录（目录可能还不存在）。
function claudeProjectDirsForCwd(cwd, opts = {}) {
  const homeDir = opts.homeDir || defaultHomeDir();
  const rootDirs = opts.rootDirs || claudeProjectRootDirsForKind(opts.kind);
  const slug = projectSlug(cwd);
  return rootDirs.map(dir => path.join(homeDir, dir, 'projects', slug));
}

// 列出某 cwd bucket 下现存的全部 transcript jsonl（按 mtime 新→旧）。
// 纯 stat，不解析内容；目录不存在返回空数组（新 cwd 的常态，不是错误）。
function listClaudeTranscriptsForCwd(cwd, opts = {}) {
  const out = [];
  for (const dir of claudeProjectDirsForCwd(cwd, opts)) {
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const full = path.join(dir, name);
      let stat;
      try { stat = fs.statSync(full); } catch { continue; }
      if (!stat.isFile()) continue;
      out.push({ path: full, mtimeMs: stat.mtimeMs, birthtimeMs: stat.birthtimeMs, size: stat.size });
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return out;
}

// Copy each session's transcript into the bucket for `toCwd` so the post-archive
// `--resume` finds it. Best-effort: the archive itself already succeeded, so a
// failure here must degrade to "resumes without history", never abort the move.
function migrateTranscriptsForCwdChange(opts = {}) {
  const { toCwd, ccSessionIds = [] } = opts;
  const homeDir = opts.homeDir || defaultHomeDir();
  const logger = opts.logger || console;
  const result = { copied: [], missing: [], errors: [] };
  if (!toCwd) return result;
  const slug = projectSlug(toCwd);

  for (const ccSessionId of ccSessionIds) {
    if (!ccSessionId) continue;
    try {
      const source = findTranscriptByCCSessionId(ccSessionId, homeDir);
      if (!source) {
        result.missing.push(ccSessionId);
        continue;
      }
      // <homeDir>/<.claude|.claude-deepseek>/projects/<slug>/<sid>.jsonl —
      // keep the copy under the same root the CLI variant reads from.
      const projectsDir = path.dirname(path.dirname(source));
      const targetDir = path.join(projectsDir, slug);
      const target = path.join(targetDir, `${ccSessionId}.jsonl`);
      if (path.resolve(source) === path.resolve(target)) {
        result.copied.push(target);
        continue;
      }
      fs.mkdirSync(targetDir, { recursive: true });
      fs.copyFileSync(source, target);
      result.copied.push(target);
    } catch (error) {
      result.errors.push(`${ccSessionId}: ${error && error.message ? error.message : String(error)}`);
      logger.warn?.('[transcript] migrate failed:', error && error.message);
    }
  }
  return result;
}

function extractCwdFromTranscript(transcriptPath) {
  try {
    const fd = fs.openSync(transcriptPath, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      const text = buf.slice(0, n).toString('utf-8');
      const m = text.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
      if (m) return JSON.parse('"' + m[1] + '"');
    } finally {
      fs.closeSync(fd);
    }
  } catch {}
  return null;
}

function healPersistedCwds(sessions, opts = {}) {
  const logger = opts.logger || console;
  const homeDir = opts.homeDir || defaultHomeDir();
  let fixed = 0;
  for (const s of sessions) {
    if (!s.ccSessionId) continue;
    const tp = findTranscriptByCCSessionId(s.ccSessionId, homeDir);
    if (!tp) continue;
    const realCwd = extractCwdFromTranscript(tp);
    if (realCwd && realCwd !== s.cwd) {
      logger.log?.(`[群聊] heal cwd: "${s.title}" ${s.cwd} -> ${realCwd}`);
      s.cwd = realCwd;
      fixed++;
    }
  }
  return fixed;
}

module.exports = {
  CLAUDE_PROJECT_ROOT_DIRS,
  claudeProjectDirsForCwd,
  claudeProjectRootDirsForKind,
  claudeProjectRoots,
  extractCwdFromTranscript,
  listClaudeTranscriptsForCwd,
  findTranscriptByCCSessionId,
  healPersistedCwds,
  migrateTranscriptsForCwdChange,
  projectSlug,
};
