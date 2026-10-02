'use strict';
const { latestActivityTime, compareLatestActivityDesc } = require('../core/session-recency');

// Presentation policy only; runtime truth and unread accounting remain owned
// by the existing classifier. Attention flags promote rows, not sections.
function buildSidebarView(parts, { now = Date.now(), days = 1, sessionMap = new Map(), hasUnread = () => false } = {}) {
  const items = [...new Map(['failed', 'active', 'pinned', 'unread', 'today', 'archive', 'older']
    .flatMap(key => parts[key] || []).map(item => [item.id, item])).values()];
  const failed = [], active = [], today = [], archive = [];
  const compare = (a, b) => {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    if (!!a.bottomed !== !!b.bottomed) return a.bottomed ? 1 : -1;
    if (!!hasUnread(a, sessionMap) !== !!hasUnread(b, sessionMap)) return hasUnread(a, sessionMap) ? -1 : 1;
    return compareLatestActivityDesc(a, b);
  };
  for (const item of items) {
    const state = parts.states.get(item.id);
    if (state === 'error') failed.push(item);
    else if (state === 'run' || state === 'wait') active.push(item);
    else if (item.pinned || hasUnread(item, sessionMap) || now - latestActivityTime(item, now) < (days === 3 ? 3 : 1) * 86400000) today.push(item);
    else archive.push(item);
  }
  failed.sort(compare);
  active.sort((a, b) => {
    const waiting = (parts.states.get(a.id) === 'wait' ? 0 : 1) - (parts.states.get(b.id) === 'wait' ? 0 : 1);
    return waiting || compare(a, b);
  });
  today.sort(compare);
  archive.sort(compareLatestActivityDesc);
  return { ...parts, failed, active, today, archive, archiveCount: archive.length };
}

module.exports = { buildSidebarView };
