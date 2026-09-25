'use strict';
// Real isolated Hub, native transport fixtures, real mouse/keyboard input.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,waitFor}=require('./helpers/usage-refresh-fixture');
const j=JSON.stringify;
async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-layout-boundaries-'));
  const out=path.resolve(process.env.HUB_BOUNDARIES_OUT || 'artifacts/session-ui-bounds/boundaries');fs.mkdirSync(out,{recursive:true});
  const workspace=path.join(root,'workspace');fs.mkdirSync(workspace);
  let hub,c;const evidence={passed:false,checks:[]};
  const check=(label,data,pass)=>{evidence.checks.push({label,data,passed:pass});assert(pass,label+': '+j(data));console.log('PASS '+label)};
  const until=expr=>waitFor(c,expr,45000);
  const frames=()=>c.eval('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
  const shot=async name=>{const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'))};
  const click=async selector=>{
    await c.eval(`document.querySelector(${j(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await until(`(()=>{const e=document.querySelector(${j(selector)}),r=e?.getBoundingClientRect();return r?.height>0&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`);
    const p=await c.eval(`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  };
  const send=async(text,group=false)=>{await click(group?'#mr-input-box':'#terminal-panel .floating-input-box');await c.send('Input.insertText',{text});await click(group?'#mr-send-btn':'#terminal-panel .floating-input-send')};
  const probe=()=>c.eval(`(()=>{const panel=document.querySelector('#terminal-panel'),overlay=panel.querySelector('.msg-overlay'),bar=panel.querySelector('.floating-input-bar'),input=bar.querySelector('.floating-input-box'),jump=panel.querySelector('#card-jump-latest');const rect=e=>{const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right}};const ir=input.getBoundingClientRect();return {bar:rect(bar),overlay:rect(overlay),input:rect(input),inputScroll:input.scrollHeight,inputClient:input.clientHeight,composer:rect(bar.querySelector('.composer')),nav:rect(panel.querySelector('#card-question-nav')),jump:jump&&!jump.hidden?rect(jump):null,hit:input.contains(document.elementFromPoint(ir.x+ir.width/2,ir.y+ir.height/2)),reserved:parseFloat(panel.style.getPropertyValue('--fi-bar-h'))}})()`);
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await getFreePort(),windowMode:'hidden',label:'layout-boundaries',extraEnv:{
      CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js')}});
    c=await connectFirstPage(hub);await c.send('Page.enable');await until('typeof sessions!=="undefined" && !!window.LaunchCenter');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    const opts={kind:'claude',model:'claude-opus-5[1m]',effort:'high',mcpProfile:'none'};
    const session=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'claude',opts:{...opts,cwd:workspace}})})`);
    await until(`document.querySelector('#terminal-panel .floating-input-bar')?.dataset.sessionId===${j(session.id)}`);
    await send('fixture:layout');await until('document.querySelector("#msg-overlay")?.textContent.includes("段落 42")');
    const expand='#msg-overlay .conversation-long-message > summary';
    if(await c.eval(`!!document.querySelector(${j(expand)})`))await click(expand);
    for(const [width,height,zoom] of [[1440,900,1],[1050,700,1],[1440,900,1.25]]){
      await c.send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
      await c.eval(`require('electron').webFrame.setZoomFactor(${zoom})`);await frames();
      const before=await probe();
      await click('#terminal-panel .floating-input-box');await c.send('Input.insertText',{text:Array.from({length:12},(_,i)=>'草稿 '+i).join('\n')});await frames();
      const after=await probe();
      check('Claude fixed composer and clipped stage '+width+'@'+zoom,{before,after},
        // Fixed means "typing never grows it" -- the pixel height itself is a
        // style decision (212 until 4ced644 made it 164 on 2026-09-21).
        after.bar.height>0&&Math.abs(after.bar.height-before.bar.height)<2&&Math.abs(after.overlay.bottom-before.overlay.bottom)<2&&
        after.overlay.bottom<=after.bar.top+1&&after.overlay.bottom<=after.composer.top+1&&
        after.nav.bottom<=after.bar.top+1&&after.inputScroll>after.inputClient&&after.hit);
      // Scroll the actual transcript all the way down; the complete last card must be visible.
      const p=await c.eval(`(()=>{const e=document.querySelector('#msg-overlay'),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:10000});
      await until(`(()=>{const e=document.querySelector('#msg-overlay');return e.scrollHeight-e.clientHeight-e.scrollTop<3})()`);
      const tail=await c.eval(`(()=>{const e=document.querySelector('#msg-overlay'),card=[...e.querySelectorAll('.turn-card')].filter(n=>n.getBoundingClientRect().height>0).at(-1),r=card.getBoundingClientRect();return {cardBottom:r.bottom,cardHeight:r.height,hasFinalParagraph:card.textContent.includes('段落 42'),viewportBottom:e.getBoundingClientRect().bottom}})()`);
      check('last Claude card fully visible '+width+'@'+zoom,tail,tail.cardHeight>0&&tail.hasFinalParagraph&&tail.cardBottom<=tail.viewportBottom+1);
      await shot('claude-bottom-'+width+'-'+zoom);
      await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',...p,deltaX:0,deltaY:-300});await until('!document.querySelector("#card-jump-latest").hidden');await frames();
      const reading=await probe();check('back-to-latest stays above composer '+width+'@'+zoom,reading,reading.jump?.bottom<=reading.bar.top+1);
      await shot('claude-'+width+'-'+zoom);
    }
    await c.eval("require('electron').webFrame.setZoomFactor(1)");
    const group=await c.eval(`ipcRenderer.invoke('create-meeting',${j({title:'Claude 群聊滚动验收',groupChat:true,scene:'general',workspace,slots:[opts]})})`);
    await until(`!!document.querySelector('[data-meeting-id="${group.id}"]')`);await click(`[data-meeting-id="${group.id}"]`);
    await until('!!document.querySelector("#mr-input-box")');await send('fixture:layout',true);
    await until('!!document.querySelector(".mr-gc-msg.ai:not(.pending) .gc-journal-text") && document.querySelector(".mr-gc-msg.ai .gc-journal-text").textContent.includes("段落 42")');
    await until('!!document.querySelector(".mr-gc-msg.ai.gc-journal-long")');await click('.mr-gc-msg.ai .gc-journal-expand');
    for(const theme of ['dark','codex']){
      await click('#btn-theme');await click(`#theme-menu [data-theme-id="${theme}"]`);await until(`document.documentElement.dataset.theme===${j(theme)}`);
      if(await c.eval('!document.querySelector("#theme-menu").classList.contains("hidden")'))await click('#btn-theme');
      await click('.mr-gc-msg.ai .conversation-header-activity > summary');
      await until('document.querySelector(".mr-gc-msg.ai .conversation-header-activity").open');
      check('Claude activity disclosure opens '+theme,null,true);await click('.mr-gc-msg.ai .conversation-header-activity > summary');
      const measure=()=>c.eval(`(()=>{const card=document.querySelector('.mr-gc-msg.ai'),s=card.closest('.mr-gc-messages'),r=s.getBoundingClientRect();return {scroll:s.scrollTop,head:card.querySelector('.mr-gc-meta').getBoundingClientRect().top,avatar:card.querySelector('.mr-gc-avatar').getBoundingClientRect().top,body:card.querySelector('.gc-journal-text').getBoundingClientRect().top,x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await c.eval("document.querySelector('.mr-gc-msg.ai .mr-gc-meta').scrollIntoView({block:'start'})");await frames();const before=await measure();
      await c.send('Input.dispatchMouseEvent',{type:'mouseWheel',x:before.x,y:before.y,deltaX:0,deltaY:260});await until(`document.querySelector('.mr-gc-messages').scrollTop>${before.scroll+200}`);await frames();
      const after=await measure(),delta=after.scroll-before.scroll;
      check('Claude group header and avatar scroll '+theme,{before,after},['head','avatar','body'].every(k=>Math.abs(after[k]-before[k]+delta)<3));await shot('group-claude-'+theme);
    }
    evidence.passed=true;
  }catch(error){evidence.error=error.stack;throw error;}
  finally{if(c){try{await shot('last')}catch(error){evidence.captureError=error.message}await c.close()}if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));evidence.exit=await gracefulQuit(hub)}fs.writeFileSync(path.join(out,'evidence.json'),j(evidence));console.log(j(evidence));}
}
main().catch(error=>{console.error(error);process.exitCode=1});
