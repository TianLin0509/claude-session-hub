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
//   隔离 hub 测试时不希望 sub session 的 cwd 落在用户 home（C:\Users\lintian），
//   否则归档（.arena/sessions/）会污染生产用户的真实档案目录。
//   隔离模式下 sub cwd 走 <HUB_DATA_DIR>/workspaces/<meetingId>/，归档
//   也自然落到隔离路径下，跟生产数据完全隔开。
function isIsolatedHub() {
  return !!(process.env.CLAUDE_HUB_DATA_DIR && process.env.CLAUDE_HUB_DATA_DIR.trim());
}

function getMeetingWorkspaceDir(meetingId) {
  return path.join(getHubDataDir(), 'workspaces', meetingId);
}

module.exports = { getHubDataDir, isIsolatedHub, getMeetingWorkspaceDir };
