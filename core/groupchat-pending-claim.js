'use strict';

// 群聊「本地 pending 提问」什么时候可以撤掉。
//
// 背景：用户在群聊里按下发送后，渲染层立刻画一条本地气泡（不等服务端），等服务端把
// 这条消息写进权威历史再撤掉本地那条。判断「服务端已经接手了」的判据必须按**身份**，
// 不能按轮号顺序。
//
// 2026-09-07 血泪：原判据是「历史里存在轮号大于 pendingUser.afterTurn 的 user 消息」。
// 首次打开房间时还没有面板缓存，afterTurn 只能算成 0，于是昨天第 7 轮的老提问一被读回来
// 就满足「7 > 0」，把用户刚发出、还没落盘的那条卡片凭空抹掉。轮号是顺序不是身份。
//
// 放在 core/ 而不是塞在 meeting-room.js 里，是为了能单测 —— meeting-room.js 是个
// 只在浏览器环境跑的大 IIFE，里面的东西测不到（同 core/session-view-mode.js 的理由）。

// 服务端写盘与本机时钟抖动的余量。
const PENDING_CLAIM_SKEW_MS = 5000;

function pendingIdentityKey(text) {
  return String(text == null ? '' : text).trim();
}

/**
 * 一条权威 user 消息能不能认领这条本地 pending。
 *
 * 两个条件缺一不可：
 *   内容一致 —— 服务端存的就是发出去的原文，两边都 trim 再比。
 *   时间不早于按下发送那一刻 —— 只比内容的话，「继续」这种口头禅在历史里出现过一次，
 *     今天再发一次就会被那条老的认领掉，等于换个花样重演同一个 bug。
 */
function authoritativeUserMessageClaims(message, pendingUser) {
  if (!message || !pendingUser) return false;
  if (message.role !== 'user') return false;
  if (pendingIdentityKey(message.content) !== pendingIdentityKey(pendingUser.content)) return false;
  const createdAt = Number(message.createdAt);
  // 没有可信时间戳就不认领：宁可让气泡多留到本轮结束被正常清掉，也不能让它凭空消失。
  if (!Number.isFinite(createdAt) || createdAt <= 0) return false;
  return createdAt >= (Number(pendingUser.createdAt) || 0) - PENDING_CLAIM_SKEW_MS;
}

/**
 * 返回**还需要本地渲染**的 pending 列表（已被权威历史接手的不再返回）。
 *
 * 一条权威消息只能认领一条 pending：连发两遍同样的话，就得等两条权威消息分别落盘，
 * 否则第一条会把两条本地气泡一起抹掉。
 */
function unclaimedPendingUserMessages(messages, pendings) {
  const pendingList = Array.isArray(pendings) ? pendings : [];
  if (!pendingList.length) return [];
  const authoritativeUsers = (Array.isArray(messages) ? messages : [])
    .filter(message => message && message.role === 'user');
  const claimedIndexes = new Set();
  const unclaimed = [];
  for (const pendingUser of pendingList) {
    const claimIndex = authoritativeUsers.findIndex((message, index) =>
      !claimedIndexes.has(index) && authoritativeUserMessageClaims(message, pendingUser));
    if (claimIndex >= 0) claimedIndexes.add(claimIndex);
    else unclaimed.push(pendingUser);
  }
  return unclaimed;
}

module.exports = {
  PENDING_CLAIM_SKEW_MS,
  authoritativeUserMessageClaims,
  pendingIdentityKey,
  unclaimedPendingUserMessages,
};
