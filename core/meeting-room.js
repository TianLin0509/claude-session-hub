const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');

// 模式 → 房名前缀。前端 +号菜单点击两模式入口时透传 mode,createMeeting 据此生成
// 自带语义的房名(每模式独立计数,后期允许用户重命名)。未传 mode 时默认 'general' 走
// 通用圆桌路径,保持向后兼容(老调用 createMeeting() 不会炸)。
const MODE_TITLE_PREFIX = {
  general: '通用圆桌',
  research: '投研圆桌',
};

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    // 两模式独立计数,跨模式不共享
    this._counters = { general: 0, research: 0 };
  }

  createMeeting(opts = {}) {
    const id = uuid();
    const mode = MODE_TITLE_PREFIX[opts.mode] ? opts.mode : 'general';
    const titlePrefix = MODE_TITLE_PREFIX[mode];
    const seq = ++this._counters[mode];
    const meeting = {
      id,
      type: 'meeting',
      title: `${titlePrefix} #${seq}`,
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
      researchMode: mode === 'research',
      covenantText: '',
      // 两态互斥:researchMode 时 roundtableMode=false,只有 general 默认开
      roundtableMode: mode === 'general',
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
    // Without this guard, the two sequential mutex if-blocks below would silently zero out
    // ALL mode flags when both modes are set true together, leaving the meeting in undefined state.
    const trueCount = ['roundtableMode', 'researchMode']
      .filter(k => fields[k] === true).length;
    if (trueCount > 1) {
      throw new Error(`Cannot set multiple modes to true simultaneously: ${JSON.stringify({
        roundtableMode: fields.roundtableMode,
        researchMode: fields.researchMode,
      })}`);
    }
    const allowed = [
      'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned',
      'lastMessageTime', 'status', 'lastScene', 'researchMode', 'covenantText',
      'roundtableMode', 'generalRoundtableCovenant',
    ];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
    }
    // 两态互斥：开启某一个时关掉另一个
    if (fields.roundtableMode === true) {
      m.researchMode = false;
    }
    if (fields.researchMode === true) {
      m.roundtableMode = false;
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
    // 白名单展开,显式不保留 driver* / pendingReviewId 等已废弃字段。
    // 老 driverMode meeting 自动降级为通用圆桌(roundtableMode=true),用户可以继续看历史 timeline,
    // 新建会议才走 createMeeting 的默认 'general' 路径。
    const isResearch = !!meetingData.researchMode;
    const isRoundtable = meetingData.roundtableMode === true;
    // 兜底:老 driverMode meeting 既不 research 也不 roundtable,自动降级为通用圆桌
    // 否则 isRoundtableCapableMeeting 会拒绝它,用户连历史都看不到
    const fallbackToRoundtable = !isResearch && !isRoundtable;
    this.meetings.set(meetingData.id, {
      id: meetingData.id,
      type: 'meeting',
      title: meetingData.title || '会议室',
      subSessions: meetingData.subSessions || [],
      layout: meetingData.layout || 'focus',
      focusedSub: meetingData.focusedSub || null,
      syncContext: !!meetingData.syncContext,
      sendTarget: meetingData.sendTarget || 'all',
      createdAt: meetingData.createdAt || Date.now(),
      lastMessageTime: meetingData.lastMessageTime || Date.now(),
      pinned: !!meetingData.pinned,
      status: 'dormant',
      lastScene: meetingData.lastScene || 'free_discussion',
      researchMode: isResearch,
      covenantText: meetingData.covenantText || '',
      roundtableMode: isRoundtable || fallbackToRoundtable,
      generalRoundtableCovenant: meetingData.generalRoundtableCovenant || '',
      _timeline: [],
      _cursors: {},
      _nextIdx: 0,
    });
    // 按 mode flag + title 末尾 #N 数字推断恢复到哪个 counter,避免新建撞号。
    // 老格式 "会议室-N" / "主驾会议 #N" 不匹配新规则,跳过。
    let restoredMode = null;
    if (isResearch) restoredMode = 'research';
    else if (isRoundtable) restoredMode = 'general';
    const seqMatch = (meetingData.title || '').match(/#(\d+)\s*$/);
    const seq = seqMatch ? parseInt(seqMatch[1], 10) : 0;
    if (restoredMode && seq > 0 && seq > this._counters[restoredMode]) {
      this._counters[restoredMode] = seq;
    }
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
