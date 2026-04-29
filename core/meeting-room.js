const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    this._counter = 0;
  }

  createMeeting() {
    const id = uuid();
    const meeting = {
      id,
      type: 'meeting',
      title: `会议室-${++this._counter}`,
      subSessions: [],
      layout: 'focus',
      focusedSub: null,
      syncContext: false,
      sendTarget: 'all',
      createdAt: Date.now(),
      lastMessageTime: Date.now(),
      pinned: false,
      status: 'idle',
      lastScene: 'free_discussion',
      driverMode: false,
      driverSessionId: null,
      pendingReviewId: null,
      researchMode: false,
      covenantText: '',
      // 新增：通用圆桌（默认开启，与 driverMode/researchMode 互斥）
      roundtableMode: true,
      generalRoundtableCovenant: '',
    };
    // Hub Timeline phase 1 (in-memory only)
    meeting._timeline = [];
    meeting._cursors = {};
    meeting._nextIdx = 0;
    this.meetings.set(id, meeting);
    return { ...meeting };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? {
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
    } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
    }));
  }

  addSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (m.subSessions.includes(sessionId)) {
      // Already a member: idempotent, cursor preserved (regardless of capacity)
      return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
    }
    if (m.subSessions.length >= 3) return null;
    m.subSessions.push(sessionId);
    if (!(sessionId in m._cursors)) {
      m._cursors[sessionId] = 0; // new join: see full history
    }
    m.lastMessageTime = Date.now();
    // T11 fix: persist cursor change so membership/cursors survive restart.
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
  }

  removeSubSession(meetingId, sessionId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.subSessions = m.subSessions.filter(id => id !== sessionId);
    delete m._cursors[sessionId];
    if (m.focusedSub === sessionId) m.focusedSub = m.subSessions[0] || null;
    if (m.sendTarget === sessionId) m.sendTarget = 'all';
    // T11 fix: persist cursor removal so stale cursors don't reappear after restart.
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return { ...m, subSessions: [...m.subSessions], _timeline: [...m._timeline], _cursors: { ...m._cursors } };
  }

  updateMeeting(meetingId, fields) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    // Loud-fail on ambiguous mode input: callers must set at most one mode to true at a time.
    // Without this guard, the three sequential mutex if-blocks below would silently zero out
    // ALL mode flags when 2+ modes are set true together, leaving the meeting in undefined state.
    const trueCount = ['roundtableMode', 'researchMode', 'driverMode']
      .filter(k => fields[k] === true).length;
    if (trueCount > 1) {
      throw new Error(`Cannot set multiple modes to true simultaneously: ${JSON.stringify({
        roundtableMode: fields.roundtableMode,
        researchMode: fields.researchMode,
        driverMode: fields.driverMode,
      })}`);
    }
    const allowed = [
      'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned',
      'lastMessageTime', 'status', 'lastScene', 'driverMode', 'driverSessionId',
      'pendingReviewId', 'researchMode', 'covenantText',
      // 新增字段
      'roundtableMode', 'generalRoundtableCovenant',
    ];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
    }
    // 三态互斥：开启某一个时关掉其他两个
    if (fields.roundtableMode === true) {
      m.researchMode = false;
      m.driverMode = false;
    }
    if (fields.researchMode === true) {
      m.roundtableMode = false;
      m.driverMode = false;
    }
    if (fields.driverMode === true) {
      m.roundtableMode = false;
      m.researchMode = false;
    }
    return { ...m, subSessions: [...m.subSessions] };
  }

  closeMeeting(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    const subIds = [...m.subSessions];
    this.meetings.delete(meetingId);
    // T12 fix: cancel any pending dirty flush before deleting file,
    // otherwise the 5s timer would resurrect the deleted file as a "ghost"
    meetingStore.cancelDirty(meetingId);
    meetingStore.deleteMeetingFile(meetingId);
    return subIds;
  }

  restoreMeeting(meetingData) {
    if (!meetingData || !meetingData.id) return;
    this.meetings.set(meetingData.id, {
      ...meetingData,
      status: 'dormant',
      subSessions: meetingData.subSessions || [],
      driverMode: meetingData.driverMode || false,
      driverSessionId: meetingData.driverSessionId || null,
      pendingReviewId: meetingData.pendingReviewId || null,
      researchMode: meetingData.researchMode || false,
      covenantText: meetingData.covenantText || '',
      // 通用圆桌新字段：旧会议 persisted 时无此字段，显式 default false 保持原 UX
      // （createMeeting 默认建新会议为 roundtableMode=true，但旧会议升级后不切换）
      roundtableMode: meetingData.roundtableMode === true,
      generalRoundtableCovenant: meetingData.generalRoundtableCovenant || '',
      _timeline: [],
      _cursors: {},
      _nextIdx: 0,
    });
    const num = parseInt((meetingData.title || '').replace(/\D/g, ''), 10);
    if (num && num >= this._counter) this._counter = num;
  }

  loadTimelineLazy(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return false;
    // Already loaded?
    if (m._timeline.length > 0 || m._nextIdx > 0) return true;
    const data = meetingStore.loadMeetingFile(meetingId);
    if (!data) return false;
    m._timeline = Array.isArray(data._timeline) ? data._timeline : [];
    m._cursors = (data._cursors && typeof data._cursors === 'object') ? data._cursors : {};
    m._nextIdx = typeof data._nextIdx === 'number' ? data._nextIdx : m._timeline.length;
    return true;
  }

  appendTurn(meetingId, sid, text, ts) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (typeof text !== 'string' || !text) return null;

    // Cap at 100KB to prevent OOM from runaway AI output
    const MAX = 100 * 1024;
    let safeText = text;
    if (safeText.length > MAX) {
      safeText = safeText.slice(0, MAX) + '...[truncated]';
    }

    // Dedupe: same sid+text within 2s = duplicate event from tap
    const lastTurn = m._timeline[m._timeline.length - 1];
    if (lastTurn && lastTurn.sid === sid && lastTurn.text === safeText
        && (ts - lastTurn.ts) < 2000) {
      return null;
    }

    const resolvedTs = ts != null ? ts : Date.now();
    const turn = { idx: m._nextIdx++, sid, text: safeText, ts: resolvedTs };
    m._timeline.push(turn);
    m.lastMessageTime = resolvedTs;
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return { ...turn };
  }

  getTimeline(meetingId) {
    const m = this.meetings.get(meetingId);
    if (!m) return [];
    return m._timeline.map(t => ({ ...t }));
  }

  getCursor(meetingId, sid) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (!(sid in m._cursors)) return null;
    return m._cursors[sid];
  }

  advanceCursor(meetingId, sid, newPos) {
    const m = this.meetings.get(meetingId);
    if (!m) return false;
    if (!(sid in m._cursors)) return false;
    if (newPos < m._cursors[sid]) return false; // monotonic
    if (newPos > m._timeline.length) newPos = m._timeline.length;
    m._cursors[sid] = newPos;
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return true;
  }

  incrementalContext(meetingId, targetSid) {
    const m = this.meetings.get(meetingId);
    if (!m || !(targetSid in m._cursors)) {
      return { turns: [], advancedTo: 0 };
    }
    const fromIdx = m._cursors[targetSid];
    const newTurns = m._timeline
      .slice(fromIdx)
      // 'user' is a reserved literal sid; hubSessionIds are UUIDs — no collision
      // possible, so filtering on sid !== targetSid correctly excludes only the
      // target's own AI turns and never accidentally drops user turns.
      .filter(t => t.sid !== targetSid)
      .map(t => ({ ...t }));
    m._cursors[targetSid] = m._timeline.length;
    meetingStore.markDirty(meetingId, { _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx });
    return { turns: newTurns, advancedTo: m._cursors[targetSid] };
  }
}

function isRoundtableCapableMeeting(meeting) {
  return !!(meeting && (meeting.researchMode || meeting.roundtableMode));
}

module.exports = { MeetingRoomManager, isRoundtableCapableMeeting };
