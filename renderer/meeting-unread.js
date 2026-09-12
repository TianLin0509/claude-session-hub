'use strict';

const { sessionHasCompletedUnread, clearSessionCompletedUnread } = require('../core/session-attention-state');

// Attention belongs to this renderer window. Never infer it from running/idle,
// selected rows or round progress: those can all change before a reply is read.
function getMeetingUnreadMemberIds(meeting, sessions = new Map()) {
  return new Set((meeting?.subSessions || []).filter(sid =>
    (meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.has(sid)) || sessionHasCompletedUnread(sessions.get(sid))));
}

function recordMeetingAnswer(meeting, payload, { seenByUser = false } = {}) {
  const { sid, status, turnNum, runId } = payload;
  if (!meeting?.subSessions?.includes(sid) || !['completed', 'manual_extracted'].includes(status)) return false;
  if (!(meeting.unreadAnswered instanceof Set)) meeting.unreadAnswered = new Set();
  if (!(meeting._answerCompletionKeys instanceof Map)) meeting._answerCompletionKeys = new Map();
  const round = JSON.stringify([runId || '', turnNum ?? null]);
  if (meeting._answeredRound !== round) {
    meeting.answeredThisTurn = new Set();
    meeting._answeredRound = round;
  }
  meeting.answeredThisTurn.add(sid);
  const key = JSON.stringify([round, payload.attemptId || '', payload.providerTurnId || '', status]);
  if (meeting._answerCompletionKeys.get(sid) === key) return false;
  meeting._answerCompletionKeys.set(sid, key);
  if (!seenByUser) meeting.unreadAnswered.add(sid);
  else meeting.unreadAnswered.delete(sid);
  return true;
}

function readMeetingMember(meeting, sid, sessions = new Map()) {
  if (!meeting?.subSessions?.includes(sid)) return { changed: false, sessionRead: false };
  const removed = meeting.unreadAnswered instanceof Set && meeting.unreadAnswered.delete(sid);
  const sessionRead = clearSessionCompletedUnread(sessions.get(sid));
  return { changed: removed || sessionRead, sessionRead };
}

function preserveMeetingAttention(previous, next) {
  if (!previous || !next) return;
  const valid = new Set(next.subSessions || []);
  for (const key of ['unreadAnswered', 'answeredThisTurn']) {
    if (previous[key] instanceof Set) next[key] = new Set([...previous[key]].filter(sid => valid.has(sid)));
  }
  if (previous._answerCompletionKeys instanceof Map) {
    next._answerCompletionKeys = new Map([...previous._answerCompletionKeys].filter(([sid]) => valid.has(sid)));
  }
  next._answeredRound = previous._answeredRound;
}

module.exports = { getMeetingUnreadMemberIds, recordMeetingAnswer, readMeetingMember, preserveMeetingAttention };
