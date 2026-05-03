'use strict';

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
      if (cur) cur.branch = line.slice('branch refs/heads/'.length);
    } else if (line === 'detached') {
      if (cur) cur.branch = null;
    } else if (line === '' && cur) {
      out.push(cur); cur = null;
    }
  }
  if (cur) out.push(cur);
  return out;
}

module.exports = { parsePorcelain, parseWorktreeList };
