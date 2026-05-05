const { v4: uuid } = require('uuid');
const meetingStore = require('./meeting-store');

// scene 白名单 (与 core/roundtable-scenes.js SCENE_REGISTRY keys 同步)
//   2026-05-04 道雪: 'dev' 加入 (plan-dev-scenario.md MVP)
const MEETING_MODES = ['general', 'research', 'dev'];

// 模式 → 房名前缀。前端 +号菜单点击两模式入口时透传 mode,createMeeting 据此生成
// 自带语义的房名(每模式独立计数,后期允许用户重命名)。未传 mode 时默认 'general' 走
// 通用圆桌路径,保持向后兼容(老调用 createMeeting() 不会炸)。
// 2026-05-05 道雪：前缀从 "X圆桌" 简化为 "X"，避免侧边栏 ~12 字符上限把 "投研圆桌 #12" 截成
//   "投研圆桌 #1..." 区分不出编号。"圆桌"语义已由🎯 emoji + sub session 头像承载。
const MODE_TITLE_PREFIX = {
  general: '通用',
  research: '投研',
  dev: '开发',
};

class MeetingRoomManager {
  constructor() {
    this.meetings = new Map();
    // 两模式独立计数,跨模式不共享
    this._counters = { general: 0, research: 0, dev: 0 };
  }

