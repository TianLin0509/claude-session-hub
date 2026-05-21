'use strict';

const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const path = require('path');

function resolveCodexCommand() {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA;
    if (appData) return { command: 'cmd.exe', prefixArgs: ['/c', path.join(appData, 'npm', 'codex.cmd')] };
    return { command: 'cmd.exe', prefixArgs: ['/c', 'codex'] };
  }
  return { command: 'codex', prefixArgs: [] };
}

function jsonPreview(obj) {
  try { return JSON.stringify(obj); } catch { return String(obj); }
}

class CodexAppServerClient extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.sessionId = opts.sessionId;
    this.cwd = opts.cwd || process.cwd();
    this.model = opts.model || 'gpt-5.5';
    this.env = opts.env || process.env;
    this.threadId = null;
    this.currentTurnId = null;
    this.lastText = '';
    this.streamingBuf = [];
    this._lineBuf = '';
    this._inputBuf = '';
    this._nextId = 1;
    this._pending = new Map();
    this._proc = null;
    this._started = false;
    this._closed = false;
  }

  async start() {
    if (this._started) return;
    this._started = true;
    const { command, prefixArgs } = resolveCodexCommand();
    const args = [...prefixArgs, 'app-server', '--listen', 'stdio://'];
    this._emitOutput(`[codex-app] starting: ${[command, ...args].join(' ')}\r\n`);
    this._proc = spawn(command, args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this._proc.stdout.on('data', (chunk) => this._onStdout(chunk));
    this._proc.stderr.on('data', (chunk) => this._emitOutput(`[codex-app:stderr] ${chunk.toString('utf8')}`));
    this._proc.on('error', (err) => {
      this._emitOutput(`[codex-app] spawn failed: ${err.message}\r\n`);
      this.emit('error-event', { hubSessionId: this.sessionId, reason: err.message });
    });
    this._proc.on('exit', (code, signal) => {
      this._closed = true;
      this._emitOutput(`\r\n[codex-app] exited code=${code} signal=${signal || 'none'}\r\n`);
      this.emit('exit', { code, signal });
      for (const { reject } of this._pending.values()) reject(new Error(`codex app-server exited code=${code}`));
      this._pending.clear();
    });

    const init = await this.request('initialize', {
      clientInfo: { name: 'claude-session-hub', title: 'Claude Session Hub', version: '1.0.5' },
      capabilities: { experimentalApi: true },
    });
    this._emitOutput(`[codex-app] initialized ${init.userAgent || ''}\r\n`);
    const threadResp = await this.request('thread/start', {
      cwd: this.cwd,
      model: this.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
      ephemeral: true,
    });
    this.threadId = threadResp && threadResp.thread && threadResp.thread.id;
    this._emitOutput(`[codex-app] thread ${this.threadId || '(unknown)'} ready\r\n\r\n`);
    this.emit('session-bound', {
      hubSessionId: this.sessionId,
      kind: 'codex-app',
      threadId: this.threadId,
    });
  }

  request(method, params) {
    if (!this._proc || !this._proc.stdin || this._closed) {
      return Promise.reject(new Error('codex app-server is not running'));
    }
    const id = this._nextId++;
    const msg = { id, method, params };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, 60_000);
      timer.unref?.();
      this._pending.set(id, { resolve, reject, timer, method });
      this._proc.stdin.write(JSON.stringify(msg) + '\n');
    });
  }

  handleInput(data) {
    if (!data) return;
    for (const ch of String(data)) {
      if (ch === '\r' || ch === '\n') {
        const prompt = this._inputBuf.trim();
        this._inputBuf = '';
        this._emitOutput('\r\n');
        if (prompt) this.submit(prompt).catch((e) => this._emitOutput(`[codex-app] submit failed: ${e.message}\r\n`));
      } else if (ch === '\b' || ch === '\x7f') {
        if (this._inputBuf.length > 0) {
          this._inputBuf = this._inputBuf.slice(0, -1);
          this._emitOutput('\b \b');
        }
      } else {
        this._inputBuf += ch;
        this._emitOutput(ch);
      }
    }
  }

  async submit(text) {
    if (!this.threadId) throw new Error('thread is not ready');
    this.streamingBuf = [];
    this.lastText = '';
    this.emit('prompt-submitted', {
      hubSessionId: this.sessionId,
      text,
      submittedAt: Date.now(),
      signalSource: 'codex_app_turn_start',
    });
    this._emitOutput(`[codex-app] turn/start\r\n`);
    return this.request('turn/start', {
      threadId: this.threadId,
      input: [{ type: 'text', text, text_elements: [] }],
      cwd: this.cwd,
      approvalPolicy: 'never',
      model: this.model,
    });
  }

  getStreamingText() {
    return this.streamingBuf.length ? [...this.streamingBuf] : null;
  }

  getLastAssistantText() {
    return this.lastText || '';
  }

  clearStreamingBuf() {
    this.streamingBuf = [];
  }

  close() {
    this._closed = true;
    try { this._proc?.kill(); } catch {}
  }

  _onStdout(chunk) {
    this._lineBuf += chunk.toString('utf8');
    const lines = this._lineBuf.split(/\r?\n/);
    this._lineBuf = lines.pop() || '';
    for (const line of lines) {
      if (!line.trim()) continue;
      let msg;
      try { msg = JSON.parse(line); }
      catch {
        this._emitOutput(`[codex-app:raw] ${line}\r\n`);
        continue;
      }
      this._handleMessage(msg);
    }
  }

  _handleMessage(msg) {
    if (Object.prototype.hasOwnProperty.call(msg, 'id')) {
      const pending = this._pending.get(msg.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this._pending.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error.message || jsonPreview(msg.error)));
      else pending.resolve(msg.result);
      return;
    }
    if (!msg || !msg.method) return;
    this.emit('notification', msg);
    const p = msg.params || {};
    if (msg.method === 'turn/started') {
      this.currentTurnId = p.turn && p.turn.id;
      this._emitOutput(`[codex-app] turn ${this.currentTurnId || ''} started\r\n`);
      return;
    }
    if (msg.method === 'item/agentMessage/delta') {
      const delta = typeof p.delta === 'string' ? p.delta : '';
      if (!delta) return;
      this.lastText += delta;
      this.streamingBuf.push({ type: 'text', text: delta });
      this._emitOutput(delta);
      return;
    }
    if (msg.method === 'item/reasoning/summaryTextDelta' || msg.method === 'item/reasoning/textDelta') {
      const delta = typeof p.delta === 'string' ? p.delta : '';
      if (delta) this.streamingBuf.push({ type: 'thinking', text: delta });
      return;
    }
    if (msg.method === 'item/completed') {
      const item = p.item || {};
      if (item.type === 'agentMessage' && typeof item.text === 'string') {
        this.lastText = item.text;
      }
      return;
    }
    if (msg.method === 'turn/completed') {
      const turn = p.turn || {};
      const finalText = this._extractAssistantText(turn) || this.lastText;
      if (finalText) this.lastText = finalText;
      this._emitOutput(`\r\n[codex-app] turn completed (${turn.status && turn.status.type || turn.status || 'unknown'})\r\n`);
      this.emit('turn-complete', {
        hubSessionId: this.sessionId,
        text: this.lastText || '',
        completedAt: Date.now(),
        signalSource: 'codex_app_turn_completed',
        threadId: this.threadId,
        turnId: turn.id || this.currentTurnId,
      });
      return;
    }
    if (msg.method === 'error' || msg.method === 'warning' || msg.method === 'configWarning') {
      this._emitOutput(`[codex-app:${msg.method}] ${jsonPreview(p)}\r\n`);
    }
  }

  _extractAssistantText(turn) {
    if (!turn || !Array.isArray(turn.items)) return '';
    const parts = [];
    for (const item of turn.items) {
      if (item && item.type === 'agentMessage' && typeof item.text === 'string' && item.text.trim()) {
        parts.push(item.text.trim());
      }
    }
    return parts.join('\n\n').trim();
  }

  _emitOutput(data) {
    this.emit('output', { sessionId: this.sessionId, data });
  }
}

module.exports = {
  CodexAppServerClient,
};
