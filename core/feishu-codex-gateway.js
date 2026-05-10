'use strict';

const path = require('path');
const os = require('os');
const { cleanCodexOutput, stripAnsi } = require('./feishu-output-cleaner.js');

const NEW_CODEX_RE = /^(?:新建|创建|启动)\s*codex\s*[：:]\s*([\s\S]+)$/i;
const STATUS_RE = /^(?:状态|status)$/i;
const RECENT_RE = /^(?:最近输出|recent|tail)$/i;
const STOP_RE = /^(?:停止|stop|中断)$/i;

function normalizeText(text) {
  return String(text || '').replace(/\r\n/g, '\n').trim();
}

function tailText(text, maxChars = 1200) {
  const clean = cleanCodexOutput(text, maxChars);
  if (!clean) return '';
  return clean.length > maxChars ? clean.slice(clean.length - maxChars) : clean;
}

function parseCommand(text) {
  const normalized = normalizeText(text);
  const newMatch = normalized.match(NEW_CODEX_RE);
  if (newMatch) return { type: 'new-codex', prompt: newMatch[1].trim() };
  if (STATUS_RE.test(normalized)) return { type: 'status' };
  if (RECENT_RE.test(normalized)) return { type: 'recent' };
  if (STOP_RE.test(normalized)) return { type: 'stop' };
  if (normalized) return { type: 'input', prompt: normalized };
  return { type: 'empty' };
}

function threadKey(evt) {
  return String(evt.threadId || evt.messageId || evt.chatId || '').trim();
}

class FeishuCodexGateway {
  constructor({
    sessionManager,
    sendMessage,
    defaultCwd,
    startupDelayMs = 6000,
    inputEnterDelayMs = 400,
    outputDebounceMs = 2500,
    onSessionCreated = null,
    getCleanOutput = null,
    transcriptTap = null,
    reportPublisher = null,
    now = () => Date.now(),
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  }) {
    if (!sessionManager) throw new Error('sessionManager is required');
    this.sessionManager = sessionManager;
    this.sendMessage = typeof sendMessage === 'function' ? sendMessage : async () => {};
    this.defaultCwd = defaultCwd || process.cwd() || os.homedir();
    this.startupDelayMs = startupDelayMs;
    this.inputEnterDelayMs = inputEnterDelayMs;
    this.outputDebounceMs = outputDebounceMs;
    this.onSessionCreated = typeof onSessionCreated === 'function' ? onSessionCreated : null;
    this.getCleanOutput = typeof getCleanOutput === 'function' ? getCleanOutput : null;
    this.transcriptTap = transcriptTap || null;
    this.reportPublisher = reportPublisher || null;
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.bindings = new Map(); // threadKey -> binding
    this.targets = new Map(); // threadKey -> latest Feishu reply target
    this.sessionToThread = new Map(); // sessionId -> threadKey
    this.pendingTimers = new Set();
    this.outputBuckets = new Map();
    this.lastDigestBySession = new Map();

    this._onOutput = (evt) => this._handleOutput(evt);
    this._onToolUse = (evt) => this._handleToolUse(evt);
    this._onSessionUpdated = (session) => this._handleSessionUpdated(session);
    this._onTranscriptComplete = (evt) => this._handleTranscriptComplete(evt);

    if (typeof sessionManager.on === 'function') {
      sessionManager.on('output', this._onOutput);
      sessionManager.on('tool-use-preview', this._onToolUse);
      sessionManager.on('session-updated', this._onSessionUpdated);
    }
    if (this.transcriptTap && typeof this.transcriptTap.on === 'function') {
      this.transcriptTap.on('turn-complete', this._onTranscriptComplete);
    }
  }

  async handleIncoming(evt) {
    const key = threadKey(evt);
    if (!key) return { ok: false, reason: 'missing-thread-key' };
    this.targets.set(key, {
      chatId: evt.chatId || null,
      threadId: evt.threadId || null,
      messageId: evt.messageId || null,
      senderId: evt.senderId || null,
    });
    const text = normalizeText(evt.text);
    const command = parseCommand(text);

    if (command.type === 'empty') {
      await this._send(key, { type: 'error', text: '收到空消息，未写入 Codex。' });
      return { ok: false, reason: 'empty-text' };
    }
    if (command.type === 'new-codex') return this._startCodex(key, command.prompt, evt);

    const binding = this.bindings.get(key);
    if (!binding) {
      await this._send(key, {
        type: 'help',
        text: '当前飞书 thread 还没有绑定 Codex session。请先发送：新建 codex：你的任务',
      });
      return { ok: false, reason: 'not-bound' };
    }

    if (command.type === 'status') return this._sendStatus(key, binding);
    if (command.type === 'recent') return this._sendRecent(key, binding);
    if (command.type === 'stop') return this._stopSession(key, binding);
    if (command.type === 'input') return this._sendInput(key, binding, command.prompt);
    return { ok: false, reason: 'unknown-command' };
  }

  getBinding(key) {
    return this.bindings.get(key);
  }

