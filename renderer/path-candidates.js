const fs = require('fs');
const os = require('os');
const path = require('path');

const ABS_PATH_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n\s]+[\\/])*[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
const REL_PATH_RE = /(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n\s]+[\\/])+[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/g;
const ABS_DIR_RE = /(?:[A-Za-z]:[\\/]|\\\\[^\\/:*?"<>|\r\n\s]+\\|~[\\/])(?:[^\\/:*?"<>|\r\n]+[\\/])+[^\\/:*?"<>|\r\n]+[\\/]?/g;
const REL_DIR_RE = /(?:\.{1,2}[\\/])?(?:[^\\/:*?"<>|\r\n]+[\\/]){1,}[^\\/:*?"<>|\r\n]+[\\/]?/g;
const REL_BARE_RE = /(?<![\w.-])[^\\/:*?"<>|\r\n\s]+\.[A-Za-z0-9]{1,8}(?![\w.-])|(?<![\w.-])[^\\/:*?"<>|\r\n\s.]{2,}(?![\w.-])/g;
const URL_RE = /\bhttps?:\/\/[\w\-.~]+(?::\d+)?(?:[\/?#][^\s<>"'`\\]*)?/g;
const PREVIEW_PATH_RE = /\.(?:html?|md|markdown|png|jpe?g|gif|webp|bmp|svg|pdf|csv|tsv|json|jsonl|js|ts|jsx|tsx|mjs|cjs|py|go|rs|java|c|cpp|h|hpp|cs|txt|log|ya?ml|toml|ini|cfg|conf|sh|bat|ps1|xml|sql|r|rb|php|swift|kt|lua|zig|asm|css|scss|less)$/i;
const HUB_IMG_PATH_RE = /(?:[A-Za-z]:)?[\\/][^\s]*[\\/]\.claude-session-hub[\\/]images[\\/][^\s]+?\.(?:png|jpe?g|gif|webp|bmp)/gi;

const REL_PATH_CACHE = new Map();
const REL_PATH_CACHE_MAX = 256;
const REL_PATH_CACHE_TTL_MS = 5000;

function _cleanPathCandidate(raw) {
  let s = String(raw || '').replace(/[\r\n]+/g, '').trim();
  s = s.replace(/^[`'"\u201c\u201d\u2018\u2019(<\[]+/, '');
  s = s.replace(/[`'"\u201c\u201d\u2018\u2019)>.,;:!\]]+$/, '');
  return s;
}

function _expandHomePath(filePath) {
  if (/^~[\\/]/.test(filePath)) {
    try { return path.join(os.homedir(), filePath.slice(2)); } catch {}
  }
  return filePath;
}

function _isAbsLocalPath(filePath) {
  return /^[A-Za-z]:[\\/]/.test(filePath)
    || /^\\\\[^\\/:*?"<>|\r\n\s]+\\/.test(filePath)
    || /^~[\\/]/.test(filePath);
}

function _statPathQuiet(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

function _normalizeLocalPathForOpen(openPath, cwd, requireExistsForRel = true) {
  let p = _cleanPathCandidate(openPath);
  if (!p) return null;
  p = _expandHomePath(p);
  if (_isAbsLocalPath(p)) return p;
  if (!cwd) return null;
  let abs = null;
  try { abs = path.resolve(cwd, p); } catch { return null; }
  if (requireExistsForRel && !fs.existsSync(abs)) return null;
  return abs;
}

function _isDirectoryPath(filePath) {
  const st = _statPathQuiet(filePath);
  return !!(st && st.isDirectory());
}

function _resolveRelPathIfExists(cwd, relPath) {
  const key = `${cwd}|${relPath}`;
  const now = Date.now();
  const hit = REL_PATH_CACHE.get(key);
  if (hit && now - hit.ts < REL_PATH_CACHE_TTL_MS) {
    REL_PATH_CACHE.delete(key);
    REL_PATH_CACHE.set(key, hit);
    return hit.absPath;
  }
  let absPath = null;
  try {
    const candidate = path.resolve(cwd, relPath);
    if (fs.existsSync(candidate)) absPath = candidate;
  } catch {}
  REL_PATH_CACHE.set(key, { absPath, ts: now });
  if (REL_PATH_CACHE.size > REL_PATH_CACHE_MAX) {
    const oldestKey = REL_PATH_CACHE.keys().next().value;
    REL_PATH_CACHE.delete(oldestKey);
  }
  return absPath;
}

function _addCandidate(candidates, start, end, openPath, isUrl = false) {
  if (!openPath || end < start) return;
  const overlapsExisting = candidates.some(c => !(end < c.start || start > c.end));
  if (overlapsExisting) return;
  candidates.push({ start, end, openPath, isUrl });
}

function collectPathCandidates(text, cwd = null, opts = {}) {
  const candidates = [];
  text = String(text || '');
  let m;
  URL_RE.lastIndex = 0;
  while ((m = URL_RE.exec(text))) {
    const trimmed = m[0].replace(/[.,;:!?)\]]+$/, '');
    if (trimmed.length >= 'http://x'.length) {
      _addCandidate(candidates, m.index, m.index + trimmed.length - 1, trimmed, true);
    }
  }

  ABS_PATH_RE.lastIndex = 0;
  while ((m = ABS_PATH_RE.exec(text))) {
    _addCandidate(candidates, m.index, m.index + m[0].length - 1, _cleanPathCandidate(m[0]));
  }

  if (opts.includeDirectories !== false) {
    ABS_DIR_RE.lastIndex = 0;
    while ((m = ABS_DIR_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const fullPath = _normalizeLocalPathForOpen(raw, cwd, false);
      if (fullPath && _isDirectoryPath(fullPath)) {
        _addCandidate(candidates, m.index, m.index + m[0].length - 1, fullPath);
      }
    }
  }

  if (cwd) {
    REL_PATH_RE.lastIndex = 0;
    while ((m = REL_PATH_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const absPath = _resolveRelPathIfExists(cwd, raw);
      if (absPath) _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
    }

    if (opts.includeDirectories !== false) {
      REL_DIR_RE.lastIndex = 0;
      while ((m = REL_DIR_RE.exec(text))) {
        const raw = _cleanPathCandidate(m[0]);
        if (PREVIEW_PATH_RE.test(raw)) continue;
        const absPath = _resolveRelPathIfExists(cwd, raw);
        if (absPath && _isDirectoryPath(absPath)) {
          _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
        }
      }
    }

    REL_BARE_RE.lastIndex = 0;
    while ((m = REL_BARE_RE.exec(text))) {
      const raw = _cleanPathCandidate(m[0]);
      const absPath = _resolveRelPathIfExists(cwd, raw);
      if (!absPath) continue;
      const st = _statPathQuiet(absPath);
      if (!st) continue;
      if (st.isDirectory() || PREVIEW_PATH_RE.test(absPath)) {
        _addCandidate(candidates, m.index, m.index + m[0].length - 1, absPath);
      }
    }
  }

  return candidates.sort((a, b) => a.start - b.start);
}

module.exports = {
  ABS_PATH_RE,
  REL_PATH_RE,
  ABS_DIR_RE,
  REL_DIR_RE,
  REL_BARE_RE,
  URL_RE,
  PREVIEW_PATH_RE,
  HUB_IMG_PATH_RE,
  collectPathCandidates,
  _cleanPathCandidate,
  _expandHomePath,
  _isAbsLocalPath,
  _statPathQuiet,
  _normalizeLocalPathForOpen,
  _isDirectoryPath,
  _resolveRelPathIfExists,
};
