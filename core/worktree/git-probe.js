'use strict';

const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const TTL_MS = 30 * 1000;
const SLOW_MS = 5 * 1000;
const ABORT_MS = 15 * 1000;

const cache = new Map();        // realCwd → { result, ts }
const inflight = new Map();     // realCwd → Promise

function _resetCacheForTest() { cache.clear(); inflight.clear(); }

function parsePorcelain(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = { branch: null, ahead: 0, behind: 0, dirty: [] };
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith('# branch.head ')) {
      out.branch = line.slice('# branch.head '.length);
    } else if (line.startsWith('# branch.ab ')) {
      const m = /^# branch\.ab \+(\d+) -(\d+)$/.exec(line);
      if (m) { out.ahead = parseInt(m[1], 10); out.behind = parseInt(m[2], 10); }
    } else if (line.startsWith('1 ')) {
      // ordinary changed: "1 XY sub mode mode mode H1 H2 path"
      const parts = line.split(' ');
      const xy = parts[1];
      const path = parts.slice(8).join(' ');
      out.dirty.push({ path, status: xy.replace('.', '').charAt(0) || 'M' });
    } else if (line.startsWith('2 ')) {
      // renamed: "2 XY sub mode mode mode H1 H2 Rscore path<TAB>orig"
      const tabIdx = line.indexOf('\t');
      const newPath = line.slice(0, tabIdx).split(' ').slice(9).join(' ');
      const oldPath = line.slice(tabIdx + 1);
      out.dirty.push({ path: newPath, status: 'R', from: oldPath });
    } else if (line.startsWith('? ')) {
      out.dirty.push({ path: line.slice(2), status: 'U' });
    } else if (line.startsWith('u ')) {
      // unmerged: "u XY sub m1 m2 m3 mW h1 h2 h3 path"
      const parts = line.split(' ');
      const path = parts.slice(10).join(' ');
      if (path) out.dirty.push({ path, status: 'C' });  // 'C' = conflict (distinct from 'U' untracked)
    }
  }
  return out;
}

function parseWorktreeList(text) {
  const out = [];
  let cur = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (cur) out.push(cur);
      cur = { cwd: line.slice('worktree '.length), head: null, branch: null };
    } else if (line.startsWith('HEAD ')) {
      if (cur) cur.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      if (cur) {
        const m = /^branch refs\/heads\/(.+)$/.exec(line);
        cur.branch = m ? m[1] : line.slice('branch '.length);
      }
    } else if (line === 'detached') {
      if (cur) cur.branch = null;
    } else if (line === '' && cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

function _runGit(cwd, args) {
  return new Promise((resolve, reject) => {
    const child = cp.spawn('git', args, { cwd, windowsHide: true });
    let out = '', err = '';
    const slowTimer = setTimeout(() => { /* UI 层观测，这里不动 */ }, SLOW_MS);
    const abortTimer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('git timeout'));
    }, ABORT_MS);
    child.stdout.on('data', d => out += d);
    child.stderr.on('data', d => err += d);
    child.on('close', code => {
      clearTimeout(slowTimer); clearTimeout(abortTimer);
      if (code === 0) resolve(out);
      else if (/not a git repository/i.test(err)) resolve(null);
      else reject(new Error(`git ${args.join(' ')}: exit ${code}: ${err.trim()}`));
    });
    child.on('error', e => {
      clearTimeout(slowTimer); clearTimeout(abortTimer);
      reject(e);
    });
  });
}

async function probeRepo(cwd, opts = {}) {
  const force = !!opts.force;
  let realCwd;
  try { realCwd = fs.realpathSync(cwd); } catch (_) {
    return { isRepo: false, error: 'cwd-missing', cwd };
  }
  const cached = cache.get(realCwd);
  if (!force && cached && Date.now() - cached.ts < TTL_MS) return cached.result;

  if (inflight.has(realCwd)) return inflight.get(realCwd);

  const promise = (async () => {
    try {
      const root = await _runGit(realCwd, ['rev-parse', '--show-toplevel']);
      if (!root) return { isRepo: false, cwd: realCwd };
      let repoRoot = root.trim();
      try { repoRoot = fs.realpathSync(repoRoot); } catch (_) { repoRoot = path.resolve(repoRoot); }

      // git-common-dir: same .git path for ALL linked worktrees of a repo.
      // Used as the "same repo" identity key — repoRoot alone is per-worktree.
      let commonDir;
      try {
        const cd = await _runGit(realCwd, ['rev-parse', '--git-common-dir']);
        if (cd) {
          commonDir = cd.trim();
          // resolve relative to repoRoot if not absolute
          if (!path.isAbsolute(commonDir)) commonDir = path.resolve(repoRoot, commonDir);
          try { commonDir = fs.realpathSync(commonDir); } catch (_) {}
        }
      } catch (_) { commonDir = null; }

      const [statusText, lastCommitText] = await Promise.all([
        _runGit(repoRoot, ['status', '--porcelain=2', '--branch']),
        _runGit(repoRoot, ['log', '-1', '--format=%h%x09%s%x09%cr']),
      ]);
      const status = parsePorcelain(statusText);
      const [hash, subject, when] = String(lastCommitText || '').trim().split('\t');

      const result = {
        isRepo: true,
        cwd: realCwd,
        repoRoot,
        gitCommonDir: commonDir || repoRoot,  // fallback to repoRoot if probe failed
        branch: status.branch,
        ahead: status.ahead,
        behind: status.behind,
        dirty: status.dirty,
        lastCommit: hash ? { hash, subject, when } : null,
      };
      cache.set(realCwd, { result, ts: Date.now() });
      return result;
    } finally {
      inflight.delete(realCwd);
    }
  })();
  inflight.set(realCwd, promise);
  return promise;
}

async function listWorktrees(cwd) {
  try {
    const text = await _runGit(cwd, ['worktree', 'list', '--porcelain']);
    if (!text) return [];
    return parseWorktreeList(text);
  } catch (_) {
    return [];
  }
}

module.exports = { parsePorcelain, parseWorktreeList, probeRepo, listWorktrees, _resetCacheForTest };
