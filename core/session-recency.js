'use strict';

function positiveTimestamp(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

/**
 * Sidebar recency means the latest completed AI reply, not the latest prompt
 * or terminal activity. `lastMessageTime` is retained only as the compatibility
 * fallback for sessions created before completion timestamps were persisted.
 */
function latestReplyTime(item, fallback = 0) {
  if (!item || typeof item !== 'object') return positiveTimestamp(fallback);
  return positiveTimestamp(item.lastCompletedAt)
    || positiveTimestamp(item.lastMessageTime)
    || positiveTimestamp(item.createdAt)
    || positiveTimestamp(fallback);
}

function compareLatestReplyDesc(left, right) {
  return latestReplyTime(right) - latestReplyTime(left)
    || positiveTimestamp(right && right.createdAt) - positiveTimestamp(left && left.createdAt);
}

module.exports = {
  compareLatestReplyDesc,
  latestReplyTime,
  positiveTimestamp,
};