  dispose() {
    for (const timer of this.pendingTimers) this.clearTimer(timer);
    this.pendingTimers.clear();
    for (const bucket of this.outputBuckets.values()) {
      if (bucket.timer) this.clearTimer(bucket.timer);
    }
    this.outputBuckets.clear();
    if (typeof this.sessionManager.off === 'function') {
      this.sessionManager.off('output', this._onOutput);
      this.sessionManager.off('tool-use-preview', this._onToolUse);
      this.sessionManager.off('session-updated', this._onSessionUpdated);
    }
    if (this.transcriptTap && typeof this.transcriptTap.off === 'function') {
      this.transcriptTap.off('turn-complete', this._onTranscriptComplete);
    }
  }

  async _startCodex(key, prompt, evt) {
    const title = this._titleFromPrompt(prompt);
    const cwd = this._resolveCwd(evt.cwd);
    const session = this.sessionManager.createSession('codex', {
      title,
      cwd,
      codexBypassApprovals: true,
    });
    if (this.onSessionCreated) {
      try { this.onSessionCreated(session); } catch {}
    }
    const binding = {
      key,
      chatId: evt.chatId || null,
      threadId: evt.threadId || null,
      messageId: evt.messageId || null,
      sessionId: session.id,
      title,
      cwd,
      createdAt: this.now(),
      updatedAt: this.now(),
      pendingInitialPrompt: prompt,
    };
    this.bindings.set(key, binding);
    this.sessionToThread.set(session.id, key);

    await this._send(key, {
      type: 'session-started',
      text: `已创建 Codex session：${title}\n工作目录：${cwd}\n后续在本 thread 里发消息，会继续写入该 session。`,
      session,
    });

    const timer = this.setTimer(() => {
      this.pendingTimers.delete(timer);
      const current = this.bindings.get(key);
      if (!current || current.sessionId !== session.id) return;
      this._writePromptToSession(session.id, prompt);
      current.pendingInitialPrompt = null;
      current.updatedAt = this.now();
      this._send(key, {
        type: 'input-sent',
        text: '初始任务已写入 Codex，等待输出。',
        sessionId: session.id,
      });
    }, this.startupDelayMs);
    this.pendingTimers.add(timer);

    return { ok: true, action: 'new-codex', sessionId: session.id, threadKey: key };
  }

  async _sendInput(key, binding, prompt) {
    this._writePromptToSession(binding.sessionId, prompt);
    binding.updatedAt = this.now();
    await this._send(key, {
      type: 'input-sent',
      text: '已写入 Codex。你可以发送“状态”或“最近输出”查看进展。',
      sessionId: binding.sessionId,
    });
    return { ok: true, action: 'input', sessionId: binding.sessionId };
  }

  async _sendStatus(key, binding) {
    const session = this._getSession(binding.sessionId);
    const status = session ? (session.status || 'active') : 'missing';
    const preview = session && session.lastOutputPreview ? `\n最近预览：${session.lastOutputPreview}` : '';
    await this._send(key, {
      type: 'status',
      text: `Codex session 状态：${status}\n标题：${binding.title}\n工作目录：${binding.cwd}${preview}`,
      session,
    });
    return { ok: true, action: 'status', sessionId: binding.sessionId };
  }

  async _sendRecent(key, binding) {
    const tapped = this._getCleanSessionOutput(binding.sessionId, 1800);
    const buf = typeof this.sessionManager.getSessionBuffer === 'function'
      ? this.sessionManager.getSessionBuffer(binding.sessionId)
      : '';
    const recent = tapped || tailText(buf, 1800) || 'No readable Codex output yet.';
    await this._send(key, {
      type: 'recent-output',
      text: `最近输出：\n${recent}`,
      sessionId: binding.sessionId,
      source: tapped ? 'transcript' : 'pty-filter',
    });
    return { ok: true, action: 'recent', sessionId: binding.sessionId };
  }

  async _stopSession(key, binding) {
    if (typeof this.sessionManager.closeSession === 'function') {
      this.sessionManager.closeSession(binding.sessionId);
    }
    this.bindings.delete(key);
    this.sessionToThread.delete(binding.sessionId);
    await this._send(key, {
      type: 'session-stopped',
      text: `已请求停止 Codex session：${binding.title}`,
      sessionId: binding.sessionId,
    });
    return { ok: true, action: 'stop', sessionId: binding.sessionId };
  }

  _handleOutput(evt) {
    if (!evt || !evt.sessionId) return;
    const key = this.sessionToThread.get(evt.sessionId);
    if (!key) return;
    if (this._hasTranscriptCompletionSource()) return;
    const chunk = stripAnsi(evt.data || '').trim();
    if (!chunk) return;
    const bucket = this.outputBuckets.get(evt.sessionId) || { text: '', timer: null };
    bucket.text = tailText((bucket.text ? bucket.text + '\n' : '') + chunk, 900);
    if (bucket.timer) this.clearTimer(bucket.timer);
    bucket.timer = this.setTimer(() => {
      this.outputBuckets.delete(evt.sessionId);
      const tapped = this._getCleanSessionOutput(evt.sessionId, 1600);
      const clean = tapped || cleanCodexOutput(bucket.text, 1000);
      if (!clean) return;
      this._sendOutputDigest(key, evt.sessionId, clean, tapped ? 'transcript' : 'pty-filter');
    }, this.outputDebounceMs);
    this.outputBuckets.set(evt.sessionId, bucket);
  }

