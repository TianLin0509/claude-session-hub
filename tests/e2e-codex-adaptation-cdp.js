'use strict';
// Real Codex TUI and real Hub UI. Fault injection is confined to the final UI error check.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0,'127.0.0.1',() => { const p=s.address().port; s.close(()=>resolve(p)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-adaptation-'));
  const out = path.resolve('artifacts/codex-adaptation/'+Date.now()); fs.mkdirSync(out,{recursive:true});
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
    async function snapshot(label) {
      const r=await c.eval(`(()=>{const s=sessions.get(${j(s.id)}),row=document.querySelector('.session-item[data-session-id="${s.id}"]'),dot=row?.querySelector('.sl-dot');return {status:s.status,runtime:getSessionRuntimeTruth(s),dot:dot?.className,color:dot&&getComputedStyle(dot).backgroundColor,rowState:row?.dataset.runtimeState,composer:document.querySelector('.fi-status-text')?.textContent};})()`);
      report[label]=r;console.log(label,JSON.stringify(r));await shot(label);
    }
    await open(s.id);await sleep(4000);await snapshot('new-idle');
    await send(s.id,'只回复 AUDIT_INITIAL'); await response(s.id,'AUDIT_INITIAL');
    await snapshot('after-reply'); const old = await c.eval(`({...sessions.get(${j(s.id)})})`);
    report.checks.push('real CLI first prompt, native transcript, completion');
    await sleep(1500);
    await c.eval(`document.querySelector('.composer-thinking').click()`);
    await until(`!!document.querySelector('.effort-picker-menu [data-effort="high"]')`,'effort option');
    await c.eval(`document.querySelector('.effort-picker-menu [data-effort="high"]').click()`);
    await until(`sessions.get(${j(s.id)}).effort==='high'&&!sessions.get(${j(s.id)})._modelSwitchPending`,'real effort switch',30000);
    report.checks.push('real UI model picker changes reasoning to high');
    await send(s.id, 'Run exactly one shell command: node -e "setTimeout(()=>console.log(123),15000)". Then reply ADAPT_DONE. Do not run other commands.');
    await until(`getSessionRuntimeTruth(sessions.get(${j(s.id)})).state==='running'`,'busy');
    await c.eval(`document.querySelector('.composer-thinking').click()`);
    await until(`!!document.querySelector('.effort-picker-menu [data-effort="low"]')`,'busy effort option');
    await c.eval(`document.querySelector('.effort-picker-menu [data-effort="low"]').click()`);
    await until(`document.querySelector('.effort-picker-menu')?.textContent.includes('\u5207\u6362\u5931\u8d25')`,'visible busy rejection');
    await sleep(1000);assert.equal(await c.eval(`getSessionRuntimeTruth(sessions.get(${j(s.id)})).state`),'running');
    await c.eval(`document.body.click()`);await response(s.id,'ADAPT_DONE');
    report.checks.push('busy settings rejection leaves the real task running and completing');
    await sleep(1500);await c.close();c=null;await gracefulQuit(hub);hub=null;
    const shift = 2*60*60*1000;
    const file=old.transcriptPath;
    fs.writeFileSync(file,fs.readFileSync(file,'utf8').split('\n').map(line=>{if(!line.trim())return line;const r=JSON.parse(line);if(r.timestamp)r.timestamp=new Date(Date.parse(r.timestamp)-shift).toISOString();return JSON.stringify(r);}).join('\n'));
    const stateFile=path.join(root,'data','state.json');const state=JSON.parse(fs.readFileSync(stateFile,'utf8'));for(const x of state.sessions||[])for(const k of ['lastMessageTime','lastCompletedAt','lastRunStartedAt','runStartedAt'])if(x[k])x[k]-=shift;fs.writeFileSync(stateFile,JSON.stringify(state));
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),CLAUDE_HUB_HOME_DIR:path.join(root,'home')}});
    c=await connectFirstPage(hub);await until('typeof sessions!=="undefined"','renderer restart');await open(s.id);await sleep(6000);await snapshot('after-old-history-reopen');
    report.flags=await c.eval(`(()=>{const x=sessions.get(${j(s.id)});return {cardWorkingSince:x.cardWorkingSince,cardWorkingSource:x.cardWorkingSource,agentWorking:x._agentWorking,runStartedAt:x.runStartedAt};})()`);
    assert.equal(report['after-old-history-reopen'].status,'idle');
    assert.equal(report['after-old-history-reopen'].color,'rgb(59, 130, 246)');
    assert(!report.flags.cardWorkingSince);assert(!report.flags.agentWorking);
    report.checks.push('old completed history restores blue ready without replaying running flags');
    await c.eval(`observeSessionRuntime(${j(s.id)},{state:'unknown',source:'audit-injection',confidence:'none',observedAt:Date.now()});scheduleSessionListRender();scheduleFloatingBarState()`);
    await until(`document.querySelector('.session-item[data-session-id="${s.id}"] .sl-dot')?.classList.contains('unknown')`,'unknown dot');
    assert.equal(await c.eval(`document.querySelector('.session-item[data-session-id="${s.id}"] .sl-dot')&&getComputedStyle(document.querySelector('.session-item[data-session-id="${s.id}"] .sl-dot')).backgroundColor`),'rgba(0, 0, 0, 0)');
    report.checks.push('isolated UI injection: unknown status has a distinct hollow dot');
    await c.eval(`observeSessionRuntime(${j(s.id)},{state:'idle',source:'audit-restore',confidence:'authoritative',observedAt:Date.now()});scheduleSessionListRender();scheduleFloatingBarState()`);
    await sleep(300);await shot('ready-final');
    report.passed=true;
  } catch(error) { report.error=error.stack; if(c) await shot('failure').catch(()=>{}); throw error; }
  finally {
    try {
      if(c)await c.close();
      if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}
    } catch(error) {
      report.teardownError=error.stack; report.passed=false; process.exitCode=1;
    } finally {
      fs.rmSync(path.join(home,'auth.json'),{force:true});
      fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2)); console.log(JSON.stringify(report,null,2));
    }
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
