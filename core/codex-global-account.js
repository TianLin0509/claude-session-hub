'use strict';
const path = require('path');
const os = require('os');
const {expandHomePath} = require('./codex-usage-scope');

function currentConfig() {
  const hub=require('./hub-config');
  // Another Hub can update the choice while this process keeps an older config
  // cache. Read only the account routing fields at launch/send/resume boundaries.
  // Corrupt/unreadable config must block routing, never silently select default.
  const raw=hub.readConfigJsonForUpdate();
  const codex=raw.providers?.codex || {};
  const routing={
    codexSubscriptionProfile:process.env.HUB_CODEX_PROFILE || codex.subscription_profile || hub.DEFAULTS.codex_subscription_profile,
    codexSubscriptionProfiles:hub.normalizeCodexSubscriptionProfiles(codex.subscription_profiles)};
  const cached=hub.getConfig();
  if (cached.codexSubscriptionProfile!==routing.codexSubscriptionProfile
      || JSON.stringify(cached.codexSubscriptionProfiles)!==JSON.stringify(routing.codexSubscriptionProfiles)) hub.clearConfigCache();
  return {...hub.getConfig(),...routing};
}

function resolveAccount(config, env = process.env) {
  const id = config.codexSubscriptionProfile;
  const profile = config.codexSubscriptionProfiles.find(p => p.id === id);
  if (!profile) throw new Error('全局 Codex 账号不存在，请在账号中心重新选择');
  const home = path.resolve(expandHomePath(profile.home) || (env.CLAUDE_HUB_DATA_DIR && env.CODEX_HOME) || path.join(os.homedir(), '.codex'));
  if (env.CLAUDE_HUB_DATA_DIR) {
    const relative = path.relative(path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR)), home);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('选定 Codex 账号不在隔离目录内，未启动或切换');
  }
  return {id, label:profile.label, home};
}

function withGlobalAccount(existing, config, id, env = process.env) {
  if (typeof id !== 'string' || !config.codexSubscriptionProfiles.some(p => p.id === id)) throw new Error('Codex 账号配置不存在');
  if (env.HUB_CODEX_PROFILE && env.HUB_CODEX_PROFILE !== id) throw new Error('HUB_CODEX_PROFILE 环境变量固定了账号，请移除后切换');
  if (config.codexBackend === 'api') throw new Error('当前使用 Codex API，不能切换订阅账号');
  resolveAccount({...config,codexSubscriptionProfile:id},env);
  return {...existing,providers:{...existing.providers,codex:{...existing.providers?.codex,subscription_profile:id}}};
}

// History and writer ownership stay with their original home. Only credentials,
// native config and future new threads follow the selected global account.
function prepareLaunch(opts, config, env = process.env) {
  const account = resolveAccount(config,env);
  const oldProfile = config.codexSubscriptionProfiles.find(p => p.id === opts.codexProfile);
  const sid = opts.codexSid || opts.codexForkSid;
  if (opts.codexProfile && !oldProfile && !(sid && opts.codexSessionsRoot)) throw new Error('Codex 账号配置不存在');
  const historyHome = !sid ? account.home : opts.codexSessionsRoot ? path.dirname(opts.codexSessionsRoot)
    : oldProfile ? path.resolve(expandHomePath(oldProfile.home) || (env.CLAUDE_HUB_DATA_DIR && env.CODEX_HOME) || path.join(os.homedir(),'.codex')) : account.home;
  if (env.CLAUDE_HUB_DATA_DIR) {
    const root=path.dirname(path.resolve(env.CLAUDE_HUB_DATA_DIR));
    for (const candidate of [historyHome,opts.resumeTranscriptPath].filter(Boolean)) {
      const relative=path.relative(root,candidate);
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('旧 Codex 历史不在隔离目录内，未恢复');
    }
  }
  let resumePath = opts.resumeTranscriptPath;
  if (sid && !resumePath) resumePath = require('./codex-transcript-parser').findCodexRolloutBySid(sid,path.join(historyHome,'sessions'));
  if (sid && !resumePath && path.toNamespacedPath(historyHome).toLowerCase() !== path.toNamespacedPath(account.home).toLowerCase()) {
    throw new Error('未找到旧 Codex 会话的原始历史，无法换账号恢复；未新建替代会话');
  }
  return {account,opts:{...opts,codexProfile:account.id,resumeTranscriptPath:resumePath,
    codexHistoryHome:opts.codexSid ? historyHome : account.home,
    codexSessionsRoot:opts.codexSid ? path.join(historyHome,'sessions') : path.join(account.home,'sessions')}};
}
module.exports = {resolveAccount,withGlobalAccount,prepareLaunch,currentConfig};