  _handleToolUse(evt) {
    if (!evt || !evt.sessionId) return;
    const key = this.sessionToThread.get(evt.sessionId);
    if (!key) return;
    const toolName = evt.toolName || 'tool';
    const toolInput = evt.toolInput == null
      ? ''
      : (typeof evt.toolInput === 'string' ? evt.toolInput : JSON.stringify(evt.toolInput, null, 2));
    this._send(key, {
      type: 'approval',
      text: `Codex 请求工具审批：${toolName}\n${toolInput}\n\n回复“1”允许一次，回复“2”拒绝。`,
      sessionId: evt.sessionId,
      toolName,
      toolInput: evt.toolInput,
    });
  }

  _handleTranscriptComplete(evt) {
    if (!evt || !evt.hubSessionId) return;
    const key = this.sessionToThread.get(evt.hubSessionId);
    if (!key) return;
    const clean = cleanCodexOutput(evt.text || '', 1800);
    if (!clean) return;
    this._sendOutputDigest(key, evt.hubSessionId, clean, 'transcript');
  }

  _handleSessionUpdated(session) {
    if (!session || !session.id) return;
    const key = this.sessionToThread.get(session.id);
    if (!key) return;
    const binding = this.bindings.get(key);
    if (binding) binding.updatedAt = this.now();
  }

  _writePromptToSession(sessionId, prompt) {
    this.sessionManager.writeToSession(sessionId, prompt);
    const timer = this.setTimer(() => {
      this.pendingTimers.delete(timer);
      this.sessionManager.writeToSession(sessionId, '\r');
    }, this.inputEnterDelayMs);
    this.pendingTimers.add(timer);
  }

  _getSession(sessionId) {
    if (typeof this.sessionManager.getSession === 'function') {
      return this.sessionManager.getSession(sessionId);
    }
    if (typeof this.sessionManager.listSessions === 'function') {
      return this.sessionManager.listSessions().find(s => s.id === sessionId);
    }
    return null;
  }

  _getCleanSessionOutput(sessionId, maxChars = 1600) {
    if (!this.getCleanOutput) return '';
    let text = '';
    try { text = this.getCleanOutput(sessionId); } catch { text = ''; }
    return cleanCodexOutput(text || '', maxChars);
  }

  _hasTranscriptCompletionSource() {
    return !!(this.transcriptTap && typeof this.transcriptTap.on === 'function');
  }

  _sendOutputDigest(key, sessionId, text, source) {
    let clean = cleanCodexOutput(text, 1800);
    if (!clean) return Promise.resolve();
    const links = this._publishReportLinks(clean);
    const reportFiles = links
      .filter(link => link && link.sourcePath)
      .map(link => ({
        path: link.sourcePath,
        name: link.name,
        type: link.type,
      }));
    if (links.length) {
      clean += '\n\n---\n手机查看报告：\n' + links
        .map(link => `- [打开 ${link.type === 'md' ? 'Markdown' : 'HTML'}：${link.name}](${link.url})`)
        .join('\n');
    }
    if (this.lastDigestBySession.get(sessionId) === clean) return Promise.resolve();
    this.lastDigestBySession.set(sessionId, clean);
    return this._send(key, {
      type: 'output-digest',
      text: clean,
      sessionId,
      source,
      reportFiles,
    });
  }

  _publishReportLinks(text) {
    if (!this.reportPublisher || typeof this.reportPublisher.publishLinksFromText !== 'function') return [];
    try {
      return this.reportPublisher.publishLinksFromText(text).filter(link => link && link.url);
    } catch {
      return [];
    }
  }

  _send(key, payload) {
    const binding = this.bindings.get(key);
    const target = binding || this.targets.get(key) || {};
    return Promise.resolve(this.sendMessage({
      threadKey: key,
      chatId: target.chatId || null,
      threadId: target.threadId || null,
      messageId: target.messageId || null,
      replyToMessageId: target.messageId || null,
      ...payload,
    }));
  }

  _titleFromPrompt(prompt) {
    const oneLine = normalizeText(prompt).replace(/\s+/g, ' ');
    return 'Feishu Codex - ' + (oneLine.length > 24 ? oneLine.slice(0, 24) + '...' : oneLine || 'Task');
  }

  _resolveCwd(cwd) {
    if (!cwd) return this.defaultCwd;
    return path.resolve(String(cwd));
  }
}

module.exports = {
  FeishuCodexGateway,
  parseCommand,
  stripAnsi,
  tailText,
  cleanCodexOutput,
};