  createMeeting(opts = {}) {
    const id = uuid();
    const mode = MODE_TITLE_PREFIX[opts.mode] ? opts.mode : 'general';
    const titlePrefix = MODE_TITLE_PREFIX[mode];
    const seq = ++this._counters[mode];
    // meeting-create-modal（2026-05-05 道雪）：用户在 Modal 房名输入框填了非空字符串
    //   则用用户的（trim 后），否则走默认编号 title。modal 留空 = undefined，向后兼容。
    const customTitle = typeof opts.title === 'string' ? opts.title.trim() : '';
    const meeting = {
      id,
      type: 'meeting',
      title: customTitle || `${titlePrefix} #${seq}`,
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
      // 2026-05-05 道雪：废弃主驾模式入口，所有新圆桌固定 free。底层 pilot 编排代码暂留
      //   （setPilotSlot/dispatchMode/orchestrator pilot 分支等），方便未来恢复；但创建路径
      //   不再有 pilot 入口。opts.meetingMode 字段被忽略。
      mode: 'free',
      // free-mode（2026-05-04）：自由模式参与者 slot 列表，默认全员勾选
      participants: [0, 1, 2],
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

  // free-mode（2026-05-04）：切换 meeting 级模式 'pilot' ⇄ 'free'。
  //   直接写回 Map 原始对象（getMeeting 返回浅拷贝，对其赋值不写回 Map）。
  //   切到 free 且 participants 未初始化 → 默认全选 [0,1,2]。
  setMeetingMode(meetingId, mode) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    if (!['pilot', 'free'].includes(mode)) {
      throw new Error(`Invalid meeting mode: ${mode}`);
    }
    m.mode = mode;
    if (mode === 'free' && m.participants === null) {
      m.participants = [0, 1, 2];
    }
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs, pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode,
      mode: m.mode, participants: m.participants,
    });
    return { ...m, subSessions: [...m.subSessions], mode: m.mode, participants: Array.isArray(m.participants) ? [...m.participants] : null };
  }

  // free-mode（2026-05-04）：设置自由模式参与者列表。
  //   接受空数组（Q11=A：尊重用户清空）。
  setParticipants(meetingId, participants) {
    const m = this.meetings.get(meetingId);
    if (!m) return null;
    m.participants = Array.isArray(participants) ? participants : null;
    meetingStore.markDirty(meetingId, {
      _timeline: m._timeline, _cursors: m._cursors, _nextIdx: m._nextIdx,
      slotSpecs: m.slotSpecs, pilotSlot: m.pilotSlot, dispatchMode: m.dispatchMode,
      mode: m.mode, participants: m.participants,
    });
    return { ...m, subSessions: [...m.subSessions], mode: m.mode, participants: Array.isArray(m.participants) ? [...m.participants] : null };
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
      // 2026-05-05 道雪：fallback 从 'pilot' 改 'free'（与新建路径一致），主驾入口废弃。
      mode: ['pilot', 'free'].includes(m.mode) ? m.mode : 'free',
      participants: Array.isArray(m.participants) ? [...m.participants] : null,
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
      // 2026-05-05 道雪：fallback 从 'pilot' 改 'free'（与新建路径一致），主驾入口废弃。
      mode: ['pilot', 'free'].includes(m.mode) ? m.mode : 'free',
      participants: Array.isArray(m.participants) ? [...m.participants] : null,
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
      if (meetingData.researchMode) {
        scene = 'research';
      } else if (typeof meetingData.title === 'string') {
        // 2026-05-05 道雪：title 兜底推断 — 历史 bug：renderer schedulePersist 漏 scene
        //   字段写残 state.json，重启后所有圆桌退化为 general（含投研，丢 LinDangAgent MCP）。
        //   schedulePersist 已修但既有 state.json 字段已丢，按 title 前缀推断兜底。
        //   匹配新前缀 "投研" / "开发" / "通用" 与 旧前缀 "投研圆桌" / "开发圆桌" / "通用圆桌"。
        if (meetingData.title.includes('投研')) scene = 'research';
        else if (meetingData.title.includes('开发')) scene = 'dev';
        else scene = 'general';
      } else {
        scene = 'general';
      }
    } else if (scene === 'general' && typeof meetingData.title === 'string') {
      // 2026-05-05 道雪：scene-title 不一致检测 — 上次 fix（line 上方）的 title 兜底
      //   只在 scene 字段缺失时生效，但用户既存 state.json 里 scene 已被旧版错写为 'general'，
      //   兜底救不到。补一道：scene='general' 但 title 含 '投研'/'开发' 视为旧版数据迁移
      //   遗留的不一致 → 强制按 title 修正。新建圆桌不会触发（title 由 createMeeting 按
      //   scene 一致生成）；用户极罕见地把通用圆桌起名"投研笔记"会被误判，但权衡正确率优先。
      if (meetingData.title.includes('投研')) scene = 'research';
      else if (meetingData.title.includes('开发')) scene = 'dev';
    }
    // 标记 mutate 入参，让调用方（main.js boot 时 stateStore.save(bootMeetings)）写盘的
    //   meetings 数组也带上修正后的 scene —— 否则 boot 时 save 用原始 bootMeetings 会把
    //   修正前的 'general' 写回 state.json，下次重启又重复迁移、永不收敛。
    meetingData.scene = scene;
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
      // 2026-05-05 道雪：BUG fix —— 旧版兜底 'pilot' 导致 free 模式圆桌重启后被错误改成主驾。
      //   主驾入口已废弃，所有未识别 mode 一律 fallback 'free'。同时强制把老 meeting 的 mode='pilot'
      //   也迁移成 'free'（一次性数据迁移）：底层 pilotSlot/dispatchMode 字段保留，但 free UI 不读，无害。
      mode: 'free',
      // free-mode（2026-05-04）：null=首次未初始化，空数组=用户已清空（Q11=A）
      participants: Array.isArray(meetingData.participants) ? meetingData.participants : null,
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
    // free-mode 兜底回填（2026-05-04）：per-meeting JSON 备份 mode/participants
    if (!['pilot', 'free'].includes(m.mode) && ['pilot', 'free'].includes(data.mode)) {
      m.mode = data.mode;
    }
    if (!Array.isArray(m.participants) && Array.isArray(data.participants)) {
      m.participants = data.participants;
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

// pilot redesign v5（2026-05-02）：判定某 slot 是否参与本轮 dispatch。
// 与 main.js dispatchRoundtableTurn 的 targetSubs 公式严格对齐 — UI 卡片渲染
// （renderer/meeting-room.js）和后端 dispatch 路由必须共用同一份真理，避免
// 出现"卡片显 thinking 但后端没发 prompt"或反向的撕裂。
//
// 两轴解耦：
//   pilotSlot     — 角色标识（红框 / "主驾"三角，与本轮 dispatch 无关）
//   dispatchMode  — 本轮谁开口：'all' | 'pilot' | 'observer'
//
// 规则：
//   - pilotSlot 未设（null）→ 始终全员参与（dispatchMode 此时被强制视为 'all'）
//   - dispatchMode='all'    → 全员参与
//   - dispatchMode='pilot'  → 仅主驾 slot 参与
//   - dispatchMode='observer' → 排除主驾 slot
function isSlotParticipatingThisTurn(meeting, slotIndex) {
  if (!meeting) return true;
  // free-mode（2026-05-04）：按 participants 集合判定
  if (meeting.mode === 'free') {
    // 设计契约（与 main.js:dispatchRoundtableTurn 同步）：
    //   participants===null（未初始化）→ 视为全员（默认 [0,1,2]）
    //   两处兜底必须语义一致，否则 UI thinking 状态会与实际 dispatch 撕裂
    if (!Array.isArray(meeting.participants)) return true; // 未初始化默认全员
    return meeting.participants.includes(slotIndex);
  }
  const pilotSlot = (typeof meeting.pilotSlot === 'number'
    && meeting.pilotSlot >= 0 && meeting.pilotSlot <= 2) ? meeting.pilotSlot : null;
  const dispatchMode = ['all', 'pilot', 'observer'].includes(meeting.dispatchMode)
    ? meeting.dispatchMode : 'all';
  if (pilotSlot === null) return true;
  if (dispatchMode === 'all') return true;
  if (dispatchMode === 'pilot') return slotIndex === pilotSlot;
  if (dispatchMode === 'observer') return slotIndex !== pilotSlot;
  return true;
}

module.exports = {
  MeetingRoomManager,
  isRoundtableCapableMeeting,
  isSlotParticipatingThisTurn,
  MEETING_MODES,
};
