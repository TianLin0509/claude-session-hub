'use strict';
const { EventEmitter } = require('events');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');

function resolveNativeCommand(env = process.env) {
  // A test fixture is an explicit executable/script in an isolated Hub only.
  if (env.CLAUDE_HUB_DATA_DIR && env.CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE) {
    return { command:process.execPath, args:[env.CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE],
      env:{ ...env, ELECTRON_RUN_AS_NODE:'1' } };
  }
  if (process.platform !== 'win32') return { command:'codex', args:[], env };
  return require('./codex-windows-command').resolveWindowsCodex(env);
}

class CodexAppServerClient extends EventEmitter {
  constructor(options = {}) {
    super();
    this.options = options;
    this.pending = new Map();
    this.serverRequests = new Map();
    this.nextId = 1;
    this.closed = false;
    this.started = false;
    this.stderr = '';
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
    this.writeTail = Promise.resolve();
  }
  async start() {
    if (this.ready) return this.ready;
    this.ready = this._start();
    return this.ready;
  }
  async _start() {
    const opts = this.options;
    const launch = opts.launch || resolveNativeCommand(opts.env || process.env);
    this.started = true;
    try {
      this.proc = (opts.spawn || spawn)(launch.command,
        [...launch.args, 'app-server', '--listen', 'stdio://', ...(opts.args || [])], {
          cwd:opts.cwd, env:launch.env || opts.env || process.env,
          windowsHide:true, stdio:['pipe','pipe','pipe'],
        });
      this.proc.on('error', e => this.fail(e));
      this.proc.once('exit', (code, signal) => {
        if (this.killTimer) clearTimeout(this.killTimer);
        this.fail(new Error('Codex App Server 退出：' + code + (signal ? ' / ' + signal : '')));
      });
      this.proc.stdin.on('error', e => this.fail(e));
      this.proc.stdout.on('data', bytes => this.feed(bytes));
      this.proc.stdout.on('error', e => this.fail(e));
      this.proc.stdout.once('end', () => this.fail(new Error('Codex App Server 输出连接已关闭')));
      this.proc.stderr.on('data', bytes => { this.stderr = (this.stderr + bytes.toString('utf8')).slice(-8192); });
      this.proc.stderr.on('error', e => this.emit('diagnostic', { type:'stderr-error', message:e.message }));
      const initialized = await this.request('initialize', {
        clientInfo:{name:'ai_hub',title:'AI Hub',version:'1'},
        capabilities:{experimentalApi:true},
      });
      await this.notify('initialized');
      this.initialized = initialized;
      return initialized;
    } catch (error) {
      this.fail(error);
      this.close();
      throw error;
    }
  }
  feed(bytes) {
    if (this.closed) return;
    this.buffer += this.decoder.write(bytes);
    let nl;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      if (Buffer.byteLength(line) > 32 * 1024 * 1024) {
        this.fail(new Error('Codex 单条协议消息超过 32 MiB，连接待核对')); return;
      }
      let msg;
      try { msg = JSON.parse(line); }
      catch (error) { this.fail(new Error('Codex 协议 JSON 损坏：' + error.message)); this.close(); return; }
      if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
        this.fail(new Error('Codex 协议消息格式无效')); this.close(); return;
      }
      if (msg.method) {
        if (msg.id != null) this.serverRequests.set(msg.id,msg);
        if (msg.method === 'serverRequest/resolved') this.serverRequests.delete(msg.params?.requestId);
        this.emit(msg.id == null ? 'notification' : 'server-request', msg);
        if (msg.id != null) setImmediate(()=>this.rejectOrphans());
      } else if (msg.id != null) {
        const pending = this.pending.get(msg.id);
        if (!pending) { this.emit('late-response', {id:msg.id}); continue; }
        this.pending.delete(msg.id);
        clearTimeout(pending.timer);
        if (msg.error) {
          const error = new Error(msg.error.message || 'Codex request failed');
          error.code = msg.error.code; error.data = msg.error.data; error.uncertain = false;
          pending.reject(error);
        } else if (Object.prototype.hasOwnProperty.call(msg,'result')) pending.resolve(msg.result);
        else pending.reject(Object.assign(new Error('Codex 响应缺少 result/error'),{uncertain:true}));
        setImmediate(()=>this.rejectOrphans());
      } else {
        this.fail(new Error('Codex 协议消息缺少身份')); this.close(); return;
      }
    }
    if (Buffer.byteLength(this.buffer) > 32 * 1024 * 1024) {
      this.fail(new Error('Codex 单条协议消息超过 32 MiB，连接待核对')); this.close();
    }
  }
  send(message, {beforeWrite} = {}) {
    if (this.closed || !this.proc) return Promise.reject(new Error('Codex 连接不可用'));
    const bytes = JSON.stringify(message) + '\n';
    const next = this.writeTail.then(() => new Promise((resolve, reject) => {
      if (this.closed) { reject(new Error('Codex 连接已断开')); return; }
      // A session can close while this shared transport is draining another
      // write. Reject that unsent intention without failing the other threads.
      try { beforeWrite?.(); }
      catch (error) { error.notSent = true; reject(error); return; }
      this.proc.stdin.write(bytes, 'utf8', error => error ? reject(error) : resolve());
    }));
    this.writeTail = next.catch(error => { if (!error.notSent) this.fail(error); });
    return next;
  }
  request(method, params, timeoutMs = this.options.timeoutMs || 60000, writeOptions) {
    const id = this.nextId++;
    return new Promise((resolve,reject) => {
      if (this.closed) { reject(new Error('Codex 连接不可用')); return; }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error('Codex 请求超时：' + method + '；结果待核对');
        error.uncertain = true;
        reject(error);
        setImmediate(()=>this.rejectOrphans());
      }, timeoutMs);
      this.pending.set(id,{resolve,reject,timer,method});
      this.send({id,method,params},writeOptions).catch(error => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); clearTimeout(timer);
        error.uncertain = !error.notSent;
        reject(error);
      });
    });
  }
  notify(method,params) { return this.send({method,...(params === undefined ? {} : {params})}); }
  respond(id,result) { this.serverRequests.delete(id); return this.send({id,result}); }
  rejectRequest(id,message) { this.serverRequests.delete(id); return this.send({id,error:{code:-32601,message}}); }
  rejectOrphans() {
    if (this.closed || [...this.pending.values()].some(p=>/^thread\/(start|resume|fork)$/.test(p.method))) return;
    for (const [id,msg] of this.serverRequests) {
      if (msg.claimed) continue;
      const message = 'Codex 交互无法匹配受管会话：'+msg.method;
      this.emit('diagnostic',{type:'unmatched-request',message,threadId:msg.params?.threadId});
      this.rejectRequest(id,message).catch(error=>this.fail(error));
    }
  }
  fail(error) {
    if (this.closed) return;
    this.closed = true;
    if (this.stderr.trim()) {
      let diagnostic=this.stderr.trim();
      for(const [key,value] of Object.entries(this.options.env || {})) {
        if (/token|secret|password|api.?key/i.test(key) && typeof value==='string' && value.length>6) diagnostic=diagnostic.split(value).join('[redacted]');
      }
      for (const argument of this.options.args || []) {
        const match=String(argument).match(/^([^=]*(?:token|secret|password|api.?key)[^=]*)=(.*)$/i);
        if (!match) continue;
        let value=match[2];
        try { value=JSON.parse(value); } catch { /* Non-JSON CLI literal. */ }
        if (typeof value==='string' && value.length>6) diagnostic=diagnostic.split(value).join('[redacted]');
      }
      error=new Error(error.message+'\n'+diagnostic);
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      const rejected = new Error(error.message);
      rejected.uncertain = true;
      pending.reject(rejected);
    }
    this.pending.clear();
    this.serverRequests.clear();
    this.emit('disconnect',{message:error.message});
    // A broken pipe is unusable even if the child has not exited. Retire only
    // this owned process so a reconnect cannot leak the abandoned server.
    this.close();
  }
  close() {
    const proc = this.proc;
    this.fail(new Error('Codex 连接已关闭'));
    if (!proc || this.closeRequested) return;
    this.closeRequested = true;
    proc.stdin.end();
    this.killTimer = setTimeout(() => {
      if (proc.exitCode != null || proc.signalCode != null) return;
      if (process.platform === 'win32') {
        const killer = spawn('taskkill.exe',['/pid',String(proc.pid),'/t','/f'],{windowsHide:true,stdio:'ignore'});
        killer.on('error',error => this.emit('diagnostic',{type:'cleanup-error',message:error.message}));
      } else proc.kill('SIGTERM');
    },5000);
    this.killTimer.unref?.();
  }
  async waitForExit() {
    const p=this.proc;
    if(!p || p.exitCode!==null || p.signalCode!==null)return;
    await new Promise((resolve,reject)=>{
      const done=()=>{clearTimeout(timer);resolve();};
      const timer=setTimeout(()=>{p.off('exit',done);reject(new Error('原 Codex 进程尚未退出，暂不重复恢复会话'));},7000);
      p.once('exit',done);
    });
  }
}
module.exports = { CodexAppServerClient, resolveNativeCommand };
