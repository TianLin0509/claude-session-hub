'use strict';

function positiveTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * 侧栏的「最近程度」= 这个会话最后一次真正有来往的时刻。
 *
 * 2026-08-27 反转了此前的口径。原来只认 lastCompletedAt（回答完成时刻），
 * 提问不算——本意是别让「只是打开看一眼」把老会话顶上来，还有测试专门锁着这条。
 * 但实测下来它带来更糟的结果：一轮还没答完的会话仍按**上一轮**的完成时间排，
 * 于是刚说完话的会话沉在列表下方，跨过 24 小时后甚至掉进「3 天内」分组。
 *
 * 实测证据（2026-08-27 01:18 的 state.json）：
 *   「Agent投资竞赛构想」 lastCompletedAt 22.6h 前、lastMessageTime 12 分钟前
 *                        → 侧栏按 22.6h 前排，而它此刻正在跑
 *   「PPT-Doctor工具审查与优化」 lastCompletedAt 4.8h 前、lastMessageTime 1.1h 前
 *
 * 现在取所有「有来往」时刻的最大值。这样刚聊过的会话必然浮到最上面。
 *
 * 为什么「只打开不说话」仍然不会上浮：选中会话不写这里的任何字段
 * （见 renderer.js 的 selectSession）；runStartedAt 只在用户**提交提问**时写
 * （见 core/session-attention-state.js 的 applyPromptSubmitted）。
 *
 * 有意不看终端原始输出时间戳：那会让任何刷屏的会话不停顶到最上面。
 */
const ACTIVITY_FIELDS = ['lastCompletedAt', 'lastMessageTime', 'runStartedAt', 'lastRunStartedAt', 'createdAt'];

function latestActivityTime(item, fallback = 0) {
  if (!item || typeof item !== 'object') return positiveTimestamp(fallback);
  let best = 0;
  for (const field of ACTIVITY_FIELDS) {
    const value = positiveTimestamp(item[field]);
    if (value > best) best = value;
  }
  return best || positiveTimestamp(fallback);
}

function compareLatestActivityDesc(left, right) {
  return latestActivityTime(right) - latestActivityTime(left)
    || positiveTimestamp(right && right.createdAt) - positiveTimestamp(left && left.createdAt);
}

module.exports = {
  ACTIVITY_FIELDS,
  compareLatestActivityDesc,
  latestActivityTime,
  positiveTimestamp,
  // 旧名保留为别名：这两个名字散落在侧栏、Ctrl+Tab、历史会话弹窗和 session-manager 里。
  // 语义已从「最后一次回答完成」扩成「最后一次有来往」，新代码请用 latestActivityTime。
  latestReplyTime: latestActivityTime,
  compareLatestReplyDesc: compareLatestActivityDesc,
};
