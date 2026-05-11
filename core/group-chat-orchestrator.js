'use strict';

const fs = require('fs');
const path = require('path');
const { KIND_LABELS } = require('./ai-kinds.js');

const STATE_VERSION = 1;
const DEFAULT_RECENT_RAW_N = 5;
const MAX_SUMMARY_CHARS = 900;
const MAX_RECENT_RAW_CHARS = 1600;
const MAX_MEMBER_TEXT_CHARS = 2200;

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function groupChatStatePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-groupchat.json`);
}

function rawMessageAnchor(meetingId, messageId) {
  return `raw://group/${meetingId}/msg/${messageId}`;
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _clip(text, maxChars) {
  const s = String(text || '');
  if (s.length <= maxChars) return s;
  const head = Math.floor(maxChars * 0.62);
  const tail = Math.max(0, maxChars - head - 32);
  return `${s.slice(0, head)}\n...[middle omitted]...\n${s.slice(-tail)}`;
}

function _oneLine(text, maxChars = 160) {
  return _clip(String(text || '').replace(/\s+/g, ' ').trim(), maxChars);
}

function _keywordList(text) {
  const raw = String(text || '');
  const tokens = raw
    .replace(/[^\p{L}\p{N}_#@.+/-]+/gu, ' ')
    .split(/\s+/)
    .map(x => x.trim())
    .filter(x => x.length >= 2 && x.length <= 32);
  const seen = new Set();
  const out = [];
  for (const t of tokens) {
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= 8) break;
  }
  return out;
}

function _memberLabel(member) {
  if (!member) return 'AI';
  return member.displayName || member.alias || KIND_LABELS[member.kind] || member.kind || member.memberId || 'AI';
}

function _memberManifest(members) {
  return members.map((m, i) => {
    const aliases = Array.isArray(m.aliases) && m.aliases.length ? `; aliases=${m.aliases.join(', ')}` : '';
    return `- ${m.memberId || `m${i + 1}`}: ${_memberLabel(m)}; kind=${m.kind || 'unknown'}; model=${m.model || 'default'}${aliases}`;
  }).join('\n');
}

function _buildDeterministicSegment({ turnNum, userMessage, aiMessages, meetingId }) {
  const allText = [userMessage && userMessage.content, ...aiMessages.map(m => m.content)].join('\n');
  const anchors = [];
  if (userMessage) anchors.push(userMessage.anchor);
  for (const m of aiMessages) anchors.push(m.anchor);
  const position = aiMessages.map(m => `${m.speaker}: ${_oneLine(m.content, 120)}`).join('\n');
  const summary = [
    `Position: 本轮围绕「${_oneLine(userMessage && userMessage.content, 90)}」展开，成员给出了独立观点。`,
    `Evidence: ${_keywordList(allText).join(', ') || '见原文 anchors'}`,
    `Assumptions: 摘要为系统确定性兜底生成，未做深度语义压缩。`,
    `Counterpoints: ${position || '暂无 AI 输出'}`,
    `Follow-up: 如需核对细节，按 anchors 读取原文。`,
  ].join('\n');
  return {
    id: `seg-${turnNum}`,
    schema: 'deliberation-v1',
    status: 'provisional',
    turnNum,
    fromMessageId: userMessage ? userMessage.id : null,
    toMessageId: aiMessages.length ? aiMessages[aiMessages.length - 1].id : (userMessage && userMessage.id),
    messageCount: (userMessage ? 1 : 0) + aiMessages.length,
    anchors,
    summary: _clip(summary, MAX_SUMMARY_CHARS),
    createdAt: Date.now(),
    meetingId,
  };
}

class GroupChatOrchestrator {
  constructor(hubDataDir, meetingId) {
    this.hubDataDir = hubDataDir;
    this.meetingId = meetingId;
    this.state = {
      schemaVersion: STATE_VERSION,
      meetingId,
      currentTurn: 0,
      currentMode: 'idle',
      messages: [],
      summarySegments: [],
      turns: [],
      aiStats: {},
    };
    this._activePrompts = {};
    this._loadState();
  }

  _stateFilePath() {
    return groupChatStatePath(this.hubDataDir, this.meetingId);
  }

  _loadState() {
    const fp = this._stateFilePath();
    if (!fs.existsSync(fp)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf-8'));
      if (raw && raw.meetingId === this.meetingId) {
        this.state = {
          schemaVersion: STATE_VERSION,
          currentMode: 'idle',
          messages: [],
          summarySegments: [],
          turns: [],
          aiStats: {},
          ...raw,
          meetingId: this.meetingId,
        };
      }
    } catch (e) {
      console.warn(`[groupchat] load state failed for ${this.meetingId}:`, e.message);
    }
  }

  _saveState() {
    const fp = this._stateFilePath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    fs.writeFileSync(fp, JSON.stringify(this.state, null, 2), 'utf-8');
  }

  getState() {
    return _clone(this.state);
  }

  beginTurn(userInput) {
    const n = (this.state.currentTurn || 0) + 1;
    this.state.currentTurn = n;
    this.state.currentMode = 'group';
    const msg = this._appendMessage({
      id: `u${n}`,
      turnNum: n,
      role: 'user',
      speaker: '你',
      content: userInput || '',
    });
    this._saveState();
    return { turnNum: n, userMessage: msg };
  }

  rollbackTurn(turnNum) {
    this.state.messages = this.state.messages.filter(m => m.turnNum !== turnNum);
    this.state.turns = this.state.turns.filter(t => t.n !== turnNum);
    this.state.summarySegments = this.state.summarySegments.filter(s => s.turnNum !== turnNum);
    this.state.currentTurn = Math.max(0, ...this.state.turns.map(t => t.n || 0));
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    this._saveState();
  }

  _appendMessage(msg) {
    const message = {
      createdAt: Date.now(),
      ...msg,
    };
    message.anchor = rawMessageAnchor(this.meetingId, message.id);
    this.state.messages.push(message);
    return message;
  }

  recordTurnPrompt(turnNum, sid, prompt) {
    if (!this._activePrompts[turnNum]) this._activePrompts[turnNum] = {};
    this._activePrompts[turnNum][sid] = prompt || '';
  }

  buildPrompt({ meeting, members, selfMember, targetMembers, userInput, turnNum }) {
    const recentN = Number.isInteger(meeting && meeting.groupRecentRawN) ? meeting.groupRecentRawN : DEFAULT_RECENT_RAW_N;
    const summaryLedger = this.state.summarySegments.slice(-12).map(seg => {
      return [
        `<summary id="${seg.id}" status="${seg.status}" range="${seg.fromMessageId || '?'}..${seg.toMessageId || '?'}">`,
        _clip(seg.summary || '', MAX_SUMMARY_CHARS),
        `anchors: ${(seg.anchors || []).join(', ') || '-'}`,
        `</summary>`,
      ].join('\n');
    }).join('\n\n') || '(暂无历史摘要)';

    const recentRaw = this.state.messages.slice(-recentN).map(m => {
      return `[${m.anchor}] ${m.speaker || m.role}: ${_clip(m.content || '', MAX_RECENT_RAW_CHARS)}`;
    }).join('\n\n') || '(暂无历史原文)';

    const targetLabels = targetMembers.map(_memberLabel).join(' / ');
    const selfLabel = _memberLabel(selfMember);
    const mode = meeting && meeting.groupMode || 'deliberation';

    return [
      `[AI群聊 · 第 ${turnNum} 轮 · ${mode}]`,
      '',
      '## 群聊规则',
      `- 你是群聊成员: ${selfLabel} (${selfMember.memberId})`,
      `- 本轮发言成员: ${targetLabels}`,
      '- 同一轮的多位 AI 彼此看不到本轮实时输出；你只看见本轮开始前的快照。',
      '- 默认采用知识争鸣风格：给出独立判断、证据、假设、反例或分歧点、下一步可验证问题。',
      '- 不要假装读取了未注入的原文；如需要更早细节，请引用 raw anchor，说明需要打开原文核对。',
      '',
      '## 成员表',
      _memberManifest(members),
      '',
      '## 历史摘要账本',
      summaryLedger,
      '',
      `## 最近 ${recentN} 条原文`,
      recentRaw,
      '',
      '## 当前用户发言',
      userInput || '',
      '',
      '## 输出要求',
      '- 直接回答当前用户问题。',
      '- 如和其他历史观点不同，明确指出分歧依据。',
      '- 如引用历史，请带上相关 raw anchor。',
    ].join('\n');
  }

  completeTurn(turnNum, userInput, results, memberBySid, statsBySid = {}) {
    const by = {};
    const byStatus = {};
    const thinkSecBy = {};
    const tokensBy = {};
    const aiMessages = [];

    for (const r of results) {
      const sid = r.sid;
      const member = memberBySid[sid] || {};
      by[sid] = r.text || '';
      byStatus[sid] = r.status || 'completed';
      thinkSecBy[sid] = statsBySid[sid]?.thinkSec || r.thinkSec || 0;
      tokensBy[sid] = statsBySid[sid]?.tokens || (r.tokens && r.tokens.total) || 0;
      const msg = this._appendMessage({
        id: `a${turnNum}-${member.memberId || sid.slice(0, 8)}`,
        turnNum,
        role: 'assistant',
        sid,
        memberId: member.memberId || sid,
        speaker: _memberLabel(member),
        content: r.text || '',
        status: r.status || 'completed',
      });
      aiMessages.push(msg);

      const prev = this.state.aiStats[sid] || { totalThinkSec: 0, totalTokens: 0, turns: 0 };
      prev.totalThinkSec += thinkSecBy[sid] || 0;
      prev.totalTokens += tokensBy[sid] || 0;
      prev.turns += 1;
      prev.kind = member.kind || prev.kind;
      prev.model = member.model || prev.model;
      this.state.aiStats[sid] = prev;
    }

    const userMessage = this.state.messages.find(m => m.turnNum === turnNum && m.role === 'user') || null;
    const segment = _buildDeterministicSegment({ turnNum, userMessage, aiMessages, meetingId: this.meetingId });
    this.state.summarySegments.push(segment);

    const turn = {
      n: turnNum,
      mode: 'group',
      userInput: userInput || '',
      by,
      byStatus,
      thinkSecBy,
      tokensBy,
      timestamp: Date.now(),
      meta: {
        dispatchMode: 'group',
        summarySegmentId: segment.id,
        rawAnchors: segment.anchors,
      },
    };
    this.state.turns.push(turn);
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    this._saveState();
    return turn;
  }

  searchRaw(query, limit = 20) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return [];
    return this.state.messages
      .filter(m => String(m.content || '').toLowerCase().includes(q))
      .slice(-Math.max(1, limit))
      .map(m => ({
        id: m.id,
        anchor: m.anchor,
        speaker: m.speaker,
        turnNum: m.turnNum,
        snippet: _oneLine(m.content, 240),
      }));
  }

  readRaw(messageId) {
    const id = String(messageId || '').trim();
    return this.state.messages.find(m => m.id === id || m.anchor === id) || null;
  }
}

const _cache = new Map();

function getOrchestrator(hubDataDir, meetingId) {
  const key = `${hubDataDir}::${meetingId}`;
  if (!_cache.has(key)) _cache.set(key, new GroupChatOrchestrator(hubDataDir, meetingId));
  return _cache.get(key);
}

module.exports = {
  getOrchestrator,
  groupChatStatePath,
  rawMessageAnchor,
  _private: { _keywordList, _buildDeterministicSegment },
};
