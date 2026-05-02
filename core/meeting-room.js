const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');

const MEETING_MODES = ['general', 'research'];

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
      scene: MEETING_MODES.includes(mode) ? mode : 'general',
      covenantText: '',
      // meeting-create-modal（2026-05-01）：用户在 Modal 选定的 slots 列表，
      //   形如 [{ index, kind, model }, ...]。subSessions 数组顺序与 slot index 同步，
      //   slotSpecs 保留 kind/model 是为了"再来一次"或诊断信息。
      slotSpecs: Array.isArray(opts.slotSpecs) ? opts.slotSpecs.slice() : null,
      // pilot redesign（2026-05-02）：
      //   pilotSlot ∈ {0,1,2,null}：主驾"角色"标识（红框 UI）。仅是身份标签，不切换全局模式。
      //   dispatchMode ∈ {'all','pilot','observer'}：本轮 prompt 谁开口。
      //     all       — 全员（默认）；
      //     pilot     — 仅主驾（pilotSlot 必须 !== null）；
      //     observer  — 仅副驾两家（pilotSlot 必须 !== null）。
      //   主驾切换 / 取消主驾时 dispatchMode 自动 reset 为 'all'（避免状态漂移）。
      pilotSlot: null,
      dispatchMode: 'all',
    };
    // Hub Timeline phase 1 (in-memory only)
    meeting._timeline = [];
    meeting._cursors = {};
    meeting._nextIdx = 0;
    this.meetings.set(id, meeting);
    return { ...meeting, slotSpecs: meeting.slotSpecs ? meeting.slotSpecs.slice() : null };
  }

  // pilot redesign（2026-05-02）：切换主驾 slot。slotIndex=null 表示取消主驾角色。
  //   切换或取消时同步 reset dispatchMode='all'，避免"主驾切了但还在副驾发言模式"的状态漂移。
  //   仅做内存 state + per-meeting JSON 落盘；state.json 由 main.js 顺手维护。
  setPilotSlot(meetingId, slotIndex) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (slotIndex !== null && (typeof slotIndex !== 'number' || slotIndex < 0 || slotIndex > 2)) {
      throw new Error(`Invalid pilot slotIndex: ${slotIndex}`);
    }
    m.pilotSlot = slotIndex;
    m.dispatchMode = 'all';  // 切换主驾自动 reset
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs, pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode,
    });
    return { ...m, subSessions: [...m.subSessions], pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode };
  }

  getPilotSlot(meetingId) {
    const m = this.meetings.get(meetingId);
    return m ? (m.pilotSlot ?? null) : null;
  }

  // pilot redesign（2026-05-02）：设置当前轮 dispatchMode。
  //   mode ∈ {'all','pilot','observer'}。'pilot' / 'observer' 要求 pilotSlot !== null。
  setDispatchMode(meetingId, mode) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (!['all', 'pilot', 'observer'].includes(mode)) {
      throw new Error(`Invalid dispatchMode: ${mode}`);
    }
    if (mode !== 'all' && (m.pilotSlot === null || m.pilotSlot === undefined)) {
      throw new Error(`dispatchMode '${mode}' requires pilotSlot to be set`);
    }
    m.dispatchMode = mode;
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs, pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode,
    });
    return { ...m, subSessions: [...m.subSessions], pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode };
  }

  getDispatchMode(meetingId) {
    const m = this.meetings.get(meetingId);
    return m ? (m.dispatchMode || 'all') : 'all';
  }

  // meeting-create-modal（2026-05-01）：Modal 创建完所有 slot 后调用，
  //   把 slot 规格写到 meeting + 触发 timeline JSON 落盘。
  setSlotSpecs(meetingId, slotSpecs) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.slotSpecs = Array.isArray(slotSpecs) ? slotSpecs.slice() : null;
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs,
    });
    return { ...m, subSessions: [...m.subSessions], slotSpecs: m.slotSpecs ? m.slotSpecs.slice() : null };
  }

  getMeeting(id) {
    const m = this.meetings.get(id);
    return m ? {
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.slice() : null,
      pilotSlot: m.pilotSlot ?? null,
      dispatchMode: m.dispatchMode || 'all',
    } : null;
  }

  getAllMeetings() {
    return Array.from(this.meetings.values()).map(m => ({
      ...m,
      subSessions: [...m.subSessions],
      _timeline: [...m._timeline],
      _cursors: { ...m._cursors },
      slotSpecs: Array.isArray(m.slotSpecs) ? m.slotSpecs.slice() : null,
      pilotSlot: m.pilotSlot ?? null,
      dispatchMode: m.dispatchMode || 'all',
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
    if (fields.scene && !MEETING_MODES.includes(fields.scene)) {
      throw new Error(`Invalid scene value: '${fields.scene}'. Allowed: ${MEETING_MODES.join(', ')}`);
    }
    const allowed = [
      'title', 'layout', 'focusedSub', 'syncContext', 'sendTarget', 'pinned',
      'lastMessageTime', 'status', 'lastScene', 'scene', 'covenantText',
    ];
    for (const key of allowed) {
      if (key in fields) m[key] = fields[key];
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
    // 向后兼容：从旧的 researchMode/roundtableMode 推断 scene
    let scene = meetingData.scene;
    if (!scene) {
      scene = meetingData.researchMode ? 'research' : 'general';
    }
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
      scene,
      covenantText: meetingData.covenantText || meetingData.generalRoundtableCovenant || '',
      // meeting-create-modal（2026-05-01）：从 state.json 还原 slot 规格；
      //   老 meeting 没有此字段时为 null，渲染逻辑会按 subSessions 顺序兜底分配 slot。
      slotSpecs: Array.isArray(meetingData.slotSpecs) ? meetingData.slotSpecs.slice() : null,
      // pilot-mode（2026-05-01）：从 state.json 还原主驾 slot；老 meeting 默认 null（关）。
      pilotSlot: (typeof meetingData.pilotSlot === 'number' && meetingData.pilotSlot >= 0 && meetingData.pilotSlot <= 2)
        ? meetingData.pilotSlot : null,
      // pilot redesign 迁移（2026-05-02）：旧数据无 dispatchMode 时按 pilotSlot 推断。
      //   旧 pilotSlot !== null（旧版"开主驾模式"）→ 默认 'pilot'（保留旧行为：仅主驾发言）；
      //   pilotSlot === null → 默认 'all'。新数据直接读字段。
      dispatchMode: ['all', 'pilot', 'observer'].includes(meetingData.dispatchMode)
        ? meetingData.dispatchMode
        : ((typeof meetingData.pilotSlot === 'number') ? 'pilot' : 'all'),
      _timeline: [],
      _cursors: {},
      _nextIdx: 0,
    });
    // 按 scene + title 末尾 #N 数字推断恢复到哪个 counter,避免新建撞号。
    // 老格式 "会议室-N" / "主驾会议 #N" 不匹配新规则,跳过。
    const restoredMode = scene;
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
    // 兜底回填 slotSpecs（state.json 已写过的不覆盖）
    if (!Array.isArray(m.slotSpecs) && Array.isArray(data.slotSpecs)) {
      m.slotSpecs = data.slotSpecs.slice();
    }
    // pilot-mode 兜底回填：state.json 走 _pilotSlotByMeeting，per-meeting JSON 是备份
    if ((m.pilotSlot === null || m.pilotSlot === undefined) && typeof data.pilotSlot === 'number') {
      m.pilotSlot = data.pilotSlot;
    }
    // pilot redesign 兜底回填（2026-05-02）：dispatchMode 同样支持 per-meeting JSON 兜底
    if ((!m.dispatchMode || m.dispatchMode === 'all') && ['all', 'pilot', 'observer'].includes(data.dispatchMode)) {
      m.dispatchMode = data.dispatchMode;
    }
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
  return !!(meeting && meeting.scene);
}

module.exports = { MeetingRoomManager, isRoundtableCapableMeeting, MEETING_MODES };
