'use strict';

const { EventEmitter } = require('events');
const fs = require('fs');
const os = require('os');
const path = require('path');

function normalizePathForCompare(value) {
  if (!value || typeof value !== 'string') return '';
  let normalized = path.resolve(value).replace(/\\/g, '/');
  if (normalized.length > 3 && normalized.endsWith('/')) normalized = normalized.slice(0, -1);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function inputText(input) {
  if (!Array.isArray(input)) return '';
  return input
    .filter((part) => part && part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
}

function messageText(message) {
  return inputText(message && message.content);
}

function recordTimeMs(record) {
  const raw = record && (record.timestamp || record.time || record.createdAt || record.created_at);
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw < 1e12 ? raw * 1000 : raw;
  if (typeof raw === 'string') {
    const parsed = Date.parse(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Date.now();
}

function isToolFinishReason(reason) {
  const normalized = String(reason || '').toLowerCase();
  return normalized === 'tool_calls' || normalized === 'tool_call' || normalized === 'tool_use';
}

function parseJsonl(text) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try { records.push(JSON.parse(line)); } catch {}
  }
  return records;
}

function extractLatestKimiTurnFromText(text) {
  const state = {
    turnText: '',
    steps: new Map(),
    latest: null,
  };
  for (const record of parseJsonl(text)) {
    if (record.type === 'turn.prompt') {
      state.turnText = '';
      state.steps.clear();
      continue;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) continue;
    const event = record.event;
    if (event.type === 'step.begin') {
      state.steps.set(event.uuid || `${event.turnId || ''}:${event.step || ''}`, { text: '', hadTool: false });
      continue;
    }
    const stepKey = event.stepUuid || event.uuid || `${event.turnId || ''}:${event.step || ''}`;
    const step = state.steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      state.steps.set(stepKey, step);
      continue;
    }
    if (event.type === 'tool.call') {
      step.hadTool = true;
      state.steps.set(stepKey, step);
      continue;
    }
    if (event.type !== 'step.end') continue;
    const ended = state.steps.get(event.uuid || stepKey) || step;
    if (ended.text) state.turnText += ended.text;
    if (isToolFinishReason(event.finishReason) || ended.hadTool) continue;
    const completedText = (ended.text || state.turnText).trim();
    if (completedText) {
      state.latest = {
        text: completedText,
        source: 'kimi_wire_step_end',
        completedAt: recordTimeMs(record),
      };
    }
  }
  return state.latest;
}

class KimiTap extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.homeDir = opts.homeDir || process.env.KIMI_CODE_HOME || path.join(os.homedir(), '.kimi-code');
    this.indexPath = path.join(this.homeDir, 'session_index.jsonl');
    this.pollMs = Math.max(50, Number(opts.pollMs) || 350);
    this._pending = new Map();
    this._bound = new Map();
    this._claimedSids = new Set();
    this._timer = null;
  }

  hasSession(hubSessionId) {
    return this._pending.has(hubSessionId) || this._bound.has(hubSessionId);
  }

  registerSession(hubSessionId, ctx = {}) {
    if (!hubSessionId) return;
    this.unregisterSession(hubSessionId);
    const entries = this._readIndex();
    const pending = {
      hubSessionId,
      kind: ctx.kind || 'kimi',
      cwd: normalizePathForCompare(ctx.cwd || os.homedir()),
      registeredAt: Number(ctx.registeredAt) || Date.now(),
      kimiSid: ctx.kimiSid || null,
      allowExistingSession: !!ctx.allowExistingSession,
      knownSids: new Set(entries.map((entry) => entry.sessionId).filter(Boolean)),
    };

    if (ctx.transcriptPath || ctx.sessionDir) {
      const wirePath = ctx.transcriptPath || path.join(ctx.sessionDir, 'agents', 'main', 'wire.jsonl');
      const sessionDir = ctx.sessionDir || path.dirname(path.dirname(path.dirname(wirePath)));
      this._bind(pending, {
        sessionId: pending.kimiSid || path.basename(sessionDir),
        sessionDir,
        workDir: ctx.cwd || '',
      }, wirePath, true);
    } else {
      this._pending.set(hubSessionId, pending);
      this._scanIndex(entries);
    }
    this._ensureTimer();
  }

  notePrompt() {}

  unregisterSession(hubSessionId) {
    this._pending.delete(hubSessionId);
    const bound = this._bound.get(hubSessionId);
    if (bound && bound.kimiSid) this._claimedSids.delete(bound.kimiSid);
    this._bound.delete(hubSessionId);
    if (this._pending.size === 0 && this._bound.size === 0) this._stopTimer();
  }

  dispose() {
    this._pending.clear();
    this._bound.clear();
    this._claimedSids.clear();
    this._stopTimer();
  }

  getLastAssistantText(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    return bound && bound.lastAssistantText ? bound.lastAssistantText : null;
  }

  getStreamingText(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    if (!bound || !bound.streamingText) return null;
    return [{ type: 'text', text: bound.streamingText }];
  }

  clearStreamingBuf(hubSessionId) {
    const bound = this._bound.get(hubSessionId);
    if (bound) bound.streamingText = '';
  }

  async extractLatestTurn(hubSessionId, sincePromptTs = 0) {
    const bound = this._bound.get(hubSessionId);
    if (!bound || !bound.wirePath) return null;
    try {
      const turn = extractLatestKimiTurnFromText(fs.readFileSync(bound.wirePath, 'utf8'));
      // 2026-07-20 道雪 [修#1]：时间窗下界——turn 完成时间早于本轮 prompt 5s 以上，
      //   判定为上一轮旧答案拒绝提取（与 ClaudeTap 同口径，防张冠李戴）。
      if (turn && sincePromptTs && turn.completedAt && turn.completedAt < sincePromptTs - 5000) return null;
      return turn;
    } catch {
      return null;
    }
  }

  getDebugSnapshot() {
    return {
      homeDir: this.homeDir,
      pending: Array.from(this._pending.values()).map((entry) => ({
        hubSessionId: entry.hubSessionId,
        cwd: entry.cwd,
        kimiSid: entry.kimiSid,
      })),
      bound: Array.from(this._bound.values()).map((entry) => ({
        hubSessionId: entry.hubSessionId,
        kimiSid: entry.kimiSid,
        wirePath: entry.wirePath,
        offset: entry.offset,
      })),
    };
  }

  _ensureTimer() {
    if (this._timer) return;
    this._timer = setInterval(() => this._poll(), this.pollMs);
    this._timer.unref?.();
  }

  _stopTimer() {
    if (!this._timer) return;
    clearInterval(this._timer);
    this._timer = null;
  }

  _poll() {
    try { this._scanIndex(this._readIndex()); } catch {}
    for (const bound of this._bound.values()) {
      try { this._readWire(bound); } catch {}
    }
  }

  _readIndex() {
    let text;
    try { text = fs.readFileSync(this.indexPath, 'utf8'); } catch { return []; }
    const bySid = new Map();
    for (const record of parseJsonl(text)) {
      if (!record || typeof record.sessionId !== 'string' || typeof record.sessionDir !== 'string') continue;
      const sessionDir = path.isAbsolute(record.sessionDir)
        ? record.sessionDir
        : path.resolve(this.homeDir, record.sessionDir);
      bySid.set(record.sessionId, { ...record, sessionDir });
    }
    return Array.from(bySid.values());
  }

  _scanIndex(entries) {
    for (const pending of Array.from(this._pending.values())) {
      let candidates = entries.filter((entry) => {
        if (!entry.sessionId || this._claimedSids.has(entry.sessionId)) return false;
        if (pending.kimiSid) return entry.sessionId === pending.kimiSid;
        return normalizePathForCompare(entry.workDir) === pending.cwd;
      });
      if (!pending.kimiSid && !pending.allowExistingSession) {
        candidates = candidates.filter((entry) => !pending.knownSids.has(entry.sessionId));
      }
      if (pending.allowExistingSession && !pending.kimiSid) {
        candidates = candidates.filter((entry) => this._wireMtime(entry) >= pending.registeredAt - 2000);
      }
      candidates.sort((a, b) => this._wireMtime(b) - this._wireMtime(a));
      const selected = candidates[0];
      if (!selected) continue;
      const startAtEnd = pending.allowExistingSession || pending.knownSids.has(selected.sessionId);
      this._bind(pending, selected, null, startAtEnd);
    }
  }

  _wireMtime(entry) {
    const wirePath = path.join(entry.sessionDir, 'agents', 'main', 'wire.jsonl');
    try { return fs.statSync(wirePath).mtimeMs; } catch { return 0; }
  }

  _bind(pending, nativeSession, explicitWirePath, startAtEnd) {
    const wirePath = explicitWirePath || path.join(nativeSession.sessionDir, 'agents', 'main', 'wire.jsonl');
    let offset = 0;
    if (startAtEnd) {
      try { offset = fs.statSync(wirePath).size; } catch {}
    }
    const bound = {
      hubSessionId: pending.hubSessionId,
      kind: pending.kind,
      kimiSid: nativeSession.sessionId,
      sessionDir: nativeSession.sessionDir,
      wirePath,
      offset,
      partial: '',
      turnText: '',
      currentPrompt: '',
      lastUserText: '',
      steps: new Map(),
      completedSteps: new Set(),
      streamingText: '',
      lastAssistantText: '',
    };
    this._pending.delete(pending.hubSessionId);
    this._bound.set(pending.hubSessionId, bound);
    if (bound.kimiSid) this._claimedSids.add(bound.kimiSid);
    this.emit('session-bound', {
      hubSessionId: bound.hubSessionId,
      kind: 'kimi',
      kimiSid: bound.kimiSid,
      sessionDir: bound.sessionDir,
      wirePath: bound.wirePath,
    });
    this._readWire(bound);
  }

  _readWire(bound) {
    let stat;
    try { stat = fs.statSync(bound.wirePath); } catch { return; }
    if (stat.size < bound.offset) {
      bound.offset = 0;
      bound.partial = '';
    }
    if (stat.size === bound.offset) return;
    const length = stat.size - bound.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(bound.wirePath, 'r');
    try { fs.readSync(fd, buffer, 0, length, bound.offset); }
    finally { fs.closeSync(fd); }
    bound.offset = stat.size;
    const combined = bound.partial + buffer.toString('utf8');
    const lines = combined.split(/\r?\n/);
    bound.partial = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      this._processRecord(bound, record);
    }
  }

  _processRecord(bound, record) {
    if (record.type === 'context.append_message' && record.message) {
      if (record.message.role === 'user') bound.lastUserText = messageText(record.message);
      return;
    }
    if (record.type === 'turn.prompt') {
      bound.turnText = '';
      bound.steps.clear();
      bound.completedSteps.clear();
      bound.streamingText = '';
      bound.currentPrompt = inputText(record.input) || bound.lastUserText || '';
      if (bound.currentPrompt && (!record.origin || record.origin.kind === 'user')) {
        this.emit('prompt-submitted', {
          hubSessionId: bound.hubSessionId,
          text: bound.currentPrompt,
          submittedAt: recordTimeMs(record),
          transcriptPath: bound.wirePath,
          signalSource: 'kimi_wire_turn_prompt',
        });
      }
      return;
    }
    if (record.type !== 'context.append_loop_event' || !record.event) return;
    const event = record.event;
    const fallbackStepKey = `${event.turnId || ''}:${event.step || ''}`;
    if (event.type === 'step.begin') {
      bound.steps.set(event.uuid || fallbackStepKey, { text: '', hadTool: false });
      bound.streamingText = '';
      return;
    }
    const stepKey = event.stepUuid || event.uuid || fallbackStepKey;
    const step = bound.steps.get(stepKey) || { text: '', hadTool: false };
    if (event.type === 'content.part' && event.part && event.part.type === 'text' && typeof event.part.text === 'string') {
      step.text += event.part.text;
      bound.steps.set(stepKey, step);
      bound.streamingText = step.text;
      return;
    }
    if (event.type === 'tool.call') {
      step.hadTool = true;
      bound.steps.set(stepKey, step);
      return;
    }
    if (event.type !== 'step.end') return;
    const endedKey = event.uuid || stepKey;
    if (bound.completedSteps.has(endedKey)) return;
    bound.completedSteps.add(endedKey);
    const ended = bound.steps.get(endedKey) || bound.steps.get(stepKey) || step;
    if (ended.text) bound.turnText += ended.text;
    if (isToolFinishReason(event.finishReason) || ended.hadTool) {
      bound.streamingText = '';
      return;
    }
    const text = (ended.text || bound.turnText).trim();
    if (!text) return;
    bound.lastAssistantText = text;
    bound.streamingText = text;
    this.emit('turn-complete', {
      hubSessionId: bound.hubSessionId,
      text,
      source: 'kimi_wire_step_end',
      completedAt: recordTimeMs(record),
      transcriptPath: bound.wirePath,
    });
  }
}

module.exports = {
  KimiTap,
  extractLatestKimiTurnFromText,
  normalizePathForCompare,
};
