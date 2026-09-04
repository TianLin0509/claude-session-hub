'use strict';

// 关窗后台守护的判据（2026-09-04）。
//
// 背景：v1.6.28 引入「自动赛程开着就关窗留守托盘」时，判据只问了本进程自己：
//   赛程 enabled 吗？keepAliveOnClose 开着吗？—— 两个都是**全局共享状态**，
//   所以每一个 Hub 关窗都会得到同一个 yes，于是每关一次窗就多一个隐身 Hub。
//   实测 2026-09-03 桌面同时留守 6 个托盘 Hub、8 个实例共 15.4GB。
//
// v1.6.47 的调度主控选举只解决了「谁有资格跑联赛」，没有解决「谁留下」：
//   一个被判 standby、永远不会执行赛程的旧 Hub，照样满足上面两个条件而留守，
//   变成一个保证无用的守护进程，还攥着它名下 Codex 的 thread writer 锁不放。
//
// 新判据一句话：**只有会真正执行赛程的那一个 Hub 才留守。**
// 语义是「至少留一个、绝不留两个」，所以每一条判不清的路径都倒向留守 ——
// 少留一个只是多占内存，少留到零就是第二天 08:30 没人跑决策。

const KEEP = {
  ACTIVE_RUN: 'active-run',
  SELF_PREFERRED: 'self-preferred',
  ELECTION_UNAVAILABLE: 'election-unavailable',
  PREFERRED_UNKNOWN: 'preferred-unknown',
  PREFERRED_GONE: 'preferred-gone',
};

const DROP = {
  EXPLICIT_QUIT: 'explicit-quit',
  DISABLED_BY_ENV: 'disabled-by-env',
  KEEPALIVE_OFF: 'keepalive-off',
  NO_SCHEDULE: 'no-schedule',
  PREFERRED_ELSEWHERE: 'preferred-elsewhere',
};

function defaultIsProcessAlive(pid) {
  const target = Number(pid);
  if (!Number.isFinite(target) || target <= 0) return false;
  try {
    process.kill(target, 0);
    return true;
  } catch (error) {
    // EPERM = 进程在，只是不归我管；那也算活着。只有 ESRCH 才是真没了。
    return !!error && error.code === 'EPERM';
  }
}

/**
 * @param {object} input
 * @param {boolean} [input.explicitQuitRequested] 用户从托盘菜单显式退出
 * @param {boolean} [input.disabledByEnv]         CLAUDE_HUB_DISABLE_LEAGUE_BACKGROUND=1
 * @param {object}  [input.schedule]              store.getSchedule()
 * @param {object}  [input.activeRun]             getRunState()，本 Hub 正在跑的赛程
 * @param {object}  [input.election]              refreshSchedulerElection() 的返回值
 * @param {number}  [input.selfPid]
 * @param {(pid:number)=>boolean} [input.isProcessAlive]
 * @returns {{keep: boolean, reason: string, preferredPid: number|null}}
 */
function decideLeagueKeepalive(input = {}) {
  const selfPid = Number(input.selfPid) || process.pid;
  const isAlive = typeof input.isProcessAlive === 'function' ? input.isProcessAlive : defaultIsProcessAlive;
  const verdict = (keep, reason, preferredPid = null) => ({ keep, reason, preferredPid });

  if (input.explicitQuitRequested) return verdict(false, DROP.EXPLICIT_QUIT);
  if (input.disabledByEnv) return verdict(false, DROP.DISABLED_BY_ENV);

  const schedule = input.schedule || {};
  const activeRun = input.activeRun || null;
  if (schedule.keepAliveOnClose === false) return verdict(false, DROP.KEEPALIVE_OFF);
  if (schedule.enabled !== true && !activeRun) return verdict(false, DROP.NO_SCHEDULE);

  // 手里有在跑的赛程就绝不退：选举结果如何都不重要，这一轮的检查点在本进程。
  if (activeRun) return verdict(true, KEEP.ACTIVE_RUN);

  const election = input.election;
  // 选举关闭 / 不可用 / 报错 —— 判不了就留守，宁可多占内存也不能让赛程没人跑。
  if (!election || election.enabled === false || election.available === false) {
    return verdict(true, KEEP.ELECTION_UNAVAILABLE);
  }
  if (election.isPreferred === true) return verdict(true, KEEP.SELF_PREFERRED);

  const preferredPid = Number(election.preferred && election.preferred.pid) || 0;
  // 还没有任何主控记录（例如刚迁移完、TTL 刚过期），同样按兜底留守。
  if (!preferredPid) return verdict(true, KEEP.PREFERRED_UNKNOWN);
  if (preferredPid === selfPid) return verdict(true, KEEP.SELF_PREFERRED, preferredPid);
  // 记录指向别人，但那个进程已经不在了 —— 记录是陈的，我留守。
  if (!isAlive(preferredPid)) return verdict(true, KEEP.PREFERRED_GONE, preferredPid);

  // 唯一会真正退出的分支：另一个活着的 Hub 才是调度主控，我留下也执行不了赛程。
  return verdict(false, DROP.PREFERRED_ELSEWHERE, preferredPid);
}

module.exports = {
  decideLeagueKeepalive,
  defaultIsProcessAlive,
  KEEP_REASONS: KEEP,
  DROP_REASONS: DROP,
};
