'use strict';

const path = require('path');

function isPathInside(parent, candidate) {
  if (!parent || !candidate) return false;
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function evaluateAgentLeagueSchedulerSafety(options = {}) {
  const env = options.env || process.env;
  const leagueRoot = path.resolve(String(options.leagueRoot || ''));
  const isolatedDataDir = String(env.CLAUDE_HUB_DATA_DIR || '').trim();
  const explicitlyAllowed = String(env.CHUXIN_AGENT_LEAGUE_ALLOW_EXTERNAL_SCHEDULER || '') === '1';

  if (!isolatedDataDir) {
    return {
      allowed: true,
      reason: 'production-hub',
      isolated: false,
      leagueRoot,
      dataDir: '',
      explicitlyAllowed: false,
    };
  }

  const dataDir = path.resolve(isolatedDataDir);
  if (isPathInside(dataDir, leagueRoot)) {
    return {
      allowed: true,
      reason: 'isolated-vault-contained',
      isolated: true,
      leagueRoot,
      dataDir,
      explicitlyAllowed: false,
    };
  }

  if (explicitlyAllowed) {
    return {
      allowed: true,
      reason: 'isolated-external-vault-explicitly-allowed',
      isolated: true,
      leagueRoot,
      dataDir,
      explicitlyAllowed: true,
    };
  }

  return {
    allowed: false,
    reason: 'isolated-external-vault-blocked',
    isolated: true,
    leagueRoot,
    dataDir,
    explicitlyAllowed: false,
    message: '隔离 Hub 的联赛目录位于隔离数据目录之外；自动赛程已停用，手动操作仍可用。',
  };
}

module.exports = {
  evaluateAgentLeagueSchedulerSafety,
  isPathInside,
};
