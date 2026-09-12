'use strict';
// Real Hub + IPC + native stdio fixture. No paid model calls or production state.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,seedUsageData,waitFor,click}=require('./helpers/usage-refresh-fixture');
const {setStaticSidebarLayout,measureQuota}=require('./helpers/sidebar-quota-geometry');
const j=JSON.stringify;
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-activity-quota-'));
  const data=path.join(root,'data'),fixture=seedUsageData(data,'regression');
  const out=path.resolve(process.env.HUB_ACTIVITY_QUOTA_OUT || 'output/activity-quota/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const now=Date.now(),cachePath=path.join(data,'usage-cache.json'),cache=JSON.parse(fs.readFileSync(cachePath,'utf8'));
  cache.claude.usage5h.resetsAt=now+80*60000;cache.claude.usage7d.resetsAt=now+76*3600000;
  fs.writeFileSync(cachePath,j(cache));
  const statusPath=path.join(data,'statusline-cache.json'),status=JSON.parse(fs.readFileSync(statusPath,'utf8'));
  status['session-usage-e2e'].usage5h.resetsAt=cache.claude.usage5h.resetsAt;
  status['session-usage-e2e'].usage7d.resetsAt=cache.claude.usage7d.resetsAt;fs.writeFileSync(statusPath,j(status));
  const cwd=path.join(root,'workspace');fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(fixture.codexHome,'config.toml'),'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  let hub,c;
  const evidence={sha:require('child_process').execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',windowsHide:true}).trim(),out,checks:[],passed:false};
  const check=(name,condition)=>{assert(condition,name);evidence.checks.push(name);console.log('PASS',name)};
  const until=expr=>waitFor(c,expr,45000);
  const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'))};
  const provider=p=>`.sidebar-quota-provider[data-provider="${p}"]`;
  const snapshot=()=>c.eval('accountUsageController.getSnapshot()');
  const reads=()=>fs.readFileSync(fixture.controlPath+'.requests','utf8').trim().split('\n').length;
  const send=async group=>{
    const selector=group?'#mr-input-box':'.floating-input-box',button=group?'#mr-send-btn':'.floating-input-send';
    await until(`(()=>{const b=document.querySelector(${j(button)});if(!b)return false;const r=b.getBoundingClientRect();return r.height>0 && b.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    await c.eval(`(()=>{const b=document.querySelector(${j(selector)});b.textContent='fixture:conversation';b.dispatchEvent(new Event('input',{bubbles:true}));b.focus()})()`);
    await click(c,button);
  };
  try {
    hub=await launchIsolatedHub({dataDir:data,port:await getFreePort(),windowMode:'hidden',label:'activity-quota',extraEnv:{
      APPDATA:fixture.fakeAppData,CODEX_HOME:fixture.codexHome,CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(__dirname,'fixtures/codex-app-server.js'),
      CLAUDE_HUB_EGRESS_FIXTURE:j({foreign:{ok:false,error:'isolated'},domestic:{ok:true,countryCode:'CN',country:'China',city:'Beijing',ip:'192.0.2.1'}})}});
    evidence.pid=hub.pid;evidence.port=hub.port;c=await connectFirstPage(hub);await c.send('Page.enable');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1600,height:1050,deviceScaleFactor:1,mobile:false});
    await until('typeof accountUsageController!=="undefined" && !!document.querySelector(".sidebar-quota-provider")');
    await click(c,provider('codex'));
    await until('accountUsageController.getSnapshot().codex?.source==="app-server"');
    check('isolated hook server listening',hub.log().some(s=>s.includes('hook server listening')));
    check('four provider buttons; no separate refresh icons',await c.eval('document.querySelectorAll("button.sidebar-quota-provider").length===4 && !document.querySelector(".sidebar-quota-refresh")'));
    const labels=await c.eval('[...document.querySelectorAll(".sidebar-quota-period")].map(e=>e.textContent)');evidence.labels=labels;
    check('reset countdowns replace fixed quota labels',labels[0]==='1h20m'&&labels[1]==='3d4h'&&labels[4]==='—');
    evidence.geometry=[];
    for(const zoom of [1,1.25])for(const width of [280,340,380,440]){
      await setStaticSidebarLayout(c,width,zoom);const g=await measureQuota(c);assert.deepEqual(g.overlaps,[],j({width,zoom,g}));assert.deepEqual(g.overflow,[],j({width,zoom,g}));evidence.geometry.push({width,zoom,g});
    }
    check('countdowns and amounts fit 280–440 px at 100% and 125%',true);
    await setStaticSidebarLayout(c,340,1);await shot('quota-default');
    const initial=await snapshot(),n=reads();await click(c,provider('claude'));
    await until('!!accountUsageController.getSnapshot().refresh.providers.claude.result');
    check('Claude click refresh is scoped and retains old data when no new observation',reads()===n&&(await snapshot()).claude.lastSeen===initial.claude.lastSeen);
    const release=path.join(data,'release-quota');fs.writeFileSync(fixture.controlPath,j({mode:'ring',percent:66,releasePath:release}));
    const before=await snapshot(),beforeReads=reads();await click(c,provider('codex')+' .sidebar-quota-track');
    await until('accountUsageController.getSnapshot().refresh.providers.codex.inFlight');
    await click(c,provider('codex')+' .sidebar-quota-name');await click(c,provider('deepseek'));
    await until('!!accountUsageController.getSnapshot().refresh.providers.deepseek.error');
    check('name/bar clicks share one in-flight request and loading stays accessible',reads()-beforeReads===1&&await c.eval(`document.querySelector(${j(provider('codex'))}).getAttribute('aria-busy')==='true'`));
    fs.writeFileSync(release,'release');await until('!accountUsageController.getSnapshot().refresh.providers.codex.inFlight');
    const after=await snapshot();check('Codex refresh updates only Codex',after.codex.usage5h.pct===66&&after.claude.lastSeen===before.claude.lastSeen&&after.deepseek.lastSeen===before.deepseek.lastSeen);
    fs.writeFileSync(fixture.controlPath,j({error:true}));await click(c,provider('codex'));await until('!!accountUsageController.getSnapshot().refresh.providers.codex.error');
    const failed=await snapshot();check('failed refresh retains quota and exposes provider error',failed.codex.lastSeen===after.codex.lastSeen&&await c.eval(`document.querySelector(${j(provider('codex'))}).dataset.state==='error' && document.querySelector(${j(provider('codex'))}).title.includes('失败')`));
    await shot('quota-failure');
    const opts={cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none'};
    const session=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts})})`);
    await until(`!!document.querySelector('.session-item[data-session-id="${session.id}"]')`);await click(c,`.session-item[data-session-id="${session.id}"]`);
    await until('!!document.querySelector(".floating-input-box")');await send(false);
    const header='#msg-overlay .turn-card.assistant .conversation-header-activity:not([hidden])';
    await until(`!!document.querySelector(${j(header)})`);
    check('ordinary activity is beside progress and initially closed',await c.eval(`(()=>{const d=document.querySelector(${j(header)});return !d.open&&d.parentElement.classList.contains('turn-head')&&d.previousElementSibling.textContent==='进展'})()`));
    await click(c,header+' > summary');await until(`document.querySelector(${j(header)}).open`);
    await until('!!document.querySelector("#msg-overlay [data-phase=final_answer]")');
    check('header remains open after final message and native updates',await c.eval(`document.querySelector(${j(header)}).open`));
    check('old activity card consumes zero height',await c.eval('[...document.querySelectorAll("#msg-overlay [data-phase=activity]")].every(e=>e.getBoundingClientRect().height===0)'));
    await click(c,header+' .turn-activity-rail > summary');await click(c,header+' .tc-row-with-result > summary');
    await until(`document.querySelector(${j(header)}).textContent.includes('1 test passed')`);
    await shot('ordinary-activity-open');
    const copy=header+' [data-action="tc-copy-result"]';
    await click(c,copy);await until('require("electron").clipboard.readText()==="1 test passed"');check('tool result copy resolves original activity source',true);
    await click(c,header+' > summary');await shot('ordinary-default');
    await c.send('Page.reload');await until(`typeof sessions!=="undefined" && !!document.querySelector('.session-item[data-session-id="${session.id}"]')`);await click(c,`.session-item[data-session-id="${session.id}"]`);
    await until(`!!document.querySelector('#msg-overlay [data-phase=final_answer]') && document.querySelectorAll('#msg-overlay .conversation-progress-row').length===2 && document.querySelector(${j(header)})?.closest('.turn-card').dataset.phase==='commentary'`);
    check('history replay keeps activity collapsed with no trailing block',await c.eval(`!document.querySelector(${j(header)}).open && [...document.querySelectorAll('#msg-overlay [data-phase=activity]')].every(e=>e.getBoundingClientRect().height===0)`));
    for(const scene of ['general','dev']){
      const group=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'活动收起验收 '+scene,groupChat:true,scene,workspace:cwd,slots:[{kind:'codex',...opts}]})})`);
      await until(`!!document.querySelector('[data-meeting-id="${group.id}"]')`);
      if(await c.eval(`activeMeetingId!==${j(group.id)}`))await click(c,`[data-meeting-id="${group.id}"]`);
      await until(`activeMeetingId===${j(group.id)} && !!document.querySelector('#mr-input-box')`);await send(true);
      const g='.mr-gc-messages .mr-gc-meta .conversation-header-activity';await until(`!!document.querySelector(${j(g)})`);
      check(scene+' group activity in agent header, initially closed',await c.eval(`!document.querySelector(${j(g)}).open`));await click(c,g+' > summary');
      await until('!!document.querySelector(".mr-gc-messages [data-phase=final_answer]")');check(scene+' group updates preserve open state and omit old activity section',await c.eval(`document.querySelector(${j(g)}).open && !document.querySelector('.mr-gc-bubble .conversation-entry[data-phase=activity]')`));
      await click(c,g+' .conversation-activity > summary');await shot('group-'+scene+'-open');await click(c,g+' > summary');await shot('group-'+scene+'-default');
    }
    evidence.passed=true;
  } catch(error){evidence.error=error.stack;throw error;}
  finally{if(c){try{await shot('last')}catch(e){evidence.screenshotError=e.message}await c.close()}if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));evidence.exit=await gracefulQuit(hub)}fs.writeFileSync(path.join(out,'evidence.json'),j(evidence));console.log(j({out,passed:evidence.passed,error:evidence.error}));}
}
main().catch(e=>{console.error(e);process.exitCode=1});
