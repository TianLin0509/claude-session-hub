'use strict';

const fs = require('fs');
const path = require('path');
const { KIND_LABELS } = require('./ai-kinds.js');

const STATE_VERSION = 2;

function arenaPromptsDir(hubDataDir) {
  return path.join(hubDataDir, 'arena-prompts');
}

function groupChatStatePath(hubDataDir, meetingId) {
  return path.join(arenaPromptsDir(hubDataDir), `${meetingId}-groupchat.json`);
}

function cleanup(hubDataDir, meetingId) {
  const fp = groupChatStatePath(hubDataDir, meetingId);
  try {
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  } catch {}
}

function rawMessageAnchor(meetingId, messageId) {
  return `raw://group/${meetingId}/msg/${messageId}`;
}

function _clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function _memberLabel(member) {
  if (!member) return 'AI';
  return member.displayName || member.alias || KIND_LABELS[member.kind] || member.kind || member.memberId || 'AI';
}

const RESEARCH_SCENE_PROMPT = [
  '## 投研场景',
  '优先补充他人未覆盖的角度、证据缺口或反例。在评价已知材料的基础上，尽量挖掘新线索、变量或解释路径，为讨论带回新信息、方向。涉及股票、板块、消息和近期行情时，尽量查证；事实和数字标来源，未查证就说明不确定。不要只顺着已有倾向，主动指出风险或证伪信号。若信息不足或判断分叉，先问用户 1-2 个会改变结论的问题。',
].join('\n');

function buildSystemPromptText(displayName, scene) {
  const name = displayName || 'AI';
  const parts = [
    '## 规则',
    `- 这里是AI群聊，你是${name}。可赞同、反对、追问、反问用户及其他群聊队友或另起话题。`,
    '- 独到见解 > 全面但泛泛而谈。',
    '',
    '## 输出',
    '简单问题直答；复杂分析 / 多方案 / 含表格 / 预计 > 300 字 -> HTML 三段式（先口头大纲 -> 写 C:\\Users\\lintian\\artifacts\\{msgId}-{name}.html -> 贴绝对路径+3-8 条摘要卡片）。',
  ];
  if (scene === 'research') {
    parts.push('', RESEARCH_SCENE_PROMPT);
  }
  return parts.join('\n');
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
      lastDeliveredIdx: {},
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
        const { summarySegments, ...rest } = raw;
        this.state = {
          schemaVersion: STATE_VERSION,
          currentMode: 'idle',
          turns: [],
          aiStats: {},
          ...rest,
          meetingId: this.meetingId,
          messages: Array.isArray(raw.messages) ? raw.messages : [],
          lastDeliveredIdx: raw.lastDeliveredIdx && typeof raw.lastDeliveredIdx === 'object' ? raw.lastDeliveredIdx : {},
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
    const lastIdx = this.state.messages.length - 1;
    for (const sid of Object.keys(this.state.lastDeliveredIdx || {})) {
      if (this.state.lastDeliveredIdx[sid] > lastIdx) this.state.lastDeliveredIdx[sid] = lastIdx;
    }
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

  getActivePrompt(turnNum) {
    const promptBy = this._activePrompts[turnNum];
    return promptBy ? { promptBy } : null;
  }

  setSendStatus(_turnNum, _sid, _status) {
    // Group chat keeps transient send state in renderer partials; this method
    // preserves the shared watcher recovery contract.
  }

  buildDelta(selfSid, userInput) {
    const lastIdx = this.state.lastDeliveredIdx[selfSid] ?? -1;
    const cutoff = this.state.messages.length - 1;
    const newMsgs = this.state.messages
      .slice(lastIdx + 1, cutoff)
      .filter(m => m.sid !== selfSid && m.content);
    const parts = [];
    if (newMsgs.length > 0) {
      parts.push('## 新增发言\n' + newMsgs.map(m => `${m.speaker}：${m.content}`).join('\n\n'));
    }
    parts.push('## 用户\n' + (userInput || ''));
    parts.push('请发言。');
    return parts.join('\n\n');
  }

  buildFirstDelta(selfSid, userInput, systemPromptText) {
    if (this.state.lastDeliveredIdx[selfSid] === undefined) {
      return String(systemPromptText || '') + '\n\n' + this.buildDelta(selfSid, userInput);
    }
    return this.buildDelta(selfSid, userInput);
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
      },
    };
    this.state.turns.push(turn);
    this.state.currentMode = 'idle';
    delete this._activePrompts[turnNum];
    const lastIdx = this.state.messages.length - 1;
    for (const r of results) {
      this.state.lastDeliveredIdx[r.sid] = Number.isInteger(r.deliveredIdx) ? r.deliveredIdx : lastIdx;
    }
    this._saveState();
    return turn;
  }

  patchTurnResult(turnNum, sid, { text, status, thinkSec, tokens } = {}) {
    const turn = this.state.turns.find(t => t.n === turnNum);
    if (!turn) return null;
    turn.by = turn.by || {};
    turn.byStatus = turn.byStatus || {};
    turn.thinkSecBy = turn.thinkSecBy || {};
    turn.tokensBy = turn.tokensBy || {};
    if (status === 'completed' || status === 'manual_extracted') {
      turn.by[sid] = text || '';
    }
    turn.byStatus[sid] = status || 'completed';
    if (typeof thinkSec === 'number') turn.thinkSecBy[sid] = thinkSec;
    if (tokens && typeof tokens.total === 'number') turn.tokensBy[sid] = tokens.total;
    turn.lastPatchedAt = Date.now();

    const msg = this.state.messages.find(m => m.turnNum === turnNum && m.role === 'assistant' && m.sid === sid);
    if (msg) {
      if (status === 'completed' || status === 'manual_extracted') msg.content = text || '';
      msg.status = status || msg.status || 'completed';
      msg.patchedAt = turn.lastPatchedAt;
    }

    this._saveState();
    return _clone(turn);
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
        snippet: String(m.content || '').replace(/\s+/g, ' ').trim(),
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
  cleanup,
  rawMessageAnchor,
  buildSystemPromptText,
  _private: { buildSystemPromptText, RESEARCH_SCENE_PROMPT },
};
