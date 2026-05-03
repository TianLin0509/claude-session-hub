'use strict';
const path = require('path');

function _norm(p) {
  if (!p) return p;
  let n = p.replace(/\\/g, '/');
  if (process.platform === 'win32') n = n.toLowerCase();
  return n;
}

function classify(active, peers) {
  if (!active || !active.isRepo) return { color: 'green', reasons: ['非 git 目录'] };

  const reasons = [];
  let level = 'green';
  const activeCwd = _norm(active.cwd);
  const activeRoot = _norm(active.repoRoot);
  const activeDirtyPaths = new Set((active.dirty || []).map(d => _norm(d.path)));

  for (const p of peers) {
    if (!p || !p.isRepo) continue;
    const pCwd = _norm(p.cwd);
    const pRoot = _norm(p.repoRoot);
    const tag = p.sessionId || p.cwd;

    if (pCwd === activeCwd) {
      reasons.push(`同 cwd：${tag}`);
      level = 'red';
      continue;
    }
    if (pRoot === activeRoot) {
      const overlap = (p.dirty || [])
        .map(d => _norm(d.path))
        .filter(x => activeDirtyPaths.has(x));
      if (overlap.length > 0) {
        reasons.push(`改同文件 ${overlap.join(', ')}：${tag}`);
        level = 'red';
      } else if (level !== 'red') {
        reasons.push(`同 repo 邻居 worktree：${tag}`);
        level = 'yellow';
      }
    }
  }
  return { color: level, reasons };
}

module.exports = { classify, _norm };
