'use strict';

// P3 最小可证伪 meeting 绑定：
//   - createMeeting (mode + members)
//   - 默认 3 成员：Claude / Codex / GPT（用户可后续在 PWA 端覆盖）
//   - listMeetings 返回 mobile-created meetings
//
// 未实现（V2）：
//   - meeting input 路由（dispatch 给所有 subSessions）
//   - timeline 推送给 PWA
//   - PWA UI 群聊 timeline 视图
//
// 持久化到 ${dataDir}/mobile-meetings.json，重启可恢复。

const fs = require('fs');
const path = require('path');
const { DEFAULT_MODEL_BY_KIND } = require('../../core/model-options');

const DEFAULT_MEMBERS_3 = [
  { kind: 'claude', model: DEFAULT_MODEL_BY_KIND.claude },
  { kind: 'codex',  model: DEFAULT_MODEL_BY_KIND.codex },
  { kind: 'gpt',    model: DEFAULT_MODEL_BY_KIND.gpt },
];

class MeetingBinder {
  constructor({ sessionManager, meetingManager, logger = console, dataDir }) {
    this.sessionManager = sessionManager;
    this.meetingManager = meetingManager;
    this.logger = logger;
    this.dataDir = dataDir;
    this.mobileMeetingsPath = dataDir ? path.join(dataDir, 'mobile-meetings.json') : null;
    this.mobileMeetingIds = new Set();
    this._load();
  }

  _load() {
    if (!this.mobileMeetingsPath) return;
    try {
      if (fs.existsSync(this.mobileMeetingsPath)) {
        const raw = JSON.parse(fs.readFileSync(this.mobileMeetingsPath, 'utf8'));
        if (Array.isArray(raw.meetings)) {
          for (const id of raw.meetings) this.mobileMeetingIds.add(id);
        }
      }
    } catch (e) {
      this.logger.warn(`[meeting-binder] load failed: ${e.message}`);
    }
  }

  _save() {
    if (!this.mobileMeetingsPath) return;
    try {
      const tmp = this.mobileMeetingsPath + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify({ meetings: Array.from(this.mobileMeetingIds) }, null, 2));
      fs.renameSync(tmp, this.mobileMeetingsPath);
    } catch (e) {
      this.logger.warn(`[meeting-binder] save failed: ${e.message}`);
    }
  }

  // 创建 mobile meeting + 默认 3 个 subSessions
  // opts: { mode, title?, members? }
  createMeeting(opts = {}) {
    if (!this.meetingManager || typeof this.meetingManager.createMeeting !== 'function') {
      return { ok: false, error: 'meetingManager not available' };
    }
    const mode = ['general', 'research', 'dev'].includes(opts.mode) ? opts.mode : 'general';
    const members = Array.isArray(opts.members) && opts.members.length > 0 ? opts.members : DEFAULT_MEMBERS_3;

    let meeting;
    try {
      meeting = this.meetingManager.createMeeting({
        mode,
        title: opts.title,
        slotSpecs: members.map((m, i) => ({ index: i, kind: m.kind, model: m.model })),
      });
    } catch (e) {
      return { ok: false, error: `createMeeting failed: ${e.message}` };
    }

    // 为每个 member spawn 一个 subSession
    const subIds = [];
    for (let i = 0; i < members.length; i++) {
      const m = members[i];
      try {
        const s = this.sessionManager.createSession(m.kind, {
          meetingId: meeting.id,
          model: m.model,
        });
        const sid = s && (s.id || s.hubId);
        if (sid) {
          subIds.push(sid);
          if (typeof this.meetingManager.addSubSession === 'function') {
            try { this.meetingManager.addSubSession(meeting.id, sid); } catch (e) {
              this.logger.warn(`[meeting-binder] addSubSession failed: ${e.message}`);
            }
          }
        }
      } catch (e) {
        this.logger.warn(`[meeting-binder] spawn ${m.kind} failed: ${e.message}`);
      }
    }

    this.mobileMeetingIds.add(meeting.id);
    this._save();
    this.logger.log(`[meeting-binder] created meeting ${meeting.id} mode=${mode} members=${members.length} subSessions=${subIds.length}`);

    return {
      ok: true,
      meeting: {
        id: meeting.id,
        title: meeting.title,
        scene: meeting.scene,
        mode,
        members,
        subSessions: subIds,
        createdAt: meeting.createdAt,
      },
    };
  }

  listMeetings() {
    const result = [];
    if (!this.meetingManager || typeof this.meetingManager.getMeeting !== 'function') return result;
    for (const id of this.mobileMeetingIds) {
      try {
        const m = this.meetingManager.getMeeting(id);
        if (m) result.push({
          id: m.id,
          title: m.title,
          scene: m.scene,
          mode: m.mode,
          subSessionCount: Array.isArray(m.subSessions) ? m.subSessions.length : 0,
          createdAt: m.createdAt,
          lastMessageTime: m.lastMessageTime,
          isMobile: true,
        });
      } catch {}
    }
    return result;
  }
}

module.exports = { MeetingBinder, DEFAULT_MEMBERS_3 };
