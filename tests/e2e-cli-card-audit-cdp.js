'use strict';
// Real Codex TUI and real Hub UI. Fault injection is confined to the final UI error check.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',() => { const p=s.address().port; s.close(()=>resolve(p)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-cli-card-audit-'));
  const out = path.resolve('artifacts/cli-card-audit/'+Date.now()); fs.mkdirSync(out,{recursive:true});
  const home = path.join(root,'codex'), cwd = path.join(root,'workspace');
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const source = process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(),'.codex');
  for (const name of ['auth.json','models_cache.json']) if (fs.existsSync(path.join(source,name))) fs.copyFileSync(path.join(source,name),path.join(home,name));
  const model = process.env.REAL_CODEX_MODEL || 'gpt-5.6-sol';
  fs.writeFileSync(path.join(home,'config.toml'), `model = ${j(model)}\nmodel_reasoning_effort = "low"\n[tui.model_availability_nux]\n${j(model)} = 4\n`);
  const report = { root,out,checks:[],passed:false }; let hub,c;
  report.checks.push = function(...items) { console.log('[audit] '+items.join('; ')); return Array.prototype.push.apply(this,items); };
  const until = async (expr,label,timeout=120000) => { const end=Date.now()+timeout; while(Date.now()<end) { if(await c.eval(expr))return; await sleep(200); } throw Error('timeout '+label); };
  const invoke = (channel,arg) => c.eval(`ipcRenderer.invoke(${j(channel)},${j(arg)})`);
  const shot = async name => { const r=await c.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64')); };
  const open = async id => { await until(`!!document.querySelector('.session-item[data-session-id="${id}"]')`,'sidebar'); await c.eval(`document.querySelector('.session-item[data-session-id="${id}"]').click()`); await until('!!document.querySelector(".floating-input-box")','composer'); };
  const send = async (id,text) => { await open(id); await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${id}"]'); const i=b.querySelector('.floating-input-box'); i.textContent=${j(text)};i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click();})()`); };
  const response = async (id,marker) => {
    await until(`(async()=>{const r=await ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(id)},opts:{limit:8,fromTail:true}});return (r.turns||[]).some(t=>t.role==='assistant'&&String(t.text||'').includes(${j(marker)}));})()`,marker);
    await until(`['completed','idle'].includes(getSessionRuntimeTruth(sessions.get(${j(id)})).state)`,'settled '+marker);
  };
  try {
    hub = await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_HOME_DIR:path.join(root,'home')}});
    c = await connectFirstPage(hub);
    await until('typeof sessions!=="undefined"','renderer');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    const s = await invoke('create-session',{kind:'codex',opts:{cwd,model,effort:'low',mcpProfile:'none'}});
    assert(s.id); report.sessionId=s.id;
    await send(s.id,'只回复 AUDIT_INITIAL'); await response(s.id,'AUDIT_INITIAL');
    const old = await c.eval(`({...sessions.get(${j(s.id)})})`);
    report.checks.push('real CLI first prompt, native transcript, completion');
    await send(s.id,'/new');
    await until(`!document.querySelector('.floating-input-bar[data-session-id="${s.id}"] .floating-input-send').disabled`,'new submitted');
    await send(s.id,'只回复 AUDIT_NEW'); await response(s.id,'AUDIT_NEW');
    const fresh = await c.eval(`sessions.get(${j(s.id)}).codexSid`);
    assert.notEqual(fresh,old.codexSid); report.checks.push('real /new rebind and next prompt');
    const historyRequest = {kind:'codex',opts:{cwd,model,effort:'low',mcpProfile:'none',useResume:true,codexSid:old.codexSid,codexSessionsRoot:old.codexSessionsRoot,resumeTranscriptPath:old.transcriptPath}};
    await assert.rejects(invoke('create-session',historyRequest), /已在 AI HUB/);
    report.checks.push('old history remains locked while original Codex process owns its writer');
    const fork = await invoke('fork-session',{sourceSessionId:s.id});
    const forkId = fork.session?.id || fork.id; assert(forkId,JSON.stringify(fork));
    await send(forkId,'只回复 AUDIT_FORK'); await response(forkId,'AUDIT_FORK');
    assert.notEqual(await c.eval(`sessions.get(${j(forkId)}).codexSid`),fresh);
    report.checks.push('real fork binds its own thread and cards');
    const restart = await invoke('restart-session',s.id); assert(restart.id || restart.session?.id,JSON.stringify(restart));
    await send(s.id,'只回复 AUDIT_RESTART'); await response(s.id,'AUDIT_RESTART');
    assert.equal(await c.eval(`sessions.get(${j(s.id)}).codexSid`),fresh);
    report.checks.push('real session restart retains identity, sidebar and history');
    const history = await invoke('create-session',historyRequest); assert(history.id,JSON.stringify(history));
    await send(history.id,'只回复 AUDIT_OLD_REOPEN'); await response(history.id,'AUDIT_OLD_REOPEN');
    report.checks.push('old history reopens after original process has released its writer');
    await open(s.id);
    await c.eval(`applyViewMode('card')`);
    await until(`!!document.querySelector('#msg-overlay [data-action="resend"]')`,'card resend');
    // Deliberate failed response: proves the actual click handler shows failure, not backend E2E.
    await c.eval(`(()=>{window.__auditInvoke=ipcRenderer.invoke;ipcRenderer.invoke=function(ch,...args){if(ch==='session:send-prompt')return Promise.resolve({ok:false,notSent:true,message:'AUDIT_REJECTED'});return window.__auditInvoke.call(this,ch,...args);};document.querySelector('#msg-overlay [data-action="resend"]').click();})()`);
    await until(`document.querySelector('.native-card-send-error')?.textContent.includes('AUDIT_REJECTED')`,'visible failed resend');
    await c.eval(`ipcRenderer.invoke=window.__auditInvoke;delete window.__auditInvoke`);
    report.checks.push('isolated UI fault injection: card resend rejection visibly reported');
    await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar');floatingPromptDeliveries.set(${j(s.id)},{status:'stuck'});markFloatingInputStuck(b,${j(s.id)});})()`);
    assert.equal(await c.eval(`!!document.querySelector('.fi-stuck')`),false);
    await shot('cards-without-submit-banner'); report.checks.push('isolated UI receipt injection: no unconfirmed banner or resend button');
    await send(history.id,'/quit');
    await until(`(async()=>require('../core/host-shell-detector').detectHostShellTakeover(await ipcRenderer.invoke('debug:get-session-buffer',${j(history.id)})))()`,'CLI exits to host shell');
    const shellText='Write-Output AUDIT_MUST_NOT_EXECUTE';
    await send(history.id,shellText);
    await until(`document.querySelector('.floating-input-bar[data-session-id="${history.id}"] .floating-input-box')?.textContent===${j(shellText)}`,'rejected text restored');
    const buffer=await invoke('debug:get-session-buffer',history.id);
    assert(!buffer.includes('AUDIT_MUST_NOT_EXECUTE'),'card prompt must not enter the host shell');
    report.checks.push('real CLI exit: card prompt rejected before shell write and restored to composer');
    report.passed=true;
  } catch(error) { report.error=error.stack; if(c) await shot('failure').catch(()=>{}); throw error; }
  finally {
    if(c)await c.close();
    if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}
    fs.rmSync(path.join(home,'auth.json'),{force:true});
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
