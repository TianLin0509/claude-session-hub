'use strict';
const { probeRepo, listWorktrees } = require('./git-probe');
const { classify } = require('./conflict-detector');

/**
 * 收集 active session 与同 repo peers 的 git 状态，返回面板数据。
 *
 * @param {object} args
 * @param {string} args.activeSessionId
 * @param {Array<{sessionId, cwd}>} args.allSessions  当前所有活跃 session
 * @param {boolean} [args.force]                       透传给 probeRepo
 * @returns {Promise<object>} panel data
 */
async function getPanelData({ activeSessionId, allSessions, force = false }) {
  const active = allSessions.find(s => s.sessionId === activeSessionId);
  if (!active || !active.cwd) {
    return { active: null, peers: [], worktreeList: [], conflict: { color: 'green', reasons: [] } };
  }

  const activeProbe = await probeRepo(active.cwd, { force });
  const activeFull = { ...activeProbe, sessionId: active.sessionId, sessionLabel: active.sessionLabel };

  const otherSessions = allSessions.filter(s => s.sessionId !== activeSessionId && s.cwd);
  const peerProbes = await Promise.all(otherSessions.map(async s => {
    const p = await probeRepo(s.cwd, { force });
    return { ...p, sessionId: s.sessionId, sessionLabel: s.sessionLabel };
  }));
  const peers = peerProbes.filter(p => p.isRepo && p.repoRoot === activeFull.repoRoot);

  const worktreeList = activeFull.isRepo ? await listWorktrees(activeFull.repoRoot) : [];
  const conflict = classify(activeFull, peers);

  return { active: activeFull, peers, worktreeList, conflict };
}

module.exports = { getPanelData };
