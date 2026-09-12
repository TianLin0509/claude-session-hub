'use strict';
const { EventEmitter } = require('events');
const { createHash, randomUUID } = require('crypto');
const { CodexAppServerClient } = require('../main/codex-app-server-client');
const { BACKEND, TERMINAL, createNativeRuntime, reduceNativeRuntime, isUnstartedRuntime } = require('./codex-native-runtime');
const startJournal = require('./codex-start-journal');
const { claimThread, releaseThread, assertNoOtherHubOwner } = require('./codex-thread-ownership');
const { CodexTerminalPresentation } = require('./codex-terminal-presentation');
const pool = new Map();
const threadOwners = new Map();
function ownershipKey(options, threadId) {
  const path=require('path');
  const home=path.resolve(options.env?.CODEX_HOME || path.join(require('os').homedir(),'.codex'));
  return (process.platform==='win32'?home.toLowerCase():home)+'\0'+threadId;
}
const INPUT_REQUESTS = new Set(['item/commandExecution/requestApproval','item/fileChange/requestApproval',
  'item/permissions/requestApproval','item/tool/requestUserInput','mcpServer/elicitation/request']);

function scopeKey(options) {
  return createHash('sha256').update(JSON.stringify({
    cwd:options.cwd, args:options.processArgs || [], env:Object.keys(options.env || {}).sort()
      .map(key => [key,options.env[key]]),
  })).digest('hex');
}
function acquire(options) {
  const key = scopeKey(options);
  let entry = pool.get(key);
  if (!entry || entry.client.closed) {
    const client = options.clientFactory ? options.clientFactory(options)
      : new CodexAppServerClient({cwd:options.cwd,env:options.env,args:options.processArgs});
    entry = {client,refs:0,key,owners:new Map()};
    pool.set(key,entry);
  }
  entry.refs++;
  return entry;
}
function release(entry) {
  if (!entry || --entry.refs > 0) return;
  if (pool.get(entry.key) === entry) pool.delete(entry.key);
  entry.client.close();
}
function textInput(text, attachments = []) {
  const input = [{type:'text',text,text_elements:[]}];
  for (const file of attachments) {
    if (file.type === 'image' && file.url) input.push({type:'image',url:file.url});
    else if (file.type === 'localImage' && file.path) input.push({type:'localImage',path:file.path});
    else throw new Error('不支持的 Codex 附件类型');
  }
  return input;
}
function inputDigest(input) {
  const canonical = input.map(i => i.type === 'text' ? {type:i.type,text:i.text}
    : i.type === 'localImage' ? {type:i.type,path:i.path} : {type:i.type,url:i.url});
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
function sanitizeTerminal(text) {
  return String(text || '').replace(/\x1b/g,'').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g,'');
}

