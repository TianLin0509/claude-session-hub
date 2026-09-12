'use strict';
const { EventEmitter } = require('events');
const { randomUUID, createHash } = require('crypto');
const { ClaudeStreamClient, protocolError } = require('../main/claude-stream-client');
const { claudeTranscriptTurns } = require('./claude-native-transcript');
const { findNativeClaudeHistory, processExists, renameNativeClaudeHistory } = require('./claude-native-history');
const ownership = require('./native-session-ownership');
const { ClaudeNativeActivities } = require('./claude-native-activities');

const BACKEND = 'claude-stream-json';
const TERMINAL = new Set(['completed', 'failed', 'interrupted']);
const DELEGATED = new Set(['local_agent', 'local_workflow']);
const TASK_TERMINAL = new Set(['completed', 'failed', 'stopped', 'killed', 'cancelled']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Measured against Claude Code 2.1.269: `/effort banana` answers "Valid options
// are: low, medium, high, xhigh, max, ultracode, auto". The --effort launch flag
// accepts only the first five, so only those are written back to the args.
const EFFORT_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'auto']);
const EFFORT_LAUNCH_LEVELS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function contentBlocks(text, attachments = []) {
  if (typeof text !== 'string') throw new TypeError('Claude prompt must be one string');
  const content = [{ type: 'text', text }];
  for (const item of attachments) {
    if (item.type !== 'image' || !item.source || !['base64', 'url'].includes(item.source.type)) {
      throw new Error('Unsupported Claude attachment; expected an SDK image source');
    }
    content.push({ type: 'image', source: { ...item.source } });
  }
  return content;
}
function canonicalContent(content) {
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(content) { return createHash('sha256').update(JSON.stringify(stable(canonicalContent(content)))).digest('hex'); }
function textOf(content) {
  if (typeof content === 'string') return content;
  return (content || []).filter(block => block.type === 'text').map(block => block.text).join('');
}
// The backstage pane is a terminal: model text arrives as plain newlines and an
// escape sequence from a tool result must never be able to drive the emulator.
// Same contract the Codex native session uses for its own backstage output.
function sanitizeTerminal(text) {
  return String(text || '').replace(/\x1b/g, '').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');
}

function initialRuntime(sessionId, previous) {
  return { state: 'unknown', connection: 'connecting', epoch: (previous?.epoch || 0) + 1, revision: 0,
    providerSessionId: sessionId, turnId: null, userMessageId: null, ownerPid: process.pid, childPid: null,
    startedAt: 0, completedAt: 0, requests: [], waitingFlags: [], submission: null, queued: [],
    reason: previous && !TERMINAL.has(previous.state) && previous.state !== 'idle'
      ? '上次 Claude 提交状态需要核对' : '正在连接 Claude' };
}

class ClaudeNativeSession extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.sessionId = options.resumeSessionId && !options.fork ? options.resumeSessionId : options.sessionId || randomUUID();
    if (!UUID.test(this.sessionId) || (options.resumeSessionId && !UUID.test(options.resumeSessionId))) {
      throw new Error('Claude resume/new session requires an exact UUID');
    }
    this.runtime = initialRuntime(this.sessionId, options.restoredRuntime);
    this.unreconciled = !!options.restoredRuntime && !TERMINAL.has(options.restoredRuntime.state)
      && options.restoredRuntime.state !== 'idle';
    this.records = new Map();
    for (const saved of options.restoredRecords || []) {
      if (saved.providerSessionId !== this.sessionId) throw new Error('Stored submission belongs to a different Claude session');
      if (digest(saved.content) !== saved.promptFingerprint) throw new Error('Stored Claude submission content is corrupted');
      const savedStatus = saved.status || saved.sendStatus;
      const terminal = TERMINAL.has(savedStatus);
      const status = terminal ? savedStatus : 'unknown';
      this.records.set(saved.submissionId, { ...saved, fingerprint: saved.promptFingerprint, status,
        accepted: saved.accepted === true || terminal, started: terminal, durable: true,
        messages: new Map((saved.transcriptMessages || []).map(frame => [frame.uuid || frame.message?.id, frame])),
        resolve() {}, reject() {}, ack: Promise.resolve(null) });
      if (!terminal && !saved.reconciliation) this.unreconciled = true;
    }
    if (this.records.size && [...this.records.values()].every(record => TERMINAL.has(record.status) || record.reconciliation)) {
      this.unreconciled = false;
    }
    this.queue = [];
    this.active = null;
    this.seen = new Set();
    this.tasks = new Map();
    this.activities = new ClaudeNativeActivities(options);
    this.activities.recoverTasks(options.restoredRuntime?.backgroundTasks || [], this.runtime.epoch - 1, false);
    for (const record of this.records.values()) this.activities.rememberTools(record);
    if (this.activities.pending().length) this.unreconciled = true;
    this.completedResultIds = new Set([...this.records.values(), ...this.activities.records.values()]
      .map(record => record.providerResultId || record.resultId).filter(Boolean));
    this.foregroundState = 'idle';
    this.items = new Map();
    this.closed = false;
    this.closePromise = null;
    this.ready = null;
    this.client = null;
    this.configurationChange = null;
    this.reconnecting = false;
    this.reconnectPending = false;
    this.recoveryReady = false;
    if (this.unreconciled) this.runtime.reason = '上次 Claude 提交状态需要核对；不会自动重发';
  }

  get pid() { return this.client?.proc?.pid || null; }
  onData(fn) { this.on('data', fn); return { dispose: () => this.off('data', fn) }; }
  print(text) { this.emit('data', sanitizeTerminal(text).replace(/\r?\n/g, '\r\n')); }
  onExit(fn) { this.on('exit', fn); return { dispose: () => this.off('exit', fn) }; }
  resize() {}
  kill() {
    this.close().catch(error => this.emit('action-error', error.message));
  }
  write() { throw new Error('Claude native sessions accept structured prompts, not terminal input'); }
  transcript(options = {}) {
    const records = [...this.records.values(), ...this.activities.records.values()].sort((a, b) => a.createdAt - b.createdAt);
    return claudeTranscriptTurns(options.tailRecords ? records.slice(-options.tailRecords) : records);
  }

  historyExclusions() {
    const excludeEntryIds = []; const excludeMessageIds = [];
    for (const record of [...this.records.values(), ...this.activities.records.values()]) {
      excludeEntryIds.push(record.userMessageId);
      for (const frame of [...(record.messages?.values() || []), ...(record.streams?.values() || [])]) {
        if (frame.uuid) excludeEntryIds.push(frame.uuid);
        if (frame.message?.id) excludeMessageIds.push(frame.message.id);
      }
    }
    return { excludeEntryIds, excludeMessageIds };
  }

  // The echo proves the engine received exactly this submission. A slash command
  // is the one case where it legitimately differs: the engine answers with its
  // own <command-name> envelope, so verify the command identity instead of the
  // bytes rather than weakening the check for ordinary prompts.
  echoMatches(message, record) {
    if (digest(message.message.content) === record.fingerprint) return true;
    if (!record.commandName) return false;
    const echoed = /<command-name>\s*([^<]+?)\s*<\/command-name>/.exec(textOf(message.message.content));
    if (!echoed) return false;
    const normalize = value => String(value).trim().replace(/^\//, '').toLowerCase();
    return normalize(echoed[1]) === normalize(record.commandName);
  }

  update(patch) {
    const backgroundTasks = [...this.tasks.values()];
    const backgroundActivities = this.activities?.pending().map(r => ({ id: r.userMessageId, origin: r.origin, state: r.status })) || [];
    if (['completed', 'failed', 'interrupted', 'idle'].includes(patch.state)) this.foregroundState = patch.state;
    if (!this.active && !this.unreconciled && this.runtime.connection === 'connected'
        && patch.connection !== 'disconnected') {
      const busy = backgroundTasks.some(task => DELEGATED.has(task.type)) || backgroundActivities.length;
      const requests = patch.requests || this.runtime.requests;
      patch = { ...patch, state: requests.length ? 'waiting' : busy ? 'running' : this.foregroundState,
        ...(busy && !requests.length ? { reason: 'Claude 后台活动仍在进行；用户回合已单独结算' } : {}) };
    }
    this.runtime = { ...this.runtime, ...patch, recoveryReady: this.recoveryReady,
      backgroundTasks, backgroundActivities,
      revision: this.runtime.revision + 1, observedAt: Date.now(),
      queued: this.queue.map(record => ({ submissionId: record.submissionId, userMessageId: record.userMessageId })) };
    this.emit('state', this.runtime);
  }

  receipt(record) {
    return { ok: !['rejected', 'unknown', 'content-mismatch'].includes(record.status),
      sendStatus: record.status, source: BACKEND, submissionId: record.submissionId,
      clientSubmissionId: record.submissionId, providerSessionId: this.sessionId,
      userMessageId: record.userMessageId, providerTurnId: null, promptFingerprint: record.fingerprint };
  }

  lifecycle(type, record, extra = {}, beforeEmit = null) {
    const event = { type, hubSessionId: this.options.id, kind: this.options.kind || 'claude',
      signalSource: BACKEND, providerSessionId: this.sessionId, ccSessionId: this.sessionId,
      // Hub's turn key is explicitly the input UUID, not an invented provider turn ID.
      turnId: record?.userMessageId || null, providerTurnId: null,
      userMessageId: record?.userMessageId || null, clientSubmissionId: record?.submissionId || null,
      promptFingerprint: record?.fingerprint || null, ...extra };
    if (this.options.persistLifecycle) {
      const saved = this.options.persistLifecycle(event);
      if (saved && typeof saved.then === 'function') throw new Error('persistLifecycle must durably save synchronously before emitting');
    }
    if (beforeEmit) beforeEmit();
    this.emit('lifecycle', event);
  }

  start() {
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }

  async _start() {
    const previous = this.options.restoredRuntime;
    const oldHubAlive = previous && previous.ownerPid !== process.pid && processExists(previous.ownerPid);
    const oldChildAlive = previous && previous.ownerPid !== process.pid && processExists(previous.childPid);
    if (oldChildAlive || (!this.options.ownership && oldHubAlive)) {
      throw protocolError('旧 Claude 写入进程仍存活，请先在原 Hub 结束该会话再恢复', 'CLAUDE_WRITER_ACTIVE');
    }
    const launchArgs = [...(this.options.launchArgs || [])];
    if (this.options.ownership) {
      let proof;
      try { proof = await ownership.assertNoOtherHubOwner(this.options, this.sessionId); }
      catch (error) { if (error.nativeDraft) this.emit('migration-draft', error.nativeDraft); throw error; }
      if (oldHubAlive && !proof?.checkedPids.includes(previous.ownerPid)) {
        throw protocolError('无法核对旧 Hub 是否已释放此 Claude 会话', 'CLAUDE_WRITER_ACTIVE');
      }
      if (this.closed) throw protocolError('Claude startup was cancelled before ownership', 'CLAUDE_CLOSED');
      this.lease = ownership.claimThread(this.options, this.sessionId, null);
    }
    if (this.options.resumeSessionId) {
      launchArgs.push('--resume', this.options.resumeSessionId);
      if (this.options.fork) launchArgs.push('--fork-session', '--session-id', this.sessionId);
    } else launchArgs.push('--session-id', this.sessionId);
    try {
      this.client = this.options.clientFactory
        ? this.options.clientFactory({ ...this.options, launchArgs })
        : new ClaudeStreamClient({ ...this.options, launchArgs });
    } catch (error) {
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      throw error;
    }
    const client = this.client;
    const current = () => this.client === client && !this.reconnecting;
    client.on('disconnect', error => { if (current()) this.disconnect(error); });
    client.on('diagnostic', event => { if (current()) this.emit('diagnostic', event); });
    // Unexpected child exits keep the logical session recoverable. Explicit
    // closure publishes its own single exit after the child and lease drain.
    client.on('exit', event => { if (current() && !this.closed) this.emit('exit', event); });
    client.on('message', message => {
      if (!current()) return;
      try { this.message(message); }
      catch (error) { this.disconnect(protocolError('Claude message handler: ' + error.message)); }
    });
    client.on('request', request => { if (current()) this.request(request); });
    client.on('request-cancelled', id => {
      if (!current()) return;
      const requests = this.runtime.requests.filter(r => r.id !== id);
      this.update({ requests, state: this.unreconciled ? 'unknown' : requests.length ? 'waiting'
        : this.active?.accepted ? 'running' : this.runtime.state });
    });
    try {
      const starting = this.client.start();
      // Bind the exact spawned child before awaiting the protocol handshake.
      starting.catch(() => undefined);
      if (this.lease && this.pid) ownership.bindServerPid(this.lease, this.pid);
      await starting;
    } catch (error) {
      await this.client.close();
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      throw error;
    }
    if (this.closed) throw protocolError('Claude session closed during startup', 'CLAUDE_CLOSED');
    for (const activity of this.activities.pending()) this.activities.save(activity);
    // The engine reports whether Fast is actually serving this session and why
    // not. That is the only honest source for the speed chip: the launch
    // overlay is a request, and a subscription or model can refuse it.
    const initialization = this.client.initialization || {};
    this.update({ connection: 'connected', childPid: this.pid,
      fastMode: initialization.fast_mode_state === 'on',
      fastModeBlocked: initialization.fast_mode_disabled_reason || null,
      permissionMode: initialization.current_permission_mode || this.runtime.permissionMode || null,
      state: this.unreconciled ? 'unknown' : this.runtime.requests.length ? 'waiting' : 'idle',
      reason: this.unreconciled ? '上次 Claude 提交状态需要核对；不会自动重发' : null });
    this.print('\nClaude 已连接。请使用 Hub 输入框发送消息；本页显示引擎原始输出。\n');
    this.refreshContext().catch(error => this.emit('action-error', '上下文用量读取失败：' + error.message));
    return this.runtime;
  }

  async submit(text, options = {}) {
    const content = contentBlocks(text, options.attachments);
    await this.start();
    if (this.configurationChange) await this.configurationChange;
    if (this.reconnectPending || this.reconnecting) throw protocolError('Claude 正在重连', 'CLAUDE_RECONNECTING');
    if (this.closed || this.client.failure) throw this.client.failure || protocolError('Claude session closed', 'CLAUDE_CLOSED');
    if (this.unreconciled) throw protocolError('Claude submission requires reconciliation', 'CLAUDE_SUBMISSION_UNKNOWN');
    const submissionId = options.clientSubmissionId || options.submissionId || randomUUID();
    const fingerprint = digest(content);
    const existing = this.records.get(submissionId);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw protocolError('Submission ID reused with different content', 'CLAUDE_CONTENT_MISMATCH');
      return this.receipt(existing);
    }
    const record = { submissionId, userMessageId: randomUUID(), fingerprint, content, text,
      status: 'queued', createdAt: Date.now(), accepted: false, started: false, finalText: '',
      metadata: options.metadata || null, delegated: false,
      // The engine rewrites a command echo into its own envelope, so the echo
      // check below verifies the command name instead of the exact bytes.
      commandName: options.localCommand === true ? String(text).trim().split(/\s/)[0] : null };
    record.ack = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
    // Queued callers get a visible queued receipt; eventual errors are also emitted.
    record.ack.catch(() => undefined);
    this.records.set(submissionId, record);
    this.queue.push(record);
    this.update({});
    try {
      if (this.options.persistSubmission) await this.options.persistSubmission({ ...this.receipt(record),
        text, content, metadata: record.metadata, createdAt: record.createdAt });
      record.durable = true;
    } catch (error) {
      this.queue = this.queue.filter(item => item !== record);
      record.status = 'rejected'; record.reject(error);
      this.update(this.active ? {} : { state: 'failed', reason: '无法保存 Claude 提交记录：' + error.message,
        submission: this.receipt(record) });
      this.emit('action-error', error.message);
      throw error;
    }
    if (this.closed) throw protocolError('Claude session closed while saving submission', 'CLAUDE_CLOSED');
    if (record.cancelled) {
      this.cancelBeforeSend(record);
      return record.ack;
    }
    const busy = !!this.active || this.activities.pending().length > 0 || this.queue[0] !== record;
    this.pump().catch(error => this.disconnect(error));
    return busy ? this.receipt(record) : record.ack;
  }

  async pump() {
    if (this.active || this.activities.pending().length || this.closed || this.unreconciled || this.reconnectPending || this.client.failure || !this.queue[0]?.durable) return;
    const record = this.queue.shift();
    this.active = record;
    record.status = 'submitting';
    this.update({ state: 'unknown', reason: '等待 Claude 确认本条输入', turnId: record.userMessageId,
      userMessageId: record.userMessageId, submission: this.receipt(record), requests: [], startedAt: 0, completedAt: 0 });
    // Integration must persist this identity before handing bytes to the engine.
    try {
      if (this.options.persistSubmission) await this.options.persistSubmission({ ...this.receipt(record),
        text: record.text, content: record.content, metadata: record.metadata, createdAt: record.createdAt });
    } catch (error) {
      record.status = 'rejected'; record.reject(error); this.active = null;
      this.update({ state: 'failed', reason: '无法保存 Claude 提交记录：' + error.message, submission: this.receipt(record) });
      this.emit('action-error', error.message);
      // Do not advance following work across a failed persistence boundary.
      this.unreconciled = true;
      return;
    }
    if (this.closed) { record.reject(protocolError('Session closed before submission', 'CLAUDE_CLOSED')); return; }
    if (record.cancelled) {
      this.cancelBeforeSend(record);
      this.pump().catch(error => this.disconnect(error));
      return;
    }
    record.timer = setTimeout(() => {
      if (record.accepted || this.active !== record) return;
      this.disconnect(protocolError('Claude 未确认本条输入，提交状态待核对', 'CLAUDE_SUBMISSION_TIMEOUT'));
    }, this.options.submissionTimeoutMs || 15000);
    try {
      record.writeStarted = true;
      await this.client.write({ type: 'user', uuid: record.userMessageId, session_id: this.sessionId,
        parent_tool_use_id: null, message: { role: 'user', content: record.content }, origin: { kind: 'human' } });
    } catch (error) { this.disconnect(error); }
  }

  cancelBeforeSend(record) {
    this.lifecycle('submission-cancelled', record, { status: 'interrupted', accepted: false }, () => {
      this.queue = this.queue.filter(item => item !== record);
      if (this.active === record) this.active = null;
      record.status = 'interrupted';
      this.update({ state: 'interrupted', reason: '消息在发送前已取消', completedAt: Date.now(), submission: this.receipt(record) });
    });
    record.reject(protocolError('Claude submission cancelled before transmission', 'CLAUDE_SUBMISSION_CANCELLED'));
  }

  disconnect(error) {
    if (this.closed) return;
    this.print('\n[连接中断] ' + (error && error.message || '') + '\n');
    this.unreconciled = true;
    const record = this.active;
    if (record) {
      clearTimeout(record.timer);
      if (!TERMINAL.has(record.status)) record.status = 'unknown';
      record.reject(error);
    }
    this.update({ connection: this.client?.failure ? 'disconnected' : this.runtime.connection,
      state: 'unknown', requests: [], reason: error.message,
      submission: record ? this.receipt(record) : this.runtime.submission });
    this.emit('action-error', error.message);
  }

  message(message) {
    if (this.closed) return;
    if (message.session_id && message.session_id !== this.sessionId) {
      this.emit('diagnostic', { type: 'foreign-session', sessionId: message.session_id }); return;
    }
    if (message.type === 'result' && message.uuid && this.completedResultIds.has(message.uuid)) return;
    const identity = message.uuid && message.type + ':' + message.uuid;
    if (identity && this.seen.has(identity)) return;
    if (identity) {
      this.seen.add(identity);
      if (this.seen.size > 4096) this.seen.delete(this.seen.values().next().value);
    }
    const record = this.active;
    const outputOwner = this.activities.owner(message, record);
    const isToolResult = message.type === 'user' && Array.isArray(message.message?.content)
      && message.message.content.some(block => block.type === 'tool_result');
    if (isToolResult) {
      if (outputOwner && !this.unreconciled) {
        this.activities.capture(outputOwner, message);
        this.persistLateOutput(outputOwner);
        this.emit('item', { message, userMessageId: outputOwner.userMessageId });
      }
      else this.emit('diagnostic', { type: 'unassociated-tool-result', messageId: message.uuid });
      return;
    }
    if (message.type === 'user' && !message.parent_tool_use_id && message.message?.role === 'user') {
      if (message.origin?.kind && message.origin.kind !== 'human') {
        this.activities.deferSegment();
        const activity = this.activities.begin(message);
        this.update({});
        this.emit('item', { message, userMessageId: activity.userMessageId });
        return;
      }
      if (!record || message.uuid !== record.userMessageId) {
        this.emit('diagnostic', { type: 'unmatched-user', userMessageId: message.uuid }); return;
      }
      if (!this.echoMatches(message, record)) {
        this.disconnect(protocolError('Claude 回显正文与本次提交不同', 'CLAUDE_CONTENT_MISMATCH'));
        record.status = 'content-mismatch';
        this.update({ submission: this.receipt(record) }); return;
      }
      clearTimeout(record.timer);
      record.accepted = true; record.status = 'accepted'; record.acceptedAt = Date.now();
      this.lifecycle('submission-accepted', record, { status: 'accepted', accepted: true, acceptedAt: record.acceptedAt }, () => {
        this.update({ state: 'starting', submission: this.receipt(record), reason: 'Claude 已收到输入，等待执行' });
      });
      record.resolve(this.receipt(record));
      return;
    }
    if (message.type === 'system') {
      if (message.subtype === 'init') {
        this.update({ actualModel: message.model, capabilities: {
          tools: message.tools || [], commands: message.slash_commands || [], mcpServers: message.mcp_servers || [] } });
      }
      if (message.subtype === 'task_started' && message.task_id) {
        const owner = this.activities.toolOwners.get(message.tool_use_id) || outputOwner;
        this.tasks.set(message.task_id, { id: message.task_id, type: message.task_type,
          submissionId: owner?.submissionId || null, userMessageId: owner?.userMessageId || null });
      } else if (message.subtype === 'task_notification'
          || (message.subtype === 'task_updated' && TASK_TERMINAL.has(message.patch?.status))) {
        this.tasks.delete(message.task_id);
      }
      this.update({});
      this.emit('item', { message, userMessageId: record?.userMessageId || null });
      return;
    }
    if (message.type === 'result') {
      const origin = message.origin?.kind || 'human';
      if (origin !== 'human') {
        if (!message.session_id || this.unreconciled) return;
        const activity = this.activities.finish(message);
        if (message.uuid) this.completedResultIds.add(message.uuid);
        this.update({ requests: this.runtime.requests.filter(r => r.activityId !== activity.userMessageId) });
        this.emit('item', { message, userMessageId: activity.userMessageId });
        this.emit('diagnostic', { type: 'background-result', resultId: message.uuid, origin });
        this.pump().catch(error => this.disconnect(error));
        return;
      }
      if (!record || !record.accepted || this.unreconciled || !message.session_id) {
        this.emit('diagnostic', { type: 'unmatched-result', resultId: message.uuid }); return;
      }
      this.activities.resolveSegment(record);
      this.finish(record, message); return;
    }
    if (!outputOwner || (!outputOwner.nativeActivity && !outputOwner.accepted) || this.unreconciled) {
      this.emit('diagnostic', { type: 'unassociated-event', messageType: message.type }); return;
    }
    if (message.type === 'assistant' || message.type === 'stream_event') {
      this.activities.capture(outputOwner, message);
      if (message.type === 'assistant') this.persistLateOutput(outputOwner);
      if (outputOwner === record && !record.started && !message.parent_tool_use_id && !this.activities.ambiguous) {
        record.started = true;
        record.startedAt = Date.now();
        this.update({ state: this.runtime.requests.length ? 'waiting' : 'running', startedAt: record.startedAt, reason: null });
        this.lifecycle('agent-turn-started', record, { status: 'running', accepted: true, startedAt: record.startedAt });
      }
      if (message.type === 'assistant') {
        this.items.set(message.message?.id || message.uuid, message);
        if (typeof message.message?.model === 'string' && message.message.model) outputOwner.model = message.message.model;
        // A slash command is executed by the engine itself and answered with a
        // local_command_source frame instead of a model reply. Keep that output
        // separate so the composer can report it as a command result.
        if (typeof message.local_command_source === 'string') {
          outputOwner.localCommand = true;
          const rendered = textOf(message.message?.content) || message.local_command_source;
          outputOwner.commandOutput = outputOwner.commandOutput ? outputOwner.commandOutput + '\n' + rendered : rendered;
        }
        if (!message.parent_tool_use_id && !this.activities.ambiguous) outputOwner.finalText = textOf(message.message?.content);
      }
      const delta = message.type === 'stream_event' && message.event?.delta?.type === 'text_delta'
        ? message.event.delta.text : null;
      if (delta) this.print(delta);
      this.emit('item', { message, userMessageId: outputOwner.userMessageId });
    } else this.emit('diagnostic', { type: 'unsupported-event', messageType: message.type });
  }

  finish(record, message) {
    clearTimeout(record.timer);
    const interrupted = ['aborted_streaming', 'aborted_tools'].includes(message.terminal_reason);
    const failed = message.is_error === true || message.subtype !== 'success';
    const status = interrupted ? 'interrupted' : failed ? 'failed' : 'completed';
    const completedAt = Date.now();
    record.resultId = message.uuid;
    record.finalText = typeof message.result === 'string' ? message.result : record.finalText;
    // The engine reports this turn's tokens on the result frame; the cards
    // showed them for every Claude turn before the native transport.
    if (message.usage && typeof message.usage === 'object') record.usage = message.usage;
    const reason = failed ? (message.errors?.join('; ') || message.result || message.subtype) : null;
    this.lifecycle('agent-turn-complete', record, { status, text: record.finalText,
      accepted: true, completedAt, transcriptMessages: [...(record.messages?.values() || [])],
      providerResultId: message.uuid, result: message }, () => {
      record.status = status;
      record.completedAt = completedAt;
      if (message.uuid) this.completedResultIds.add(message.uuid);
      this.active = null;
      this.update({ state: status, completedAt,
        requests: this.runtime.requests.filter(r => r.submissionId !== record.submissionId), reason,
        submission: this.receipt(record), resultId: message.uuid });
    });
    if (this.options.historyTitle) {
      try { this.rename(this.options.historyTitle); }
      catch (error) { this.emit('action-error', 'Hub 名称已保存；Claude 历史同步失败：' + error.message); }
    }
    this.refreshContext().catch(error => this.emit('action-error', '上下文用量读取失败：' + error.message));
    this.pump().catch(error => this.disconnect(error));
  }

  persistLateOutput(record) {
    if (!TERMINAL.has(record.status)) return;
    if (record.nativeActivity) this.activities.save(record);
    else this.lifecycle('transcript-updated', record, { status: record.status, text: record.finalText,
      transcriptMessages: [...(record.messages?.values() || [])] });
  }

  request(message) {
    const r = message.request;
    if (r.subtype !== 'can_use_tool') {
      const reason = 'Hub 尚未支持 Claude 控制请求：' + r.subtype;
      this.emit('action-error', reason);
      this.client.respond(message.request_id, null, reason).catch(error => this.disconnect(error));
      return;
    }
    const owner = this.activities.toolOwners.get(r.tool_use_id) || this.activities.current || this.active;
    const request = { id: message.request_id, submissionId: owner?.submissionId || null,
      activityId: owner?.nativeActivity ? owner.userMessageId : null,
      epoch: this.runtime.epoch, method: r.tool_name === 'AskUserQuestion'
      ? 'claude/requestUserInput' : 'claude/requestApproval', params: { ...r.input,
        toolName: r.tool_name, toolUseId: r.tool_use_id, suggestions: r.permission_suggestions }, raw: r };
    this.update({ state: 'waiting', requests: [...this.runtime.requests, request], reason: null });
  }

  async respond(requestId, decision, identity = null) {
    const request = this.runtime.requests.find(r => r.id === requestId);
    if (!request) throw protocolError('Claude request no longer active', 'CLAUDE_STALE_REQUEST');
    if (identity && (identity.epoch !== request.epoch || identity.submissionId !== request.submissionId)) {
      throw protocolError('Claude request belongs to a different turn or connection', 'CLAUDE_STALE_REQUEST');
    }
    if (!decision || !['allow', 'deny'].includes(decision.behavior)) throw new Error('Explicit allow/deny decision required');
    const response = decision.behavior === 'deny' ? { behavior: 'deny', message: decision.message || '用户拒绝' }
      : { behavior: 'allow', updatedInput: decision.updatedInput || request.raw.input };
    if (decision.updatedPermissions) response.updatedPermissions = decision.updatedPermissions;
    await this.client.respond(requestId, response);
    const requests = this.runtime.requests.filter(r => r.id !== requestId);
    const stillOwnsTurn = request.epoch === this.runtime.epoch && request.submissionId === (this.active?.submissionId || null);
    this.update({ requests, ...(stillOwnsTurn ? { state: this.unreconciled ? 'unknown'
      : requests.length ? 'waiting' : this.active?.accepted ? 'running' : this.runtime.state } : {}) });
  }

  async interrupt() {
    if (this.runtime.connection === 'connecting' && this.client) {
      await this.close();
      this.update({ state: 'interrupted', connection: 'disconnected', requests: [], reason: 'Claude 启动已取消' });
      return { requested: true, cancelledStartup: true };
    }
    await this.start();
    const pending = this.active || this.queue[0];
    if (pending && !pending.writeStarted) {
      pending.cancelled = true;
      return { requested: true, cancelledBeforeSend: true };
    }
    if (!this.active && !this.runtime.requests.length && !this.activities.pending().length && !this.tasks.size) {
      return { interrupted: false, reason: 'idle' };
    }
    // Stopping a foreground query does not stop previously delegated agents.
    // Request every known task explicitly; only lifecycle frames remove them.
    for (const task of this.tasks.values()) await this.client.control({ subtype: 'stop_task', task_id: task.id });
    await this.client.control({ subtype: 'interrupt' });
    return { requested: true }; // Only the terminal_reason confirms interruption.
  }

  async setModel(model) {
    await this.start();
    if (this.active || this.queue.length || this.activities.pending().length || [...this.tasks.values()].some(task => DELEGATED.has(task.type))
        || this.unreconciled || this.configurationChange || this.reconnectPending) {
      throw new Error('请等待当前任务和模型设置结束并核对提交状态后切换模型');
    }
    const pending = this.client.control({ subtype: 'set_model', model });
    this.configurationChange = pending;
    try {
      await pending;
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--model');
      if (index >= 0) args[index + 1] = model; else args.push('--model', model);
      this.options = { ...this.options, launchArgs: args };
      this.update({ actualModel: model });
    } finally {
      if (this.configurationChange === pending) this.configurationChange = null;
    }
  }

  // Fast is Claude's equivalent of the Codex speed tier.  apply_flag_settings
  // merges it into the engine's flag-settings layer, which is exactly the layer
  // --settings populates, so the switch stays scoped to this session instead of
  // writing the user's settings files the way /fast and update_settings do.
  // Only the control response confirms it; a rejection is surfaced, never
  // reported as a successful switch.
  // Slash commands. Measured on Claude Code 2.1.269: the engine executes its own
  // commands when they arrive as ordinary user text and answers with a
  // local_command_source frame, no model call. So the Hub forwards them instead
  // of hand-mapping a short list, and only intercepts the three whose result it
  // also displays -- model, speed and working mode would otherwise drift out of
  // sync with the chips.
  async slash(text) {
    const line = String(text).trim();
    const space = line.search(/\s/);
    const command = (space < 0 ? line : line.slice(0, space)).toLowerCase();
    const value = space < 0 ? '' : line.slice(space).trim();
    const done = output => ({ ok: true, sendStatus: 'ok', mode: 'native-command',
      commandOutput: String(output || ''), enterAttempts: 0, acknowledgementSource: BACKEND });
    if (command === '/plan' && (!value || value === 'off')) {
      const mode = value === 'off' ? 'default' : 'plan';
      const applied = await this.setPermissionMode(mode);
      return done('工作方式：' + (applied.permissionMode === 'plan' ? '计划（只讨论不改文件）' : '默认') + '。');
    }
    if (command === '/model' && value) {
      await this.setModel(value);
      return done('模型已切换：' + value);
    }
    if (command === '/fast' && ['on', 'off'].includes(value)) {
      const applied = await this.setFastMode(value === 'on');
      return done('速度：' + (applied.fastMode ? 'Fast' : '标准') + (applied.warning ? ' · ' + applied.warning : ''));
    }
    // Everything else is the engine's own command. Wait for its result so the
    // composer reports the real output rather than "sent".
    const receipt = await this.submit(line, { localCommand: true });
    const record = this.records.get(receipt.clientSubmissionId);
    if (!record) return done('');
    await record.ack;
    const deadline = Date.now() + (this.options.commandTimeoutMs || 120000);
    while (!TERMINAL.has(record.status) && Date.now() < deadline && !this.closed) {
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    if (!TERMINAL.has(record.status)) {
      // Never claim an unconfirmed command succeeded; the card still shows it.
      return { ok: false, sendStatus: 'stuck', mode: 'native-command', enterAttempts: 0,
        message: '命令已发出，但引擎尚未返回结果；请看卡片或后台' };
    }
    if (record.status !== 'completed') {
      throw new Error('命令未完成：' + record.status);
    }
    return done(record.commandOutput || record.finalText || '命令已执行。');
  }

  // Thinking effort. The engine owns this as its own command, and answers an
  // unsupported level with an ordinary command message rather than an error --
  // so the reply is checked before the chip is allowed to move.
  async setEffort(level) {
    const normalized = String(level || '').trim().toLowerCase();
    if (!EFFORT_LEVELS.has(normalized)) throw new Error('思考档无效：' + level);
    const result = await this.slash('/effort ' + normalized);
    const output = String(result.commandOutput || '');
    if (!new RegExp('set effort level to ' + normalized + '(?![a-z])', 'i').test(output)) {
      throw new Error(output.trim().slice(0, 200) || '引擎未确认思考档切换');
    }
    if (EFFORT_LAUNCH_LEVELS.has(normalized)) {
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--effort');
      if (index >= 0) args[index + 1] = normalized; else args.push('--effort', normalized);
      this.options = { ...this.options, launchArgs: args };
    }
    this.update({ effort: normalized });
    return { effort: normalized, output };
  }

  // Codex exposes plan mode as a collaboration mode; Claude's equivalent is the
  // permission mode, which the engine accepts mid-session and echoes back. The
  // echoed value is what gets stored -- a requested mode is not a confirmed one.
  async setPermissionMode(mode) {
    await this.start();
    if (this.active || this.queue.length || this.configurationChange || this.reconnectPending || this.unreconciled) {
      throw new Error('请等当前任务结束并核对提交状态后再切换工作方式');
    }
    const pending = this.client.control({ subtype: 'set_permission_mode', mode });
    this.configurationChange = pending;
    try {
      const applied = (await pending)?.mode || mode;
      const args = [...(this.options.launchArgs || [])];
      const index = args.indexOf('--permission-mode');
      if (index >= 0) args[index + 1] = applied; else args.push('--permission-mode', applied);
      this.options = { ...this.options, launchArgs: args };
      this.update({ permissionMode: applied });
      return { permissionMode: applied };
    } finally {
      if (this.configurationChange === pending) this.configurationChange = null;
    }
  }

  async setFastMode(enabled) {
    if (typeof enabled !== 'boolean') throw new Error('速度设置无效');
    await this.start();
    if (this.active || this.queue.length || this.configurationChange || this.reconnectPending || this.unreconciled) {
      throw new Error('请等当前任务和配置切换结束并核对提交状态后再切换速度');
    }
    const pending = this.client.control({ subtype: 'apply_flag_settings', settings: { fastMode: enabled } });
    this.configurationChange = pending;
    try {
      await pending;
      // Durability is best effort and must not claim the engine failed: the
      // tier is already live.  A failed overlay write is reported as a warning
      // so the next relaunch is not silently different from what the UI shows.
      let overlayWarning = null;
      if (this.options.settingsFile) {
        try { require('./claude-native-launch').mergeClaudeSettingsFile(this.options.settingsFile, { fastMode: enabled }); }
        catch (error) { overlayWarning = '速度已生效，但重连后可能回到启动时的设置：' + error.message; }
      }
      this.options = { ...this.options, fastMode: enabled };
      this.update({ fastMode: enabled, fastModeBlocked: null });
      return { fastMode: enabled, ...(overlayWarning ? { warning: overlayWarning } : {}) };
    } finally {
      if (this.configurationChange === pending) this.configurationChange = null;
    }
  }

  // Account quota, read from the engine rather than the status line (see
  // core/claude-native-usage.js). Returns null when this connection cannot
  // answer, so a caller falls back instead of publishing an invented figure.
  async readAccountUsage() {
    if (this.closed || this.runtime.connection !== 'connected' || !this.client) return null;
    const client = this.client;
    const response = await client.control({ subtype: 'get_usage' });
    if (this.client !== client || this.closed) return null;
    return require('./claude-native-usage').claudeAccountUsageFromControl(response);
  }

  historyPath() { return findNativeClaudeHistory(this.sessionId, this.options); }

  async refreshContext() {
    const client = this.client;
    const epoch = this.runtime.epoch;
    const userMessageId = this.runtime.userMessageId;
    try {
      const usage = await client.control({ subtype: 'get_context_usage' });
      if (this.closed || this.client !== client || this.runtime.epoch !== epoch || this.runtime.userMessageId !== userMessageId) return;
      if (![usage.totalTokens, usage.maxTokens, usage.percentage].every(Number.isFinite)
          || usage.totalTokens < 0 || usage.maxTokens <= 0) throw new Error('Claude 返回的上下文用量无效');
      this.emit('usage', usage);
      return usage;
    } catch (error) {
      if (this.closed || this.client !== client || this.runtime.epoch !== epoch || this.runtime.userMessageId !== userMessageId) return;
      throw error;
    }
  }

  rename(title) {
    const result = renameNativeClaudeHistory(this.sessionId, title, this.options);
    this.options.historyTitle = result.status === 'deferred' ? title : null;
    return result;
  }

  recoveryRecords() {
    const submissions = [...this.records.values()].filter(record => !TERMINAL.has(record.status) && !record.reconciliation)
      .map(record => ({ submissionId: record.submissionId, userMessageId: record.userMessageId,
        promptFingerprint: record.fingerprint, text: record.text, content: record.content,
        status: record.status, accepted: record.accepted, epoch: this.runtime.epoch }));
    return submissions.concat(this.activities.pending().map(record => ({ activityId: record.userMessageId,
      userMessageId: record.userMessageId, promptFingerprint: digest(record.content || ''),
      nativeActivity: true, text: 'Claude 后台活动，原状态：' + record.status,
      status: record.status, epoch: this.runtime.epoch })));
  }

  async reconnect({ stopActive = false } = {}) {
    if (this.reconnectPending) throw new Error('Claude 正在重连');
    this.reconnectPending = true;
    try { return await this._reconnect({ stopActive }); }
    finally { this.reconnectPending = false; }
  }

  async _reconnect({ stopActive = false } = {}) {
    if (this.reconnecting) throw new Error('Claude 正在重连');
    const priorClose = this.closePromise;
    if (priorClose) await priorClose;
    const busy = this.active || this.activities.pending().length || this.tasks.size;
    if (stopActive && busy && !this.unreconciled) await this.interrupt();
    if (!stopActive && !this.unreconciled && busy) throw new Error('请先停止当前任务，再重连');
    this.reconnecting = true; this.recoveryReady = false;
    this.unreconciled = true;
    const old = this.client;
    try {
      // End only this owned writer before a new connection may send anything.
      if (old) await old.close();
      if (this.closePromise !== priorClose) throw protocolError('Claude session closed during reconnect', 'CLAUDE_CLOSED');
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      for (const record of this.records.values()) {
        clearTimeout(record.timer);
        if (!TERMINAL.has(record.status) && !record.reconciliation) {
          record.status = 'unknown';
          record.reject(protocolError('Claude 已重连；旧提交须核对，不会自动重发', 'CLAUDE_SUBMISSION_UNKNOWN'));
        }
      }
      this.activities.recoverTasks(this.tasks.values(), this.runtime.epoch);
      this.queue = []; this.active = null; this.seen.clear(); this.tasks.clear();
      this.activities.reset();
      this.runtime = initialRuntime(this.sessionId, this.runtime);
      this.options = { ...this.options, restoredRuntime: null, fork: false,
        resumeSessionId: this.historyPath() ? this.sessionId : undefined };
      this.client = null; this.ready = null; this.closed = false; this.closePromise = null;
      this.unreconciled = this.recoveryRecords().length > 0;
      this.reconnecting = false;
      await this.start();
      this.recoveryReady = true;
      this.update({});
      return this.runtime;
    } catch (error) {
      this.reconnecting = false;
      this.update({ state: 'unknown', connection: 'disconnected', reason: error.message });
      throw error;
    }
  }

  reconcile(identity) {
    const record = identity.activityId ? this.activities.records.get(identity.activityId) : this.records.get(identity.submissionId);
    const fingerprint = record?.nativeActivity ? digest(record.content || '') : record?.fingerprint;
    if (!this.recoveryReady || this.runtime.connection !== 'connected' || this.reconnecting
        || !record || TERMINAL.has(record.status) || record.reconciliation
        || identity.epoch !== this.runtime.epoch || identity.userMessageId !== record.userMessageId
        || identity.promptFingerprint !== fingerprint || identity.resolution !== 'do-not-replay') {
      throw protocolError('核对信息已变化，请重新查看本条记录', 'CLAUDE_STALE_RECONCILIATION');
    }
    const reconciliation = { source: 'user', resolution: identity.resolution, at: Date.now(), epoch: identity.epoch };
    if (record.nativeActivity) {
      this.activities.save({ ...record, status: 'unknown', reconciliation });
      Object.assign(record, { status: 'unknown', reconciliation });
      this.unreconciled = this.recoveryRecords().length > 0;
      this.update({ state: this.unreconciled ? 'unknown' : 'idle', reason: this.unreconciled ? '还有旧活动需要核对' : null });
      return { ok: true, activityId: record.userMessageId, sendStatus: 'unknown' };
    }
    // Administrative acknowledgement never invents a successful engine result.
    this.lifecycle('submission-reconciled', record, { status: 'unknown', reconciliation }, () => {
      record.reconciliation = reconciliation;
      this.unreconciled = this.recoveryRecords().length > 0;
      this.update({ state: this.unreconciled ? 'unknown' : 'idle',
        reason: this.unreconciled ? '还有旧提交需要核对' : '已核对旧提交，不会自动重发', submission: null });
    });
    return this.receipt(record);
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = Promise.resolve().then(async () => {
      for (const record of this.records.values()) {
        clearTimeout(record.timer);
        if (record.status === 'queued' || record.status === 'submitting') record.reject(protocolError('Claude session closed', 'CLAUDE_CLOSED'));
      }
      if (this.client) await this.client.close();
      if (this.lease) { ownership.releaseThread(this.lease); this.lease = null; }
      // A shutdown waiter may attach after the child already crashed (or
      // before startup). Do not wait for another impossible OS exit event.
      // This is resource closure only; unknown submissions retain their state.
      this.emit('exit', { exitCode: 0, expected: true });
    });
    return this.closePromise;
  }
}

module.exports = { ClaudeNativeSession, BACKEND, contentBlocks, digest };
