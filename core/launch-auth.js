'use strict';

// Only an explicit login failure opens a window. Network failures and unknown
// observations must never log a user out or repeatedly create login windows.
//
// 2026-10-14: every probe is a child process (`claude auth status` ~0.5–0.8 s,
// `codex login status` ~0.2–0.3 s) and starting one on Windows blocks the main
// process for 20–190 ms. Creating a two-member group used to probe four times
// in a row. A recent answer is now reused: a login seen within the account
// page's own freshness window (5 min) is trusted, and an inconclusive probe is
// not repeated for a minute. A login that expires in between is still caught —
// the CLI reports it and recover() below opens the official login.
const SIGNED_IN_REUSE_MS = 5 * 60 * 1000;
const INCONCLUSIVE_REUSE_MS = 60 * 1000;
class LaunchAuth {
  constructor({accounts, getConfig, notify = () => {}, now = Date.now}) {
    Object.assign(this, {accounts, getConfig, notify, now});
    this.flights = new Map();
    this.recoveryAt = new Map();
    this.passedAt = new Map();
  }
  connection(kind, opts = {}) {
    const base = String(kind || '').replace(/-resume$/, '');
    const config = this.getConfig();
    if (base === 'codex') {
      if (config.codexBackend === 'api' || require('./chatgpt-web-models').isChatgptWebModel(opts.model)) return null;
      return 'codex-' + (opts.launchProfile || config.codexSubscriptionProfile || 'default');
    }
    if (base === 'claude') return config.claudeBackend === 'api' ? null : 'claude';
    return ({gemini:'gemini-cli', kimi:'kimi'})[base] || null;
  }
  async ensure(kind, opts = {}) {
    const id = this.connection(kind, opts);
    if (!id) return;
    const passed = this.passedAt.get(id);
    if (passed && this.now() - passed.at < passed.ttl) return;
    if (this.flights.has(id)) return this.flights.get(id);
    const flight = this.checkAndOpen(id).finally(() => this.flights.delete(id));
    this.flights.set(id, flight);
    return flight;
  }
  async recover(kind, opts, failure) {
    if (!isLoginFailure(failure)) return;
    const id=this.connection(kind,{...opts,launchProfile:opts?.codexProfile});
    if (id) this.passedAt.delete(id);
    if (!id || Date.now()-(this.recoveryAt.get(id)||0)<60000) return;
    this.recoveryAt.set(id,Date.now());
    try {
      const result=await this.accounts.login(id);
      this.notify({id,pending:result.pending!==false,message:'登录已失效，已打开对应账号的官方登录界面；完成后请恢复或重启会话，已发送的问题不会自动重发。'});
    } catch(error) {this.notify({id,success:false,message:'需要登录，登录入口未能打开：'+error.message});}
  }
  pass(id, ttl) { this.passedAt.set(id, {at: this.now(), ttl}); }
  async checkAndOpen(id) {
    // The account page keeps the last observation on disk; a fresh one answers
    // the question without starting another process.
    let recent = null;
    try { recent = await this.accounts.recentObservation?.(id); } catch {}
    if (recent?.state === 'signed_in' && this.now() - (Number(recent.observedAt) || 0) < SIGNED_IN_REUSE_MS) {
      this.passedAt.set(id, {at: Number(recent.observedAt), ttl: SIGNED_IN_REUSE_MS});
      return;
    }
    let proof;
    try { proof = await this.accounts.check(id, {quiet:true, resume:false}); }
    catch { this.pass(id, INCONCLUSIVE_REUSE_MS); return; } // Preserve the normal launch error when status is unknown.
    if (proof.state !== 'login_required') {
      this.pass(id, proof.state === 'signed_in' ? SIGNED_IN_REUSE_MS : INCONCLUSIVE_REUSE_MS);
      return;
    }
    this.passedAt.delete(id);
    let result;
    try { result = await this.accounts.login(id); }
    catch (error) { throw Object.assign(new Error('需要登录，但登录入口未能打开：' + error.message), {code:'auth_required'}); }
    const message = '已打开对应账号的官方登录界面，请完成登录后再启动；本次尚未启动会话。';
    this.notify({id, message, pending:result.pending !== false});
    throw Object.assign(new Error(message), {code:'auth_required'});
  }
}
function isLoginFailure(failure) {
  if (failure?.code==='auth_required') return true;
  const text=typeof failure==='string'?failure:failure?.message || '';
  return /(?:^|\n|:\s)(?:not logged in|please (?:run )?\/login|authentication required|login required|oauth token (?:has )?expired|登录失效|需要登录)/i.test(text)
    || /\b401\b[^\n]{0,60}\bunauthorized\b/i.test(text);
}
module.exports = {LaunchAuth,isLoginFailure,SIGNED_IN_REUSE_MS,INCONCLUSIVE_REUSE_MS};
