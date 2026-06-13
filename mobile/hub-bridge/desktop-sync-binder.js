'use strict';

// DesktopSyncBinder：AI Hub 手机端 MVP 的桌面 Hub 同步层。
//
// 现有 SessionBinder 服务“手机自己创建的 mobile sessions”。这个模块并行服务
// “手机查看/控制电脑 Hub 已有 session / meeting 卡片”，避免把两类状态混在一起。
//
// 最小闭环：
//   - hub-snapshot-req → hub-snapshot：全量卡片
//   - transcriptTap turn-complete → hub-delta：增量卡片 + turn
//   - hub-command：定向写入普通 session；meeting 走 dispatchGroupChatTurn（如果 main 注入）

const { MSG } = require('../shared/protocol');

function clampText(value, max = 280) {
  const s = String(value || '').replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

function isCodexLike(kind) {
  const k = String(kind || '').toLowerCase();
  return k.includes('codex') || k.startsWith('gpt') || k.startsWith('o3') || k.startsWith('o4');
}

function isGeminiLike(kind) {
  return String(kind || '').toLowerCase().includes('gemini');
}

class DesktopSyncBinder {
  constructor({
    sessionManager,
    meetingManager = null,
    transcriptTap = null,
    outbound,
    dispatchGroupChatTurn = null,
    logger = console,
  }) {
    this.sessionManager = sessionManager;
    this.meetingManager = meetingManager;
    this.transcriptTap = transcriptTap;
    this.outbound = outbound;
    this.dispatchGroupChatTurn = dispatchGroupChatTurn;
    this.logger = logger;
    this.globalSeq = 0;
    this._snapshotTimer = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    if (this.sessionManager && typeof this.sessionManager.on === 'function') {
      this.sessionManager.on('session-updated', () => this._scheduleSnapshotBroadcast());
    }
    if (this.transcriptTap && typeof this.transcriptTap.on === 'function') {
      this.transcriptTap.on('turn-complete', (ev) => this._handleTurnComplete(ev));
    }
  }

  handleSnapshotRequest({ deviceToken, requestId }) {
    this._sendSnapshot({ deviceToken, requestId });
  }

  _sendSnapshot({ deviceToken = null, requestId = null } = {}) {
    this.outbound.send({
      type: MSG.HUB_SNAPSHOT,
      deviceToken,
      requestId,
      snapshot: this.buildSnapshot(),
    });
  }

  buildSnapshot() {
    const sessions = this._listSessionCards();
    const meetings = this._listMeetingCards();
    return {
      version: 1,
      seq: ++this.globalSeq,
      generatedAt: Date.now(),
      sessions,
      meetings,
      cards: sessions.concat(meetings).sort((a, b) =>
        (b.lastMessageTime || b.updatedAt || b.createdAt || 0) -
        (a.lastMessageTime || a.updatedAt || a.createdAt || 0)
      ),
    };
  }

  handleCommand(msg = {}) {
    const clientId = msg.clientId || null;
    const content = String(msg.content || '').trim();
    const targetType = msg.targetType || 'session';
    const targetId = msg.targetId || msg.sessionId;
    if (!content) {
      this._ack(msg.deviceToken, clientId, false, { error: 'empty_content' });
      return;
    }
    if (!targetId) {
      this._ack(msg.deviceToken, clientId, false, { error: 'missing_target' });
      return;
    }

    if (targetType === 'meeting') {
      this._handleMeetingCommand(msg.deviceToken, clientId, targetId, content);
      return;
    }

    const session = this.sessionManager && this.sessionManager.getSession(targetId);
    if (!session) {
      this._ack(msg.deviceToken, clientId, false, { error: 'session_not_found' });
      return;
    }
    try {
      if (this.transcriptTap && typeof this.transcriptTap.notePrompt === 'function') {
        this.transcriptTap.notePrompt(targetId, session.kind, content);
      }
    } catch (e) {
      this.logger.warn(`[desktop-sync] notePrompt failed: ${e.message}`);
    }
    this._writeWhenReady(targetId, content, session.kind);
    this._ack(msg.deviceToken, clientId, true, { queued: true, targetType: 'session', targetId });
  }

  handleRename(msg = {}) {
    const targetId = msg.targetId || msg.sessionId;
    const title = String(msg.title || '').trim().slice(0, 64);
    if (!targetId || !title) return false;
    const current = this.sessionManager && this.sessionManager.getSession && this.sessionManager.getSession(targetId);
    if (!current) return false;
    let updated = null;
    try {
      if (this.sessionManager && typeof this.sessionManager.renameSession === 'function') {
        updated = this.sessionManager.renameSession(targetId, title, { userRenamed: true });
      }
    } catch (e) {
      this.logger.warn(`[desktop-sync] rename failed: ${e.message}`);
      return false;
    }
    if (!updated) return false;
    this._sendSnapshot({ deviceToken: msg.deviceToken, requestId: msg.requestId || null });
    this._scheduleSnapshotBroadcast();
    return true;
  }

  handlePin(msg = {}) {
    const targetId = msg.targetId || msg.sessionId;
    if (!targetId) return false;
    const current = this.sessionManager && this.sessionManager.getSession && this.sessionManager.getSession(targetId);
    if (!current) return false;
    const pinned = !!msg.pinned;
    const fields = { pinned, pinnedAt: pinned ? Date.now() : null };
    let updated = null;
    try {
      if (this.sessionManager && typeof this.sessionManager.updateSessionMeta === 'function') {
        updated = this.sessionManager.updateSessionMeta(targetId, fields);
      }
    } catch (e) {
      this.logger.warn(`[desktop-sync] pin failed: ${e.message}`);
      return false;
    }
    if (!updated) return false;
    this._sendSnapshot({ deviceToken: msg.deviceToken, requestId: msg.requestId || null });
    this._scheduleSnapshotBroadcast();
    return true;
  }

  handleDestroy(msg = {}) {
    const targetId = msg.targetId || msg.sessionId;
    if (!targetId) return false;
    const current = this.sessionManager && this.sessionManager.getSession && this.sessionManager.getSession(targetId);
    if (!current) return false;
    try {
      if (!this.sessionManager || typeof this.sessionManager.closeSession !== 'function') return false;
      this.sessionManager.closeSession(targetId);
    } catch (e) {
      this.logger.warn(`[desktop-sync] destroy failed: ${e.message}`);
      return false;
    }
    setTimeout(() => this._sendSnapshot({ deviceToken: msg.deviceToken, requestId: msg.requestId || null }), 250);
    setTimeout(() => this._sendSnapshot({ deviceToken: msg.deviceToken, requestId: msg.requestId || null }), 900);
    this._scheduleSnapshotBroadcast();
    return true;
  }

  _handleMeetingCommand(deviceToken, clientId, meetingId, content) {
    const meeting = this.meetingManager && this.meetingManager.getMeeting && this.meetingManager.getMeeting(meetingId);
    if (!meeting) {
      this._ack(deviceToken, clientId, false, { error: 'meeting_not_found' });
      return;
    }
    if (typeof this.dispatchGroupChatTurn !== 'function') {
      this._ack(deviceToken, clientId, false, { error: 'meeting_command_unavailable' });
      return;
    }
    this._ack(deviceToken, clientId, true, { queued: true, targetType: 'meeting', targetId: meetingId });
    try {
      if (this.meetingManager && typeof this.meetingManager.appendTurn === 'function') {
        this.meetingManager.appendTurn(meetingId, 'user', content, Date.now());
      }
    } catch (e) {
      this.logger.warn(`[desktop-sync] append meeting user turn failed: ${e.message}`);
    }
    Promise.resolve()
      .then(() => this.dispatchGroupChatTurn(meetingId, { userInput: content, source: 'mobile-ai-hub' }))
      .then((result) => {
        const status = result && (result.status || result.reason) ? `${result.status || 'done'}${result.reason ? ': ' + result.reason : ''}` : 'done';
        this._sendDelta({
          deviceToken,
          op: 'turn',
          card: this._meetingToCard(this.meetingManager.getMeeting(meetingId) || meeting),
          turn: {
            sessionId: `meeting:${meetingId}`,
            role: 'assistant',
            content: `群聊指令已执行：${status}`,
            ts: Date.now(),
            model: 'meeting',
          },
        });
      })
      .catch((e) => {
        this._sendDelta({
          deviceToken,
          op: 'error',
          card: this._meetingToCard(this.meetingManager.getMeeting(meetingId) || meeting),
          turn: {
            sessionId: `meeting:${meetingId}`,
            role: 'assistant',
            content: `群聊指令执行失败：${e && e.message ? e.message : String(e)}`,
            ts: Date.now(),
            model: 'meeting',
          },
        });
      });
  }

  _listSessionCards() {
    const sessions = this.sessionManager && typeof this.sessionManager.getAllSessions === 'function'
      ? this.sessionManager.getAllSessions()
      : [];
    return sessions.map((s) => this._sessionToCard(s)).filter(Boolean);
  }

  _listMeetingCards() {
    const meetings = this.meetingManager && typeof this.meetingManager.getAllMeetings === 'function'
      ? this.meetingManager.getAllMeetings()
      : [];
    return meetings.map((m) => this._meetingToCard(m)).filter(Boolean);
  }

  _getMeetingTimeline(meetingId, limit = 30) {
    try {
      if (this.meetingManager && typeof this.meetingManager.loadTimelineLazy === 'function') {
        this.meetingManager.loadTimelineLazy(meetingId);
      }
      const timeline = this.meetingManager && typeof this.meetingManager.getTimeline === 'function'
        ? this.meetingManager.getTimeline(meetingId)
        : [];
      if (!Array.isArray(timeline)) return [];
      return timeline.slice(-limit).map((item, index) => {
        const sid = item && (item.sid || item.sessionId || item.source) || null;
        return {
          idx: typeof item.idx === 'number' ? item.idx : index,
          sid,
          role: sid === 'user' || item.role === 'user' ? 'user' : (item.role || 'assistant'),
          text: clampText(item && (item.text || item.content || item.message || ''), 1200),
          ts: item && (item.ts || item.completedAt || item.createdAt) || null,
          model: item && item.model || null,
        };
      }).filter(item => item.text);
    } catch {
      return [];
    }
  }

  _getMeetingMembers(m) {
    if (!m || !m.id) return [];
    const subSessions = Array.isArray(m.subSessions) ? m.subSessions : [];
    const specs = Array.isArray(m.slotSpecs) ? m.slotSpecs : [];
    const rawMembers = Array.isArray(m.members) ? m.members : [];
    const count = Math.max(subSessions.length, specs.length, rawMembers.length);
    const out = [];
    for (let i = 0; i < count; i++) {
      const spec = specs[i] || rawMembers[i] || {};
      const sid = subSessions[i] || spec.sid || spec.sessionId || null;
      let session = null;
      try {
        session = sid && this.sessionManager && typeof this.sessionManager.getSession === 'function'
          ? this.sessionManager.getSession(sid)
          : null;
      } catch {}
      out.push({
        index: typeof spec.index === 'number' ? spec.index : i,
        sid,
        kind: spec.kind || (session && session.kind) || 'assistant',
        model: spec.model || (session && (session.model || (session.currentModel && session.currentModel.id))) || null,
        title: (session && session.title) || spec.title || sid || `Member ${i + 1}`,
        status: (session && session.status) || 'active',
      });
    }
    return out;
  }

  _sessionToCard(s) {
    if (!s || !s.id) return null;
    let preview = s.lastOutputPreview || '';
    try {
      if (!preview && this.transcriptTap && typeof this.transcriptTap.getLastAssistantText === 'function') {
        preview = this.transcriptTap.getLastAssistantText(s.id) || '';
      }
    } catch {}
    return {
      id: s.id,
      targetId: s.id,
      targetType: 'session',
      source: 'desktop',
      kind: s.kind || 'session',
      title: s.title || s.id,
      status: 'active',
      cwd: s.cwd || null,
      meetingId: s.meetingId || null,
      model: s.model || (s.currentModel && s.currentModel.id) || null,
      contextPct: typeof s.contextPct === 'number' ? s.contextPct : null,
      unreadCount: s.unreadCount || 0,
      lastMessageTime: s.lastMessageTime || s.createdAt || Date.now(),
      createdAt: s.createdAt || null,
      pinned: !!s.pinned,
      pinnedAt: s.pinnedAt || null,
      preview: clampText(preview),
      canCommand: true,
    };
  }

  _meetingToCard(m) {
    if (!m || !m.id) return null;
    const timeline = this._getMeetingTimeline(m.id);
    const members = this._getMeetingMembers(m);
    const last = timeline.length ? timeline[timeline.length - 1] : null;
    const preview = last ? last.text || '' : '';
    return {
      id: `meeting:${m.id}`,
      targetId: m.id,
      targetType: 'meeting',
      source: 'desktop',
      kind: 'meeting',
      scene: m.scene || m.mode || 'general',
      mode: m.mode || m.scene || 'general',
      title: m.title || 'AI 群聊',
      status: m.status || 'active',
      subSessionCount: Array.isArray(m.subSessions) ? m.subSessions.length : members.length,
      subSessions: Array.isArray(m.subSessions) ? m.subSessions.slice() : [],
      members,
      timeline,
      sendTarget: m.sendTarget || 'all',
      focusedSub: m.focusedSub || null,
      lastMessageTime: m.lastMessageTime || m.updatedAt || m.createdAt || Date.now(),
      createdAt: m.createdAt || null,
      pinned: !!m.pinned,
      preview: clampText(preview),
      canCommand: typeof this.dispatchGroupChatTurn === 'function',
    };
  }

  _handleTurnComplete(ev) {
    if (!ev || !ev.hubSessionId) return;
    const session = this.sessionManager && this.sessionManager.getSession(ev.hubSessionId);
    if (!session) return;
    const turn = {
      sessionId: ev.hubSessionId,
      role: 'assistant',
      content: ev.text || '',
      ts: ev.completedAt || Date.now(),
      durationMs: ev.durationMs || null,
      model: ev.modelId || session.kind || 'unknown',
      usage: ev.usage || null,
    };
    this._sendDelta({
      op: 'turn',
      card: this._sessionToCard(session),
      turn,
    });

    if (session.meetingId && this.meetingManager && typeof this.meetingManager.getMeeting === 'function') {
      const meeting = this.meetingManager.getMeeting(session.meetingId);
      if (meeting) {
        this._sendDelta({
          op: 'turn',
          card: this._meetingToCard(meeting),
          turn: {
            ...turn,
            sessionId: `meeting:${session.meetingId}`,
            model: turn.model || 'meeting',
          },
        });
      }
    }
  }

  _scheduleSnapshotBroadcast() {
    if (this._snapshotTimer) return;
    this._snapshotTimer = setTimeout(() => {
      this._snapshotTimer = null;
      this.outbound.send({
        type: MSG.HUB_SNAPSHOT,
        snapshot: this.buildSnapshot(),
      });
    }, 700);
  }

  _sendDelta(payload) {
    this.outbound.send({
      type: MSG.HUB_DELTA,
      seq: ++this.globalSeq,
      ts: Date.now(),
      ...payload,
    });
  }

  _ack(deviceToken, clientId, ok, extra = {}) {
    this.outbound.send({
      type: MSG.COMMAND_ACK,
      deviceToken,
      clientId,
      ok: !!ok,
      ...extra,
    });
  }

  _writeWhenReady(sessionId, text, kind, deadline = Date.now() + 6000) {
    const doubleWrite = isCodexLike(kind) || isGeminiLike(kind);
    const ready = () => {
      const buf = this.sessionManager.getSessionBuffer(sessionId) || '';
      if (isCodexLike(kind)) {
        return buf.includes('▌') || buf.includes('Send a message') || buf.includes('to send') || buf.includes('⏵') || /\btokens\b/i.test(buf);
      }
      if (isGeminiLike(kind)) {
        return buf.includes('Type your message') || buf.includes('╭─') || buf.includes('│ >') || /\bgemini\b/i.test(buf);
      }
      return true;
    };
    const doWrite = () => {
      if (!doubleWrite) {
        try { this.sessionManager.writeToSession(sessionId, text + '\r'); }
        catch (e) { this.logger.warn(`[desktop-sync] writeToSession failed: ${e.message}`); }
        return;
      }
      try { this.sessionManager.writeToSession(sessionId, text); } catch {}
      setTimeout(() => {
        try { this.sessionManager.writeToSession(sessionId, '\r'); } catch {}
        setTimeout(() => { try { this.sessionManager.writeToSession(sessionId, '\r'); } catch {} }, 150);
      }, 250);
    };
    const tick = () => {
      if (ready() || Date.now() > deadline) return doWrite();
      setTimeout(tick, 300);
    };
    tick();
  }
}

module.exports = { DesktopSyncBinder };
