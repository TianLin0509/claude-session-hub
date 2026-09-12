'use strict';

const path = require('path');
const os = require('os');
const { EventEmitter } = require('events');
const { randomUUID } = require('crypto');
const { connectBroker } = require('../main/codex-runtime-broker-client');
const { createNativeRuntime, reduceNativeRuntime, TERMINAL, isUnstartedRuntime } = require('./codex-native-runtime');

function restoredRuntime(options) {
  if (!options.restoredRuntime) {
    const runtime = createNativeRuntime();
    if (options.lazyStart) Object.assign(runtime, { lazyStart:true, state:'idle', connection:'unstarted', reason:'尚未开始，收到消息后启动' });
    return runtime;
  }
  const previous = options.restoredRuntime;
  return {
    ...createNativeRuntime(), ...previous, epoch:(Number(previous.epoch) || 0) + 1,
    revision:Number(previous.revision) || 0,
    endedTurns:Array.isArray(previous.endedTurns) ? previous.endedTurns.slice(-128) : [],
    requests:[], waitingFlags:[], connection:'connecting',
    state:TERMINAL.has(previous.state) ? previous.state : 'unknown',
    reason:'正在连接 Codex 共享服务',
    submission:previous.submission?.status === 'submitting'
      ? { ...previous.submission, status:'unknown' } : previous.submission,
  };
}

function cleanOptions(options) {
  return JSON.parse(JSON.stringify(options, (_key, value) => typeof value === 'function' ? undefined : value));
}

class CodexSharedSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sharedRuntime = true;
    this.brokerConnector = options.brokerConnector || connectBroker;
    this.runtime = restoredRuntime(options);
    this.viewEpoch = this.runtime.epoch;
    this.hostRuntimeEpoch = null;
    this.everAttached = false;
    this.threadId = this.runtime.threadId || options.resumeId || null;
    this.contentRevision = 0;
    this.transcript = [];
    this.textBlocks = [];
    this.lastFinalText = '';
    this.receipts = new Map();
    this.control = { shared:true, role:'viewer', viewId:randomUUID(), controller:null,
      controllerEpoch:0, canTransfer:false, transferReason:'正在连接共享服务', viewerCount:0 };
    this.view = {
      viewId:this.control.viewId,
      sessionId:options.id,
      hubPid:Number(options.hubPid) || process.pid,
      hubVersion:String(options.hubVersion || ''),
      label:`Hub v${options.hubVersion || '?'} · PID ${Number(options.hubPid) || process.pid}`,
    };
    this.key = null;
    this.client = null;
    this.ready = null;
    this.closed = false;
    this.exiting = false;
  }
  get pid() { return this.control?.serverPid || null; }
  onData(fn) { this.on('data', fn); return { dispose:() => this.off('data', fn) }; }
  onExit(fn) { this.on('exit', fn); return { dispose:() => this.off('exit', fn) }; }
  resize() {}
  print(text) { this.emit('data', String(text || '').replace(/\r?\n/g, '\r\n')); }
  applyRuntime(next) {
    if (!next || next === this.runtime) return;
    this.hostRuntimeEpoch = next.epoch;
    next = { ...next, brokerEpoch:next.epoch, epoch:this.viewEpoch };
    const previous = this.runtime;
    this.runtime = next;
    this.threadId = next.threadId || this.threadId;
    this.emit('state', next, previous);
  }
  applyControl(control) {
    if (!control) return;
    const previous = this.control;
    this.control = control;
    this.emit('control', control, previous);
  }
  applyContent(content) {
    if (!content) return;
    this.contentRevision = Number(content.contentRevision) || this.contentRevision;
    this.transcript = Array.isArray(content.transcript) ? content.transcript : this.transcript;
    this.textBlocks = Array.isArray(content.blocks) ? content.blocks : this.textBlocks;
    this.lastFinalText = typeof content.finalText === 'string' ? content.finalText : this.lastFinalText;
    this.emit('items', this.textBlocks);
  }
  applySnapshot(snapshot) {
    if (!snapshot) return;
    const oldThread = this.threadId;
    this.key = snapshot.key || this.key;
    this.threadId = snapshot.threadId || this.threadId;
    if (snapshot.runtime) this.applyRuntime(snapshot.runtime);
    this.applyContent(snapshot);
    this.applyControl(snapshot.control);
    if (this.threadId && this.threadId !== oldThread) this.emit('bound', { threadId:this.threadId });
  }
  onNotification = message => {
    const p = message.params || {};
    if (p.previousKey && this.key === p.previousKey) this.key = p.key;
    if (this.key && p.key && p.key !== this.key) return;
    if (message.method === 'control') this.applyControl(p.control);
    else if (message.method === 'content') this.applyContent(p);
    else if (message.method === 'locate-request') this.emit('locate-request', { sessionId:this.options.id });
    else if (message.method === 'session-event') {
      const args = Array.isArray(p.args) ? p.args : [];
      if (p.event === 'state') this.applyRuntime(args[0]);
      else if (p.event === 'bound') {
        const bound = args[0] || {};
        this.threadId = bound.threadId || this.threadId;
        this.emit('bound', bound);
      } else if (p.event === 'lifecycle') {
        // Lifecycle has persistence, notification and workflow side effects in
        // Main. Only the controller Hub publishes those; viewers already get
        // the same authoritative state and content events.
        if (this.control.role === 'controller') {
          this.emit('lifecycle', { ...(args[0] || {}), hubSessionId:this.options.id });
        }
      } else if (p.event === 'usage') {
        if (this.control.role === 'controller') this.emit('usage', ...args);
      } else if (p.event === 'exit') this.emit('diagnostic', 'Codex 共享运行实例已退出');
      else this.emit(p.event, ...args);
    }
  };
  onDisconnect = error => {
    if (this.closed) return;
    const next = reduceNativeRuntime(this.runtime, { type:'disconnect', epoch:this.runtime.epoch,
      reason:error?.message || 'Codex 共享服务连接已断开' });
    this.applyRuntime(next);
    this.client = null;
    this.ready = null;
  };
  async start() {
    if (this.closed) throw new Error('Codex 会话已关闭，不能启动');
    if (!this.ready) this.ready = this._start().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }
  async _start() {
    if (this.everAttached) this.viewEpoch++;
    const dataDir = this.options.hubDataDir || this.options.env?.CLAUDE_HUB_DATA_DIR
      || path.join(os.homedir(), '.claude-session-hub');
    const client = await this.brokerConnector({ dataDir });
    if (this.closed) { client.close(); return; }
    this.client = client;
    client.on('notification', this.onNotification);
    client.once('disconnect', this.onDisconnect);
    let snapshot;
    try {
      snapshot = await client.request('attach', { options:cleanOptions(this.options), view:this.view });
    } catch (error) {
      client.off('notification', this.onNotification);
      client.off('disconnect', this.onDisconnect);
      client.close();
      if (this.client === client) this.client = null;
      throw error;
    }
    if (this.client !== client || this.closed) return;
    this.applySnapshot(snapshot);
    this.everAttached = true;
    this.print(this.control.role === 'controller'
      ? '\nCodex 已通过共享服务连接，本窗口可以操作。\n'
      : `\nCodex 已通过共享服务连接，当前由 ${this.control.controller?.label || '另一窗口'} 操作。\n`);
    return this.runtime;
  }
  async request(method, params = {}, timeoutMs) {
    await this.start();
    if (!this.client || this.client.closed) throw new Error('Codex 共享服务连接已断开');
    return this.client.request(method, { key:this.key, viewId:this.view.viewId, ...params }, timeoutMs);
  }
  async action(action, args = []) {
    await this.start();
    return this.request('action', { action, args, controllerEpoch:this.control.controllerEpoch });
  }
  async requestControl() {
    await this.start();
    const control = await this.request('request-control', { controllerEpoch:this.control.controllerEpoch });
    this.applyControl(control);
    return control;
  }
  locateController() { return this.request('locate-controller'); }
  async reserveWorkflow(reservationId, label) {
    await this.start();
    return this.request('reserve-workflow', { reservationId, label, controllerEpoch:this.control.controllerEpoch });
  }
  async releaseWorkflow(reservationId) {
    await this.start();
    return this.request('release-workflow', { reservationId, controllerEpoch:this.control.controllerEpoch });
  }
  send(text, options = {}) {
    const clean = { requireReady:options.requireReady, clientSubmissionId:options.clientSubmissionId,
      attachments:options.attachments };
    return this.action('send', [text, clean]).then(result => {
      if (result?.clientSubmissionId) this.receipts.set(result.clientSubmissionId, { result });
      return result;
    });
  }
  interrupt() { return this.action('interrupt'); }
  reply(requestId, result, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('审批来自旧窗口状态，请刷新'));
    return this.action('reply', [requestId, result, this.hostRuntimeEpoch]);
  }
  configure(options) { return this.action('configure', [options]); }
  configureMode(mode, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('工作模式切换来自旧窗口状态，请刷新'));
    return this.action('configureMode', [mode, this.hostRuntimeEpoch]);
  }
  chooseThread(threadId) { return this.action('chooseThread', [threadId]); }
  restartEmpty(options) {
    if (options?.epoch !== this.runtime.epoch) return Promise.reject(new Error('空会话恢复来自旧窗口状态，请刷新'));
    return this.action('restartEmpty', [{ ...options, epoch:this.hostRuntimeEpoch }]);
  }
  reviewUnknownSubmission(id, epoch) {
    if (epoch !== this.runtime.epoch) return Promise.reject(new Error('提交核对来自旧窗口状态，请刷新'));
    return this.action('reviewUnknownSubmission', [id, this.hostRuntimeEpoch]);
  }
  readOutcome(turnId) { return this.action('readOutcome', [turnId]).then(result => result ? { ...result, hubSessionId:this.options.id } : result); }
  reconcile() { return this.action('reconcile'); }
  async reconnect() {
    if (this.client && !this.client.closed) return this.action('reconnect');
    this.ready = null;
    await this.start();
    return this.action('reconcile');
  }
  finalText() { return this.lastFinalText; }
  blocks() { return this.textBlocks.slice(); }
  readTranscript(options = {}) {
    let cards = this.transcript.slice();
    const turnKey = card => card.displayTurnKey || (card.providerTurnId ? `${this.threadId}:${card.providerTurnId}` : null);
    if (options.turnId) {
      const wanted = `${this.threadId}:${options.turnId}`;
      cards = cards.filter(card => card.providerTurnId === options.turnId || turnKey(card) === wanted);
    }
    if (options.latestTurn && cards.length) {
      const wanted = turnKey(cards.at(-1));
      cards = wanted ? cards.filter(card => turnKey(card) === wanted) : cards.slice(-1);
    }
    const limit = options.limit == null ? 50 : options.limit;
    return Number.isFinite(limit) && limit >= 0
      ? (options.fromTail === false ? cards.slice(0, limit) : cards.slice(-limit)) : cards;
  }
  write(data) {
    if (data === '\x03' || data === '\x1b') this.interrupt().catch(error => this.emit('action-error', error.message));
    else if (String(data || '').trim()) this.emit('action-error', 'Codex 使用 Hub 输入框提交；终端为只读输出。');
  }
  kill() {
    if (this.closed || this.exiting) return;
    this.exiting = true;
    const client = this.client;
    const finish = () => {
      if (client) {
        client.off('notification', this.onNotification);
        client.off('disconnect', this.onDisconnect);
        client.close();
      }
      this.client = null;
      this.closed = true;
      this.exiting = false;
      this.emit('exit', { exitCode:0, sharedDetached:true });
    };
    if (!client || client.closed || !this.key) { finish(); return; }
    client.request('detach', { key:this.key, viewId:this.view.viewId }, 3000).then(finish, finish);
  }
}

module.exports = { CodexSharedSession, cleanOptions, restoredRuntime };
