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
  claudeProjectRoots,
  extractCwdFromTranscript,
  findTranscriptByCCSessionId,
  healPersistedCwds,
};
