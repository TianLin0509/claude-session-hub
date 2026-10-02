'use strict';
// Shared by the sidebar and assistant: runtime truth and attention are Hub-owned.
const {isGroupChatMemberRunning}=require('./groupchat-running-state');
const {sessionHasCompletedUnread}=require('./session-attention-state');
const {sessionRuntimeIssue}=require('./session-runtime-issue');
const {compareLatestActivityDesc,latestActivityTime}=require('./session-recency');
const {RUNTIME_WAITING,RUNTIME_DORMANT,RUNTIME_UNKNOWN,getSessionRuntimeTruth,sessionRuntimeIsActive}=require('./session-runtime-truth');
function getMeetingUnreadMemberIds(meeting, sessions = new Map()) {
  return new Set((meeting?.subSessions || []).filter(sid =>
    (meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.has(sid)) || sessionHasCompletedUnread(sessions.get(sid))));
}

function isPinnedToBottom(item) {
  return !!(item && item.bottomed && !item.pinned);
}

function compareSidebarPlacement(left, right) {
  const leftPinned = !!(left && left.pinned);
  const rightPinned = !!(right && right.pinned);
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1;
  const leftBottomed = isPinnedToBottom(left);
  const rightBottomed = isPinnedToBottom(right);
  if (leftBottomed !== rightBottomed) return leftBottomed ? 1 : -1;
  return compareLatestActivityDesc(left, right);
}

function sidebarItemHasUnread(item, sessionMap) {
  if (!item._isMeeting) return sessionHasCompletedUnread(item);
  return getMeetingUnreadMemberIds(item._meeting, sessionMap).size > 0 || item.unreadAnsweredSize > 0;
}

function isSidebarMemberWorking(session, now = Date.now()) {
  return getSessionRuntimeTruth(session, { now }).state !== RUNTIME_WAITING
    && (sessionRuntimeIsActive(session, { now }) || isGroupChatMemberRunning(session, now));
}

function partitionSidebarSessions(items, { now = Date.now(), sessionMap = new Map(), activeSessionId = null, activeMeetingId = null, groupMemberIds = new Set() } = {}) {
  const pinned = [], respond = [], failed = [], running = [], completed = [], today = [], archive = [], older = [];
  const states = new Map();
  for (const s of [...(items || [])].sort(compareSidebarPlacement)) {
    const truth = s._isMeeting ? null : getSessionRuntimeTruth(s, { now });
    const meeting = s._isMeeting ? _meetingRuntimeAggregate(s._meeting, sessionMap, now) : null;
    const dormant = s._isMeeting ? s.status === 'dormant' : truth.state === RUNTIME_DORMANT;
    const fresh = now - latestActivityTime(s, now) < 86400000;
    const waiting = meeting ? meeting.waiting : truth.state === RUNTIME_WAITING;
    const error = meeting ? meeting.failed : !!sessionRuntimeIssue(s, truth);
    const working = s._resumePending || (meeting ? meeting.running
      : (s.meetingId || groupMemberIds.has(s.id)) ? isSidebarMemberWorking(s, now) : sessionRuntimeIsActive(s, { now }));
    const unread = sidebarItemHasUnread(s, sessionMap);
    states.set(s.id, error ? 'error' : meeting && working ? 'run' : waiting ? 'wait' : working ? 'run' : unread ? 'unread' : dormant ? 'dorm' : truth?.state === RUNTIME_UNKNOWN ? 'unknown' : 'idle');
    if (error) failed.push(s);
    else if (s.pinned && (waiting || working)) (waiting ? respond : running).push(s);
    else if (unread) completed.push(s);
    else if (waiting) respond.push(s);
    else if (working) running.push(s);
    else if (s.pinned) pinned.push(s);
    else if (dormant) archive.push(s);
    else if (fresh) today.push(s);
    else older.push(s);
  }
  return { pinned, unread: completed, failed, active: [...respond, ...running], today, archive, older, archiveCount: archive.length, states };
}

function _meetingRuntimeAggregate(meeting, sessionMap, now = Date.now()) {
  const truths = ((meeting && meeting.subSessions) || [])
    .map(id => sessionMap.get(id))
    .filter(Boolean)
    .map(session => ({ session, truth: getSessionRuntimeTruth(session, { now }) }));
  return {
    waiting: truths.some(item => item.truth.state === RUNTIME_WAITING),
    running: meeting && !meeting.groupChat && meeting.status === 'running'
      || truths.some(item => isSidebarMemberWorking(item.session, now)),
    disconnected: truths.some(item => sessionRuntimeIssue(item.session, item.truth)?.label === '连接异常'),
    failed: truths.some(item => !!sessionRuntimeIssue(item.session, item.truth)),
    truths,
  };
}


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


module.exports={getMeetingUnreadMemberIds,compareSidebarPlacement,isPinnedToBottom,sidebarItemHasUnread,isSidebarMemberWorking,partitionSidebarSessions,_meetingRuntimeAggregate,buildSidebarView};
