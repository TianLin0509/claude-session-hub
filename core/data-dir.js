const path = require('path');
const os = require('os');

// Resolve the Hub's data directory root.
// Honors CLAUDE_HUB_DATA_DIR env var so parallel test instances can isolate
// state.json / mobile-devices / images without touching the production Hub.
// Default: ~/.claude-session-hub (unchanged production path).
function getHubDataDir() {
  const override = process.env.CLAUDE_HUB_DATA_DIR;
  if (override && override.trim()) return override;
  return path.join(os.homedir(), '.claude-session-hub');
}

// 阶段乙（2026-05-03 道雪）：判定当前 hub 是否运行在隔离模式。
//   隔离 hub 测试时不希望 sub session 的 cwd 落在用户 home（~），
//   否则归档（.arena/sessions/）会污染生产用户的真实档案目录。
//   隔离模式下 sub cwd 走 <HUB_DATA_DIR>/workspaces/<meetingId>/，归档
//   也自然落到隔离路径下，跟生产数据完全隔开。
function isIsolatedHub() {
  return !!(process.env.CLAUDE_HUB_DATA_DIR && process.env.CLAUDE_HUB_DATA_DIR.trim());
}

function getMeetingWorkspaceDir(meetingId) {
  return path.join(getHubDataDir(), 'workspaces', meetingId);
}

// Phase 2 P0（2026-05-07）：scene 级 memory 共享根
// 原 fallback 用 getMeetingWorkspaceDir(meetingId)→ 每 meeting 一份，导致
// "AI 越来越懂我"产品愿景失效（用户每开新圆桌 AI 从 0 开始）。
// scene 级共享根让同 scene 跨 meeting 自然共享 _profile.md / 个体 .md / inbox。
function getSceneMemoryRoot(scene) {
  return path.join(getHubDataDir(), 'memory-scenes', String(scene || 'general'));
}

// 判定 cwd 是否用户主动设的真实项目目录（vs hub 自动分配的 fallback workspace）。
// 如果 cwd 落在 <hubData>/workspaces/ 下，是隔离 hub / 无 pilot 时自动给的临时目录，
// 应改用 scene 级共享根。否则 cwd 是用户真实项目（生产 hub 主驾指向真实代码仓库），
// 沿用该 cwd → 同一项目跨 meeting 自然共享 memory（per-project 共享）。
function isUserProjectCwd(cwd) {
  if (!cwd || typeof cwd !== 'string') return false;
  try {
    const norm = path.resolve(cwd).toLowerCase();
    const wsRoot = path.resolve(path.join(getHubDataDir(), 'workspaces')).toLowerCase();
    return !norm.startsWith(wsRoot);
  } catch (e) {
    // 不静默：path.resolve 抛错时降级为 false 会让用户真实项目 memory 混入 scene 共享根（数据污染风险）
    console.warn('[data-dir] isUserProjectCwd resolve failed, fallback to false:', cwd, e.message);
    return false;
  }
}

module.exports = {
  getHubDataDir,
  isIsolatedHub,
  getMeetingWorkspaceDir,
  getSceneMemoryRoot,
  isUserProjectCwd,
};