// Transport compatibility is output-only. Codex prompts never become PTY key writes.
class CodexNativeSession extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.runtime = options.restoredRuntime ? {
      ...createNativeRuntime(),...options.restoredRuntime,epoch:(Number(options.restoredRuntime.epoch)||0)+1,
      revision:Number(options.restoredRuntime.revision)||0,
      endedTurns:Array.isArray(options.restoredRuntime.endedTurns) ? options.restoredRuntime.endedTurns.slice(-128) : [],
      requests:[],waitingFlags:[],connection:'connecting',
      state:TERMINAL.has(options.restoredRuntime.state) ? options.restoredRuntime.state : 'unknown',
      reason:'正在核对上次 Codex 会话',
      submission: options.restoredRuntime.submission?.status === 'submitting'
        ? {...options.restoredRuntime.submission,status:'unknown'} : options.restoredRuntime.submission,
    } : createNativeRuntime();
    if (options.lazyStart || options.restoredRuntime?.lazyStart) this.runtime.lazyStart = true;
    if (this.runtime.lazyStart && !options.resumeId && !options.forkId && !this.runtime.threadId
        && !this.runtime.turnId && !this.runtime.submission && !this.runtime.startedAt && !this.runtime.endedTurns.length) {
      Object.assign(this.runtime, {state:'idle',connection:'unstarted',reason:'尚未开始，收到消息后启动'});
    }
    this.items = new Map();
    this.terminalPresentation = new CodexTerminalPresentation(text => this.emit('data', text.replace(/\r?\n/g, '\r\n')));
    this.contentRevision = 0;
    this.history = new Map();
    this.closed = false;
    this.ready = null;
    this.entry = null;
    this.threadId = null;
    this.queue = Promise.resolve();
    this.sendController = new AbortController();
    this.requestReplies = new Set();
    this.completed = new Map();
    this.receipts = new Map();
    this.buffered = [];
  }
  get pid() { return this.entry && this.entry.client.proc && this.entry.client.proc.pid || null; }
  onData(fn) { this.on('data',fn); return {dispose:()=>this.off('data',fn)}; }
  onExit(fn) { this.on('exit',fn); return {dispose:()=>this.off('exit',fn)}; }
  resize() {}
  print(text) { this.emit('data',sanitizeTerminal(text).replace(/\r?\n/g,'\r\n')); }
  apply(event) {
    const next = reduceNativeRuntime(this.runtime,{epoch:this.runtime.epoch,...event});
    if (next === this.runtime) return false;
    const previous = this.runtime;
    this.runtime = next;
    this.emit('state',next,previous);
    return true;
  }
  lifecycle(type, extra = {}) {
    this.emit('lifecycle',{type,hubSessionId:this.options.id,kind:'codex',threadId:this.threadId,
      turnId:this.runtime.turnId,signalSource:BACKEND,...extra});
  }
  async start() {
    if (!this.ready) this.ready = this._start();
    return this.ready;
  }
  async _start() {
    if (this.closed) throw new Error('Codex 会话已关闭，不能启动');
    if (isUnstartedRuntime(this.runtime)) this.apply({type:'connect',epoch:this.runtime.epoch});
    this.entry = acquire(this.options);
    const client = this.entry.client;
    const epoch = this.runtime.epoch;
    this.onNotification = msg => {
      if (this.entry?.client !== client || this.runtime.epoch !== epoch) return;
      try { this.notification(msg); }
      catch (error) { this.apply({type:'disconnect',reason:'Codex 事件处理失败：'+error.message}); }
    };
    this.onRequest = msg => {
      if (this.entry?.client !== client || this.runtime.epoch !== epoch) return;
      if (!this.threadId) {
        if (msg.params?.threadId) { msg.serverRequest=true; this.buffered.push(msg); }
        return;
      }
      if (msg.params?.threadId !== this.threadId) return;
      msg.claimed = true;
      if (TERMINAL.has(this.runtime.state) || (msg.params?.turnId && msg.params.turnId !== this.runtime.turnId)) {
        const message='Codex 交互属于已结束或旧轮次，未恢复等待';
        client.rejectRequest(msg.id,message).catch(error=>this.emit('diagnostic',error.message));
        this.emit('diagnostic',message);
        return;
      }
      if (!INPUT_REQUESTS.has(msg.method)) {
        client.rejectRequest(msg.id,'AI Hub 尚未支持该交互：'+msg.method)
          .catch(error => this.apply({type:'disconnect',reason:error.message}));
        this.print('\n[交互不可用] '+msg.method+'\n');
        return;
      }
      const item = this.items.get(msg.params?.itemId);
      this.apply({type:'request',threadId:this.threadId,request:{...msg,
        params:{...msg.params,...(item ? {operation:item} : {})}}});
    };
    this.onDisconnect = error => this.apply({type:'disconnect',reason:error.message,epoch});
    this.onLateResponse = () => {
      if (this.threadId && !this.closed) this.reconcile().catch(error => this.emit('diagnostic',error.message));
    };
    client.on('notification',this.onNotification);
    client.on('server-request',this.onRequest);
    client.on('disconnect',this.onDisconnect);
    client.on('late-response',this.onLateResponse);
    this.onDiagnostic = d => {
      this.emit('diagnostic',d.message);
      if (d.type === 'unmatched-request' && d.threadId === this.threadId) this.emit('action-error',d.message);
    };
    client.on('diagnostic',this.onDiagnostic);
    try {
      await client.start();
      if (this.closed) return;
      const o = this.options;
      if (o.picker) {
        const threads = await this.listThreads();
        this.emit('choices',threads);
        this.print('\n请选择要恢复的 Codex 会话。\n');
        return;
      }
      let id = o.resumeId;
      if (!id && o.resumeLatest) {
        const threads = await client.request('thread/list',{limit:100,sortKey:'updated_at',cwd:o.cwd});
        const match = (threads.data || []).find(t => String(t.cwd).toLowerCase() === String(o.cwd).toLowerCase());
        if (!match) throw new Error('当前目录没有可恢复的 Codex 历史；请明确新建会话');
        id = match.id;
      }
      try {
        await this.openThread(o.forkId ? 'thread/fork' : id ? 'thread/resume' : 'thread/start',o.forkId || id);
      } catch (error) {
        if (!o.forkId && id && this.runtime.lazyStart && this.isMissingRollout(error, id) && this.hasNoTurnEvidence()) {
          const proof = startJournal.read(o, id);
          if (proof?.submissionAttempted === false && !this.emptyRecoveryUsed) {
            this.emptyRecoveryUsed = true;
            this.resetEmptyIdentity(id);
            await this.openThread('thread/start');
          } else {
            if (!proof) this.apply({type:'empty-recovery',recovery:{threadId:id,epoch:this.runtime.epoch}});
            throw error;
          }
        } else throw error;
      }
    } catch (error) {
      if (this.closed) return;
      if (error.nativeDraft) this.emit('migration-draft',error.nativeDraft);
      this.apply({type:'disconnect',reason:error.message});
      this.print('\n[连接失败] '+error.message+'\n');
      throw error;
    }
  }
  isMissingRollout(error, id) {
    return !error.uncertain && String(error.message).includes('no rollout found for thread id ' + id);
  }
  hasNoTurnEvidence() {
    const r = this.runtime;
    return !r.turnId && !r.startedAt && !r.completedAt && !r.submission && !r.endedTurns.length && !this.history.size;
  }
  resetEmptyIdentity(previousThreadId) {
    if (!this.hasNoTurnEvidence()) throw new Error('Codex 已有执行或提交记录，不能替换为空会话');
    this.threadId = null;
    Object.assign(this.options, {resumeId:null,forkId:null,picker:false,resumeLatest:false});
    this.apply({type:'fresh-thread',previousThreadId});
    this.emit('thread-reset', {previousThreadId});
  }
  restartEmpty({threadId,epoch,confirmed}) {
    return this.enqueueSend(async () => {
      const recovery = this.runtime.emptyRecovery;
      if (confirmed !== true || !recovery || recovery.threadId !== threadId || recovery.epoch !== epoch
          || this.runtime.epoch !== epoch || !this.hasNoTurnEvidence()) throw new Error('空会话恢复条件已变化，请重新核对');
      const proof = startJournal.read(this.options, threadId);
      if (proof?.submissionAttempted) throw new Error('Codex 存在提交尝试，不能建立新线程替代');
      await assertNoOtherHubOwner(this.options, threadId);
      if (this.closed || this.runtime.epoch !== epoch || this.runtime.emptyRecovery !== recovery
          || !this.hasNoTurnEvidence()) throw new Error('会话已变化，取消重建');
      this.emptyRecoveryUsed = true;
      this.resetEmptyIdentity(threadId);
      this.detach();
      this.ready = null;
      await this.start();
      return {threadId:this.threadId,previousThreadId:threadId,resent:false};
    });
  }
  async listThreads() {
    const result=[],seen=new Set();let cursor;
    do {
      if (this.closed) throw new Error('Codex 会话已关闭');
      const page=await this.entry.client.request('thread/list',{limit:100,sortKey:'updated_at',...(cursor?{cursor}:{})});
      result.push(...(page.data || []));
      cursor=page.nextCursor;
      if (cursor && seen.has(cursor)) throw new Error('Codex 历史分页游标重复，列表未完整加载');
      if (cursor) seen.add(cursor);
    } while (cursor);
    return result;
  }
  async openThread(method, id) {
    const entry = this.entry;
    const ownerKey=ownershipKey(this.options,id);
    if (method === 'thread/resume' && threadOwners.has(ownerKey) && threadOwners.get(ownerKey) !== this) {
      throw new Error('该 Codex 会话已在另一个配置域中受管，请返回原会话');
    }
    if (method === 'thread/resume' && entry.owners.has(id) && entry.owners.get(id) !== this) {
      throw new Error('该 Codex 会话已在另一个 Hub 卡片中运行，请返回原会话');
    }
    if (method === 'thread/resume') {
      await assertNoOtherHubOwner(this.options,id);
      this.ownershipLease = claimThread(this.options,id,this.pid);
    }
    if (method === 'thread/resume') { entry.owners.set(id,this); threadOwners.set(ownerKey,this); }
    let result;
    try {
      result = await entry.client.request(method,{
        ...this.options.threadParams, ...(id ? {threadId:id} : {}),
      });
    } catch (error) {
      if (entry.owners.get(id) === this) entry.owners.delete(id);
      if (threadOwners.get(ownerKey) === this) threadOwners.delete(ownerKey);
      if (!error.uncertain && this.ownershipLease) { releaseThread(this.ownershipLease); this.ownershipLease=null; }
      throw error;
    }
    if (!result.thread || !result.thread.id || (method === 'thread/resume' && result.thread.id !== id)) {
      if (entry.owners.get(id) === this) entry.owners.delete(id);
      if (threadOwners.get(ownerKey) === this) threadOwners.delete(ownerKey);
      throw new Error('Codex 返回的 thread 身份缺失或不匹配');
    }
    if (this.closed) {
      if (!entry.client.closed) await entry.client.request('thread/unsubscribe',{threadId:result.thread.id});
      return result;
    }
    if (entry.owners.has(result.thread.id) && entry.owners.get(result.thread.id) !== this) {
      throw new Error('Codex 返回了已被其他会话接管的 thread');
    }
    if (!this.ownershipLease) {
      try { this.ownershipLease = claimThread(this.options,result.thread.id,this.pid); }
      catch (error) {
        // Only retire the new thread opened by this request, never another owner.
        if (method !== 'thread/resume') {
          await entry.client.request('thread/unsubscribe',{threadId:result.thread.id},3000)
            .catch(cleanup => this.emit('diagnostic','未能释放新建会话：'+cleanup.message));
        }
        throw error;
      }
    }
    if (this.runtime.lazyStart && method === 'thread/start') {
      startJournal.write(this.options, result.thread.id, !!result.thread.turns?.length);
    }
    entry.owners.set(result.thread.id,this);
    threadOwners.set(ownershipKey(this.options,result.thread.id),this);
    this.unsubscribed = false;
    this.threadId = result.thread.id;
    for (const turn of result.thread.turns || []) this.history.set(turn.id,turn);
    const lastTurn = (result.thread.turns || []).at(-1);
    if (lastTurn) this.items = new Map((lastTurn.items || []).map(i=>[i.id,i]));
    this.apply({type:'snapshot',thread:result.thread});
    this.emit('bound',{threadId:this.threadId,path:result.thread.path || null,
      cwd:result.thread.cwd,model:result.model,reasoningEffort:result.reasoningEffort,serviceTier:result.serviceTier});
    const requestedModel=this.options.threadParams.model,requestedEffort=this.options.threadParams.config?.model_reasoning_effort;
    const expectedSandbox={'read-only':'readOnly','workspace-write':'workspaceWrite','danger-full-access':'dangerFullAccess'}[this.options.threadParams.sandbox];
    const policyMismatch=this.options.threadParams.approvalPolicy && !require('util').isDeepStrictEqual(result.approvalPolicy,this.options.threadParams.approvalPolicy);
    const configError=(requestedModel && result.model!==requestedModel) || (requestedEffort && result.reasoningEffort!==requestedEffort)
      || policyMismatch || (expectedSandbox && result.sandbox?.type!==expectedSandbox)
      ? 'Codex 未确认请求的模型、思考档或权限范围；发送已暂停，请重新核对配置' : null;
    this.confirmedThreadPolicy = {approvalPolicy:result.approvalPolicy,sandbox:result.sandbox};
    this.apply({type:'configuration',error:configError});
    this.print('\nCodex 已连接。请使用 Hub 输入框发送消息。\n');
    const buffered = this.buffered;
    this.buffered = [];
    for (const message of buffered) {
      if (message.serverRequest) this.onRequest(message);
      else this.notification(message);
    }
    this.recoverSubmission(result.thread);
    return result;
  }
  async chooseThread(threadId) {
    if (this.threadId) throw new Error('会话已经绑定，不能重复接管');
    await this.start();
    const read = await this.entry.client.request('thread/read',{threadId,includeTurns:false});
    const cwd = read.thread?.cwd;
    if (!cwd || !require('fs').statSync(cwd).isDirectory()) throw new Error('历史会话的工作目录不存在');
    this.options.threadParams = {...this.options.threadParams,cwd};
    const result = await this.openThread('thread/resume',threadId);
    this.emit('choices',[]);
    return result;
  }
  notification(msg) {
    const p = msg.params || {};
    if (!this.threadId) {
      if (p.threadId) this.buffered.push(msg);
      if (this.buffered.length > 2048) throw new Error('绑定前事件过多，需要重新连接');
      return;
    }
    if (p.threadId !== this.threadId) return;
    const type = msg.method;
    if (type === 'turn/started') {
      const prior = this.runtime;
      if (this.apply({type:'started',threadId:this.threadId,turn:p.turn})
          && this.runtime.turnId === p.turn.id && !TERMINAL.has(this.runtime.state)) {
        if (prior.turnId !== p.turn.id) this.items.clear();
        this.history.set(p.turn.id,{...p.turn,hubStartedAt:this.runtime.startedAt});
        for (const item of p.turn.items || []) this.items.set(item.id,item);
        this.lifecycle('turn-started',{startedAt:this.runtime.startedAt});
      }
    } else if (type === 'turn/completed') {
      this.contentRevision++;
      if (!p.turn || !TERMINAL.has(p.turn.status)) {
        throw new Error('turn/completed 携带非终态');
      }
      if (p.turn.id !== this.runtime.turnId && this.runtime.turnId) return;
      for (const item of p.turn.items || []) this.items.set(item.id,{...this.items.get(item.id),...item});
      this.history.set(p.turn.id,{...this.history.get(p.turn.id),...p.turn,items:[...this.items.values()],hubCompletedAt:Date.now()});
      if (!this.apply({type:'completed',threadId:this.threadId,turn:p.turn})) return;
      const text = this.finalText();
      this.completed.set(p.turn.id,{text,status:p.turn.status,completedAt:this.runtime.completedAt,error:p.turn.error || null});
      while (this.completed.size > 64) this.completed.delete(this.completed.keys().next().value);
      this.lifecycle(p.turn.status === 'completed' ? 'turn-complete' : p.turn.status === 'interrupted' ? 'turn-aborted' : 'turn-error',
        {text,completedAt:this.runtime.completedAt,abortedAt:this.runtime.completedAt,
          message:p.turn.error && p.turn.error.message,errorInfo:p.turn.error || null,
          finality:'provider_final',durationMs:this.runtime.completedAt-this.runtime.startedAt});
      this.terminalPresentation.finish(p.turn.status);
    } else if (type === 'thread/status/changed') {
      this.apply({type:'status',threadId:this.threadId,status:p.status});
      if ((p.status?.type === 'idle' && ['running','waiting'].includes(this.runtime.state))
          || (p.status?.type === 'active' && this.runtime.state === 'unknown')) {
        this.reconcile().catch(error => this.emit('diagnostic',error.message));
      }
    } else if (type === 'serverRequest/resolved') {
      this.requestReplies.delete(p.requestId);
      this.apply({type:'resolved',threadId:this.threadId,requestId:p.requestId});
    } else if (p.turnId && p.turnId !== this.runtime.turnId) {
      return;
    } else if (type === 'item/started' || type === 'item/completed') {
      this.contentRevision++;
      const item = p.item;
      if (!item || !item.id) throw new Error('Codex item 缺少身份');
      const old = this.items.get(item.id);
      this.items.set(item.id,{...old,...item,hubStartedAt:old?.hubStartedAt || Date.now(),
        ...(type === 'item/completed' ? {hubCompletedAt:Date.now()} : {})});
      if (item.type === 'agentMessage') {
        this.terminalPresentation.agent(this.items.get(item.id));
      } else if (item.type !== 'userMessage') {
        this.terminalPresentation.tool(item, type === 'item/completed');
      }
      this.emit('items',this.blocks());
    } else if (type === 'item/agentMessage/delta') {
      this.contentRevision++;
      const item = this.items.get(p.itemId) || {id:p.itemId,type:'agentMessage',text:'',hubStartedAt:Date.now()};
      item.text = (item.text || '') + p.delta;
      this.items.set(p.itemId,item);
      this.terminalPresentation.agent(item);
      this.emit('items',this.blocks());
    } else if (type === 'item/commandExecution/outputDelta') {
      this.terminalPresentation.toolDelta(p.itemId, p.delta);
    } else if (type === 'thread/tokenUsage/updated') {
      this.emit('usage',p.tokenUsage);
    } else if (type === 'error') {
      this.print('\n[Codex] '+(p.error && p.error.message || '执行过程发生错误')+'\n');
      // A retryable error notification is not a terminal turn result.
    }
  }
  finalText() {
    const messages = [...this.items.values()].filter(i => i.type === 'agentMessage');
    const finals = messages.filter(i => i.phase === 'final_answer' || !i.phase);
    return finals.map(i => i.text || '').join('\n');
  }
  blocks() {
    return [...this.items.values()].filter(i => i.type === 'agentMessage').map(i => ({
      type:'text',text:i.text || '',id:i.id,itemId:i.id,threadId:this.threadId,
      turnId:this.runtime.turnId,phase:i.phase || 'message',ts:i.hubStartedAt || this.runtime.startedAt,
    }));
  }
  readTranscript(options = {}) {
    const history=options.turnId ? [this.history.get(options.turnId)].filter(Boolean)
      : options.latestTurn ? [...this.history.values()].slice(-1) : [...this.history.values()];
    const turns = history.map(t=>t.id === this.runtime.turnId
      ? {...t,items:[...this.items.values()]} : t);
    const cards = require('./codex-native-transcript').nativeTranscriptTurns(this.threadId,turns);
    const limit = options.limit == null ? 50 : options.limit;
    return Number.isFinite(limit) && limit >= 0 ? (options.fromTail === false ? cards.slice(0,limit) : cards.slice(-limit)) : cards;
  }
  acceptSubmission(submission, turnId, text) {
    const result = {ok:true,sendStatus:'ok',mode:BACKEND,enterAttempts:0,
      acknowledgementSource:BACKEND,acknowledgementTurnId:turnId,threadId:this.threadId,turnId,
      clientSubmissionId:submission.id,contentFingerprint:submission.digest};
    this.receipts.set(submission.id,{...submission,text,result});
    this.apply({type:'submission',submission:{...submission,status:'accepted',turnId,error:null}});
    this.lifecycle('prompt-submitted',{text,submittedAt:submission.submittedAt,turnId,
      clientSubmissionId:submission.id});
    return result;
  }
  recoverSubmission(thread) {
    const s = this.runtime.submission;
    if (!s || !['unknown','submitting'].includes(s.status) || thread?.id !== this.threadId) return null;
    for (const turn of thread.turns || []) {
      const item = (turn.items || []).find(i=>i.type === 'userMessage' && i.clientId === s.id);
      if (!item) continue;
      const text = (item.content || []).filter(i=>i.type === 'text').map(i=>i.text).join('');
      if (createHash('sha256').update(text).digest('hex') !== s.digest
          || (s.inputDigest && inputDigest(item.content || []) !== s.inputDigest)) {
        this.apply({type:'submission',submission:{...s,status:'unknown',error:'原生消息身份相同但内容不一致，需要人工核对'}});
        return null;
      }
      return this.acceptSubmission(s,turn.id,text);
    }
    return null;
  }
  async reconcile() {
    if (isUnstartedRuntime(this.runtime)) return this.runtime;
    if (this.reconciling) return this.reconciling;
    if (!this.threadId || this.entry.client.closed) throw new Error('Codex 连接不可核对');
    const epoch = this.runtime.epoch;
    const revision = this.runtime.revision;
    this.reconciling = this.entry.client.request('thread/read',{threadId:this.threadId,includeTurns:true})
      .then(result => {
        if (this.runtime.epoch !== epoch || this.runtime.revision !== revision) return this.runtime;
        if (!result.thread || result.thread.id !== this.threadId) throw new Error('Codex 回查返回了不同会话');
        const last = (result.thread.turns || []).find(t => t.id === this.runtime.turnId);
        if (last && TERMINAL.has(last.status) && !TERMINAL.has(this.runtime.state)) {
          this.notification({method:'turn/completed',params:{threadId:this.threadId,turn:last}});
        }
        this.apply({type:'snapshot',thread:result.thread,epoch});
        for (const turn of result.thread.turns || []) this.history.set(turn.id,turn);
        const current = this.history.get(this.runtime.turnId);
        if (current) this.items = new Map((current.items || []).map(i=>[i.id,i]));
        this.recoverSubmission(result.thread);
        return this.runtime;
      }).finally(()=>{this.reconciling=null;});
    return this.reconciling;
  }
  async idle(timeoutMs = 0, signal) {
    if (signal?.aborted) throw signal.reason;
    if (TERMINAL.has(this.runtime.state) || this.runtime.state === 'idle') return;
    if (!['running','waiting'].includes(this.runtime.state)) throw new Error('Codex 状态待核对，不能派发');
    return new Promise((resolve,reject)=>{
      let timer;
      const cleanup = () => {
        this.off('state',listener); clearTimeout(timer);
        signal?.removeEventListener('abort',abort);
      };
      const abort = () => { cleanup(); reject(signal.reason); };
      const listener = r => {
        if (['running','waiting'].includes(r.state) && r.connection === 'connected') return;
        cleanup();
        if (r.connection !== 'connected' || r.state === 'unknown') reject(new Error(r.reason || 'Codex 连接异常'));
        else resolve();
      };
      this.on('state',listener);
      signal?.addEventListener('abort',abort,{once:true});
      if (timeoutMs) timer = setTimeout(() => {
        cleanup(); reject(new Error('Codex 尚未确认停止，保留会话供核对'));
      }, timeoutMs);
    });
  }
  checkSendIntent(intent) {
    if (intent.signal.aborted) throw intent.signal.reason;
    if (this.closed) throw new Error('Codex 会话正在关闭，未发送');
    if (this.runtime.epoch !== intent.epoch
        || (intent.client && this.entry?.client !== intent.client)
        || (intent.threadId && this.threadId !== intent.threadId)) {
      throw new Error('Codex 连接或会话身份已变化，已取消排队消息，未发送');
    }
  }
  enqueueSend(operation) {
    const intent = {signal:this.sendController.signal,epoch:this.runtime.epoch,
      client:this.entry?.client,threadId:this.threadId,sent:false};
    // Cancel even tasks behind a pending RPC; its eventual continuation still
    // carries the aborted intent, including if a shared-thread close fails.
    const task = this.queue.then(()=>{this.checkSendIntent(intent);return operation(intent);});
    this.queue = task.catch(()=>{});
    return new Promise((resolve,reject)=>{
      const abort = () => { if (!intent.sent) reject(intent.signal.reason); };
      intent.signal.addEventListener('abort',abort,{once:true});
      if (intent.signal.aborted) abort();
      task.then(resolve,reject).finally(()=>intent.signal.removeEventListener('abort',abort));
    });
  }
  send(text, options = {}) {
    return this.enqueueSend(intent=>this._send(text,options,intent));
  }
  checkSendable(intent) {
    this.checkSendIntent(intent);
    if (!this.threadId) throw new Error('请先选择要恢复的历史会话');
    if (this.runtime.connection !== 'connected' || !this.entry || this.entry.client.closed) throw new Error('Codex 连接已断开，请先核对');
    if (this.runtime.configurationError) throw new Error(this.runtime.configurationError);
    if (this.runtime.state === 'unknown') throw new Error('Codex 状态待核对，未发送');
    if (this.runtime.submission?.status === 'unknown') throw new Error('上一条提交结果不明，请先核对消息记录；不会自动重发');
    if (this.runtime.state === 'waiting' && this.runtime.requests.length) throw new Error('请先回答当前审批或问题');
  }
  async _send(text, options, intent) {
    await this.start();
    this.checkSendIntent(intent);
    if (!this.threadId) throw new Error('请先选择要恢复的历史会话');
    if (this.runtime.connection !== 'connected') throw new Error('Codex 连接已断开，请先核对');
    intent.client ||= this.entry.client;
    intent.threadId ||= this.threadId;
    if (String(text).trimStart().startsWith('/')) return this.slash(String(text).trim(),intent);
    this.checkSendable(intent);
    if (options.requireReady !== false) await this.idle(0,intent.signal);
    this.checkSendable(intent);
    const client = intent.client, epoch = intent.epoch, threadId = intent.threadId;
    const submittedAt = Date.now();
    const id = options.clientSubmissionId || randomUUID();
    const input = textInput(text,options.attachments);
    const digest = createHash('sha256').update(text).digest('hex');
    const payloadDigest = inputDigest(input);
    const old = this.receipts.get(id);
    if (old) {
      if (old.digest !== digest || (old.inputDigest && old.inputDigest !== payloadDigest)) throw new Error('提交 ID 与正文或附件不匹配');
      if (old.result) return old.result;
      throw new Error('此前提交结果不明，请先核对；不会自动重发');
    }
    const receipt = {digest,inputDigest:payloadDigest,text,submittedAt,result:null};
    this.receipts.set(id,receipt);
    while (this.receipts.size > 100) this.receipts.delete(this.receipts.keys().next().value);
    const submission = {id,status:'submitting',digest,inputDigest:payloadDigest,submittedAt};
    this.apply({type:'submission',submission});
    const active = ['running','waiting'].includes(this.runtime.state);
    const method = active ? 'turn/steer' : 'turn/start';
    const params = {threadId:this.threadId,input,clientUserMessageId:id,
      ...(active ? {expectedTurnId:this.runtime.turnId} : this.options.turnParams)};
    try {
      this.terminalPresentation.prompt(text, { reset: !active });
      const result = await client.request(method,params,undefined,{beforeWrite:()=>{
        this.checkSendable(intent);
        if (active ? this.runtime.turnId !== params.expectedTurnId : !TERMINAL.has(this.runtime.state) && this.runtime.state !== 'idle') {
          throw new Error('Codex 活跃轮次已变化，未发送排队消息');
        }
        if (this.runtime.lazyStart) startJournal.write(this.options, threadId, true, {submissionId:id});
        intent.sent = true;
      }});
      if (this.entry?.client !== client || this.runtime.epoch !== epoch || this.threadId !== threadId || this.closed) {
        throw Object.assign(new Error('提交响应来自已关闭的连接，请核对原生记录'),{uncertain:true});
      }
      const turn = active ? {id:result.turnId || this.runtime.turnId,status:'inProgress'} : result.turn;
      if (!turn || !turn.id) throw Object.assign(new Error('Codex 提交响应缺少轮次 ID'),{uncertain:true});
      if (!active) {
        if (TERMINAL.has(turn.status)) {
          if (this.runtime.turnId !== turn.id) this.notification({method:'turn/started',params:{threadId:this.threadId,turn}});
          this.notification({method:'turn/completed',params:{threadId:this.threadId,turn}});
        }
        else this.notification({method:'turn/started',params:{threadId:this.threadId,turn}});
      }
      return this.acceptSubmission(submission,turn.id,text);
    } catch (error) {
      this.apply({type:'submission',epoch,submission:{...submission,status:error.uncertain ? 'unknown' : 'rejected',
        error:error.message}});
      throw error;
    }
  }
  async interrupt() {
    if (this.runtime.lazyStart && !this.runtime.turnId && !this.runtime.submission) {
      this.sendController.abort(new Error('已停止，未发送排队消息'));
      this.sendController = new AbortController();
      return {ok:true,pending:false,notStarted:true};
    }
    await this.start();
    if (!['running','waiting'].includes(this.runtime.state) || this.runtime.connection !== 'connected') {
      throw new Error('没有可确认的活跃 Codex 轮次');
    }
    await this.entry.client.request('turn/interrupt',{threadId:this.threadId,turnId:this.runtime.turnId});
    return {ok:true,pending:!TERMINAL.has(this.runtime.state)};
  }
  reviewUnknownSubmission(id, epoch) {
    const r=this.runtime;
    if (epoch !== r.epoch || r.submission?.id !== id || r.submission.status !== 'unknown') throw new Error('待核对消息已变化，请刷新');
    if (r.connection !== 'connected' || !['idle','completed','interrupted','failed'].includes(r.state)) throw new Error('必须先核对连接，并等待原生轮次结束');
    this.apply({type:'submission',submission:{...r.submission,status:'reviewed',reviewedAt:Date.now()}});
    return {ok:true,resent:false};
  }
  async reply(requestId, result, epoch) {
    if (epoch !== this.runtime.epoch) throw new Error('审批来自旧连接，请刷新');
    const request = this.runtime.requests.find(r=>r.id === requestId);
    if (!request || this.requestReplies.has(requestId)) throw new Error('该请求已处理或已经失效');
    if (request.method === 'item/tool/requestUserInput') {
      if (!result || !result.answers) throw new Error('回答不能为空');
      for (const q of request.params.questions || []) {
        if (!Array.isArray(result.answers[q.id] && result.answers[q.id].answers)) throw new Error('问题缺少回答：'+q.id);
      }
    } else if (/commandExecution|fileChange/.test(request.method)) {
      if (!['accept','acceptForSession','decline','cancel'].includes(result && result.decision)) throw new Error('审批决定无效');
    } else if (request.method === 'item/permissions/requestApproval') {
      // The UI chooses the whole requested subset or none; no arbitrary grants.
      if (!result || !['accept','decline'].includes(result.decision)) throw new Error('权限决定无效');
      result = {permissions:result.decision === 'accept' ? request.params.permissions : {},scope:'turn'};
    } else if (request.method === 'mcpServer/elicitation/request') {
      if (!result || !['accept','decline','cancel'].includes(result.action)) throw new Error('MCP 回答无效');
    }
    this.requestReplies.add(requestId);
    try { await this.entry.client.respond(requestId,result); }
    catch(error) { this.requestReplies.delete(requestId); throw error; }
    // Keep waiting until the engine resolves the request.
    return {ok:true};
  }
  configure(options) {
    return this.enqueueSend(intent=>this._configure(options,intent));
  }
  async _configure({model,effort,codexSpeedTier}, intent) {
    model = model || this.options.turnParams.model;
    if (codexSpeedTier !== undefined && !['standard','fast'].includes(codexSpeedTier)) throw new Error('无效的速度档位');
    if (isUnstartedRuntime(this.runtime)) {
      if (intent) this.checkSendIntent(intent);
      if (typeof model !== 'string' || !model.trim() || /[\s\x00-\x1f]/.test(model)) throw new Error('Codex 模型名称无效');
      const requestedEffort = effort || this.options.turnParams.effort;
      if (!['none','minimal','low','medium','high','xhigh','max','ultra'].includes(requestedEffort)) throw new Error('Codex 思考档无效');
      if (codexSpeedTier === 'fast') {
        const tuning = require('./codex-model-catalog').describeCodexModelTuning(model,{configDir:this.options.env?.CODEX_HOME});
        if (!tuning.fromCache || !tuning.supportsFast) throw new Error('当前模型目录尚未确认 Fast 支持，请刷新目录后重试');
      }
      this.options.threadParams = {...this.options.threadParams,model,
        config:{...this.options.threadParams.config,model_reasoning_effort:requestedEffort}};
      this.options.turnParams = {...this.options.turnParams,model,effort:requestedEffort};
      if (codexSpeedTier !== undefined) this.options.turnParams.serviceTier = codexSpeedTier === 'fast' ? 'fast' : 'default';
      this.emit('bound',{threadId:null,path:null,model,reasoningEffort:requestedEffort,
        ...(codexSpeedTier !== undefined ? {codexSpeedTier} : {})});
      return {modelId:model,displayName:model,effort:requestedEffort,codexSpeedTier,appliesOn:'first-turn',validation:'on-start'};
    }
    await this.start();
    if (intent) this.checkSendIntent(intent);
    if (this.runtime.connection !== 'connected'
        || !['idle','completed','interrupted','failed'].includes(this.runtime.state)) {
      throw new Error('请在 Codex 当前轮次结束且连接正常后切换模型或思考档');
    }
    const client = this.entry.client, epoch = this.runtime.epoch;
    const check = () => {
      if (intent) this.checkSendIntent(intent);
      if (this.entry?.client !== client || this.runtime.epoch !== epoch || this.closed) throw new Error('配置响应来自旧连接，请重新核对');
      if (!['idle','completed','interrupted','failed'].includes(this.runtime.state)) throw new Error('Codex 已开始新轮次，不能切换配置');
    };
    model = model || this.options.turnParams.model;
    const list = await client.request('model/list',{});
    check();
    const target = (list.data || []).find(m=>m.id === model || m.model === model);
    if (!target) throw new Error('Codex 模型目录中没有：'+model);
    if (codexSpeedTier !== undefined) {
      if (!['standard','fast'].includes(codexSpeedTier)) throw new Error('无效的速度档位');
      const tiers = [...(target.additionalSpeedTiers || []), ...(target.serviceTiers || []).map(t=>t.id)];
      if (codexSpeedTier === 'fast' && !tiers.includes('fast')) throw new Error(model+' 当前不支持 Fast');
    }
    const requestedEffort = effort || this.options.turnParams.effort;
    if (requestedEffort && !(target.supportedReasoningEfforts || []).some(e=>e.reasoningEffort === requestedEffort)) {
      throw new Error(model+' 不支持 '+requestedEffort+'；请明确选择支持的思考档');
    }
    const params = {...this.options.threadParams,model,
      config:{...this.options.threadParams.config,model_reasoning_effort:requestedEffort}};
    const policy=this.confirmedThreadPolicy;
    if (!policy || (params.approvalPolicy && !require('util').isDeepStrictEqual(policy.approvalPolicy,params.approvalPolicy))
        || (params.sandbox && policy.sandbox?.type!==({'read-only':'readOnly','workspace-write':'workspaceWrite','danger-full-access':'dangerFullAccess'}[params.sandbox]))) {
      this.apply({type:'configuration',error:'Codex 未确认请求的权限范围；发送已暂停，请重新连接'});
      throw new Error(this.runtime.configurationError);
    }
    this.options.threadParams = params;
    this.options.turnParams = {...this.options.turnParams,model,effort:requestedEffort};
    if (codexSpeedTier !== undefined) {
      this.options.turnParams.serviceTier = codexSpeedTier === 'fast' ? 'fast' : 'default';
    }
    this.apply({type:'configuration',error:null});
    // Loaded thread/resume deliberately ignores model/effort overrides.
    // Selection is applied by the next turn/start, never by a fake task or
    // changing the shared server/global config. UI labels this explicitly.
    this.emit('bound',{threadId:this.threadId,model,reasoningEffort:requestedEffort,
      ...(codexSpeedTier !== undefined ? {codexSpeedTier} : {})});
    return {modelId:model,displayName:target.displayName || model,effort:requestedEffort,codexSpeedTier,appliesOn:'next-turn'};
  }
  async readOutcome(turnId) {
    if (!turnId) return null;
    const epoch = this.runtime.epoch;
    let result = this.completed.get(turnId);
    if (!result) {
      const response = await this.entry.client.request('thread/read',{threadId:this.threadId,includeTurns:true});
      if (this.runtime.epoch !== epoch) throw new Error('Codex 结果来自旧连接，请重新核对');
      if (response.thread?.id !== this.threadId) throw new Error('Codex 结果回查身份不匹配');
      const turn = (response.thread.turns || []).find(t=>t.id === turnId);
      if (!turn || !TERMINAL.has(turn.status)) return null;
      const text = (turn.items || []).filter(i=>i.type === 'agentMessage' && (!i.phase || i.phase === 'final_answer'))
        .map(i=>i.text || '').join('\n');
      result = {text,status:turn.status,error:turn.error || null,completedAt:Date.now()};
    }
    return {hubSessionId:this.options.id,threadId:this.threadId,turnId,signalSource:BACKEND,
      text:result.text,status:result.status,completedAt:result.completedAt,abortedAt:result.completedAt,
      message:result.error?.message,errorInfo:result.error,finality:'provider_final'};
  }
  async slash(text, intent) {
    const space = text.search(/\s/);
    const command = (space < 0 ? text : text.slice(0,space)).toLowerCase();
    const value = space < 0 ? '' : text.slice(space).trim();
    let commandOutput = '';
    const printResult = text => { commandOutput = String(text); this.print('\n' + commandOutput + '\n'); };
    const client = this.entry.client;
    const request = (method,params) => client.request(method,params,undefined,{beforeWrite:()=>{
      this.checkSendIntent(intent);
      if (this.runtime.connection !== 'connected') throw new Error('Codex 连接已断开，未发送命令');
      if (method === 'thread/compact/start' || method === 'review/start') {
        this.checkSendable(intent);
        if (!TERMINAL.has(this.runtime.state) && this.runtime.state !== 'idle') throw new Error('Codex 已开始新轮次，未发送排队命令');
      }
      if (this.runtime.lazyStart && !['mcpServerStatus/list','thread/goal/get'].includes(method)) {
        startJournal.write(this.options, this.threadId, true, {command:method});
      }
      intent.sent = true;
    }});
    if (command === '/mcp') {
      const all = []; let cursor;
      do {
        const result = await request('mcpServerStatus/list',{threadId:this.threadId,...(cursor ? {cursor} : {}),limit:100});
        all.push(...(result.data || [])); cursor = result.nextCursor;
      } while (cursor);
      printResult(JSON.stringify({profile:this.options.mcpProfile,servers:all},null,2));
    } else if (command === '/status' || command === '/help') {
      printResult(command === '/status' ? JSON.stringify(this.runtime,null,2)
          : '原生命令：/status /mcp /model <模型> /rename <名称> /compact /goal <目标> /goal pause /goal resume /goal clear /review\n在 Hub 输入框提交以上命令；后台仅显示输出。\n新建、恢复、分叉请使用 Hub 会话菜单。\n/logout、/login 尚未接入：在 PowerShell 使用 codex logout、codex login（相同 CODEX_HOME）。\n');
    } else if (command === '/rename' && value) {
      await request('thread/name/set',{threadId:this.threadId,name:value});
      this.emit('renamed',value);
    } else if (command === '/goal') {
      if (!value) {
        const goal = await request('thread/goal/get',{threadId:this.threadId});
        printResult(JSON.stringify(goal,null,2));
      } else if (value === 'clear') await request('thread/goal/clear',{threadId:this.threadId});
      else await request('thread/goal/set',{threadId:this.threadId,
        ...(['pause','resume'].includes(value) ? {status:value === 'pause' ? 'paused' : 'active'} : {objective:value})});
    } else if (command === '/compact') {
      await this.idle(0,intent.signal);
      await request('thread/compact/start',{threadId:this.threadId});
    } else if (command === '/model' && value) {
      await this._configure({model:value},intent);
    } else if (command === '/review' && !value) {
      await this.idle(0,intent.signal);
      await request('review/start',{threadId:this.threadId,target:{type:'uncommittedChanges'},delivery:'inline'});
    } else if (command === '/logout' || command === '/login') {
      throw new Error(command + ' 尚未接入 Hub，未执行。请在 PowerShell 使用 codex ' + command.slice(1) + '，并使用与本会话相同的 CODEX_HOME。账号操作影响共享该登录目录的会话；后台是只读输出，不能直接输入 CLI 命令。');
    } else {
      throw new Error('此命令尚无 Hub 原生映射：'+command+'。未发送给模型；输入 /help 查看支持的命令，其他 CLI 命令请在独立终端运行 Codex。');
    }
    return {ok:true,sendStatus:'ok',mode:'native-command',commandOutput,enterAttempts:0,acknowledgementSource:BACKEND};
  }
  write(data) {
    if (data === '\x03' || data === '\x1b') {
      this.interrupt().catch(error => { this.print('\n[停止失败] '+error.message+'\n'); this.emit('action-error',error.message); });
    } else if (/^\/rename [^\r\n]+\r$/.test(data)) {
      this.send(data.trim()).catch(error => this.emit('action-error',error.message));
    } else if (String(data).trim()) {
      this.emit('action-error','Codex 使用 Hub 输入框提交；终端为只读输出。');
    }
  }
  async reconnect() {
    if (this.closed) throw new Error('Codex 会话正在关闭，不能重新连接');
    if (isUnstartedRuntime(this.runtime)) return this.runtime;
    if (this.runtime.connection === 'connected') return this.reconcile();
    if (!this.entry || this.entry.client.closed || !this.threadId) {
      if (this.entry?.client.closed) await this.entry.client.waitForExit();
      // A timed-out resume may have loaded the thread without returning its ID.
      // Confirm unsubscribe on the same server before releasing its lease.
      if (!this.threadId && this.ownershipLease && this.entry && !this.entry.client.closed) {
        await this.entry.client.request('thread/unsubscribe',{threadId:this.ownershipLease.threadId},3000);
        this.options.resumeId=this.ownershipLease.threadId;
        this.unsubscribed=true;
      }
      this.detach();
      this.options.resumeId = this.threadId || this.options.resumeId;
      this.options.forkId = null;
      this.options.resumeLatest = false;
      this.options.picker = !this.options.resumeId && !this.runtime.lazyStart;
      this.apply({type:'connect',epoch:this.runtime.epoch+1});
      this.ready = null;
      return this.start();
    }
    return this.reconcile();
  }
  detach() {
    if (!this.entry) return;
    for (const [key,owner] of threadOwners) if (owner===this) threadOwners.delete(key);
    const c = this.entry.client;
    const lease=this.ownershipLease;this.ownershipLease=null;
    const releaseLease=()=>{try{releaseThread(lease);}catch(error){this.emit('diagnostic','会话归属记录释放失败：'+error.message);}};
    if (lease && !this.unsubscribed && c.proc?.exitCode===null && c.proc?.signalCode===null) c.proc.once('exit',releaseLease);
    else releaseLease();
    for(const [id,owner] of this.entry.owners)if(owner===this)this.entry.owners.delete(id);
    c.off('notification',this.onNotification);
    c.off('server-request',this.onRequest);
    c.off('disconnect',this.onDisconnect);
    c.off('late-response',this.onLateResponse);
    c.off('diagnostic',this.onDiagnostic);
    release(this.entry);
    this.entry = null;
  }
  kill() {
    if (this.closed) return;
    this.closed = true;
    this.sendController.abort(new Error('Codex 会话正在关闭，已取消排队消息，未发送'));
    const c = this.entry && this.entry.client;
    const finish = () => {
      if (!isUnstartedRuntime(this.runtime)) this.apply({type:'disconnect',reason:'会话已关闭'});
      this.detach();
      this.emit('exit',{exitCode:0});
    };
    if (c && !c.closed && this.threadId) {
      (async()=>{
        if (['running','waiting'].includes(this.runtime.state)) {
          await c.request('turn/interrupt',{threadId:this.threadId,turnId:this.runtime.turnId},5000);
          await this.idle(5000);
        }
        await c.request('thread/unsubscribe',{threadId:this.threadId},3000);
        this.unsubscribed=true;
        finish();
      })().catch(error=>{
        this.emit('diagnostic','关闭 Codex 会话：'+error.message);
        if (c.closed || this.entry?.refs === 1) finish();
        else { this.closed=false; this.sendController=new AbortController(); this.emit('action-error',error.message); }
      });
    } else finish();
  }
}
module.exports = { CodexNativeSession, textInput, scopeKey, pool };
