'use strict';
// Real isolated Hub UI with card content fixtures.
// Live Claude startup and first reply are tested separately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
async function main(){
  const out=path.resolve('artifacts/20261006-card-disclosure-codex1/'+Date.now());fs.mkdirSync(out,{recursive:true});
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-disclosure-nav-'));
  const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
  const report={checks:[],passed:false};let hub,c;
  const check=(name,value)=>{assert(value,name);report.checks.push(name);};
  const until=async(expr)=>{for(let n=0;n<150;n++){if(await c.eval(expr))return;await sleep(100);}throw Error('timeout '+expr);};
  async function click(selector){
    await c.eval(String.raw`document.querySelector(${j(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);await sleep(40);
    const pos=await c.eval(String.raw`(()=>{const r=document.querySelector(${j(selector)}).getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});
    await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});await sleep(50);
  }
  try{
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port,windowMode:'hidden',extraEnv:{CLAUDE_HUB_E2E:'1',CLAUDE_HUB_HOME_DIR:path.join(root,'home'),CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude')}});
    c=await connectFirstPage(hub);await until('!!window.__hubE2E?.cardQuestionNavigator');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1450,height:1000,deviceScaleFactor:1,mobile:false});
    await c.eval(String.raw`__hubE2E.cardQuestionNavigator.mountFixture({count:0});
      window.__longText=Array.from({length:45},(_,i)=>'正文第 '+i+' 行，完整保留可阅读消息。').join('\n');
      window.__refreshCard=(sid,kind,text=__longText)=>_mountSessionTurnCard(sid,{id:'disclosure-same-id',role:'assistant',kind,phase:'final_answer',text,ts:1234},{kind,container:document.getElementById('msg-overlay')});`);
    const sel='#msg-overlay .turn-card[data-turn-id="disclosure-same-id"] .conversation-long-message';
    for(const kind of ['claude','codex','gemini','kimi','deepseek']){
      await c.eval(String.raw`document.getElementById('msg-overlay').innerHTML='';_sessionTurns.clear();__refreshCard('disclosure-'+${j(kind)},${j(kind)})`);
      check(kind+' message defaults expanded',await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
      await click(sel+' > summary');check(kind+' explicit collapse',!await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
      await c.eval(String.raw`__refreshCard('disclosure-'+${j(kind)},${j(kind)},__longText+'\n刷新后新增的内容')`);
      check(kind+' collapse survives live patch',!await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
      await c.eval(String.raw`document.getElementById('msg-overlay').innerHTML='';__refreshCard('disclosure-'+${j(kind)},${j(kind)},__longText+'\n重新进入')`);
      check(kind+' collapse survives remount',!await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
      await click(sel+' > summary');await c.eval(String.raw`__refreshCard('disclosure-'+${j(kind)},${j(kind)},__longText+'\n再次刷新')`);
      check(kind+' expansion survives live patch',await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
    }
    await c.eval(String.raw`document.getElementById('msg-overlay').innerHTML='';__refreshCard('other-session','claude')`);
    check('same turn ID in a different session is independent',await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
    // A newly inserted disclosure must not steal the message's prior UI state.
    await click(sel+' > summary');
    await c.eval(String.raw`document.querySelector(${j(sel)}).before(Object.assign(document.createElement('details'),{className:'turn-thinking',open:true}));__refreshCard('other-session','claude',__longText+'\n更多内容')`);
    check('new disclosure cannot reset the message',!await c.eval(String.raw`document.querySelector(${j(sel)}).open`));
    await c.eval(String.raw`document.getElementById('msg-overlay').innerHTML='';__refreshCard('code-session','codex', '\x60\x60\x60js\n'+Array.from({length:40},(_,i)=>'console.log('+i+');').join('\n')+'\n\x60\x60\x60')`);
    check('long code block defaults expanded',await c.eval(String.raw`document.querySelector('#msg-overlay .code-block-wrap pre').style.display!=='none'`));
    await click('#msg-overlay [data-action="code-collapse"]');await c.eval(String.raw`__refreshCard('code-session','codex','\x60\x60\x60js\n'+Array.from({length:41},(_,i)=>'console.log('+i+');').join('\n')+'\n\x60\x60\x60')`);
    check('manual code collapse survives update',await c.eval(String.raw`document.querySelector('#msg-overlay .code-block-wrap pre').style.display==='none'`));
    const group=await c.eval(String.raw`(()=>{const journal=require('./groupchat-journal'),p=document.createElement('div');p.id='disclosure-group-fixture';p.className='mr-gc-messages';document.getElementById('msg-overlay').append(p);
      window.__groupMount=()=>{p.innerHTML='<article class="mr-gc-msg ai" '+journal.attributes({id:'disclosure-group'},{sid:'a',turnNum:1},s=>String(s).replaceAll('"','&quot;'))+'><div class="mr-gc-msg-body"><div class="mr-gc-meta">AI</div><div class="mr-gc-bubble-row"><div class="mr-gc-bubble"><div class="gc-journal-reading">'+journal.disclosure()+'<div class="gc-journal-text">'+__longText.replaceAll('\n','<br>')+'</div></div></div></div></div></article>';journal.enhance(p);};
      p.addEventListener('click',e=>journal.handle(e,p));__groupMount();return p.querySelector('article').dataset.journalExpanded;})()`);
    check('group answer defaults expanded',group==='true');await click('#disclosure-group-fixture .gc-journal-expand');
    await c.eval('__groupMount()');check('group manual collapse survives refresh',await c.eval(String.raw`document.querySelector('#disclosure-group-fixture article').dataset.journalExpanded==='false'`));
    await click('#disclosure-group-fixture .gc-journal-expand');await c.eval('__groupMount()');check('group expansion survives refresh',await c.eval(String.raw`document.querySelector('#disclosure-group-fixture article').dataset.journalExpanded==='true'`));
    const shot=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'expanded-cards.png'),Buffer.from(shot.data,'base64'));
    report.passed=true;
  }catch(e){report.error=e.stack;console.error(e.stack);process.exitCode=1;}
  finally{try{if(c)await c.close();if(hub)await gracefulQuit(hub);}catch(e){report.cleanupError=e.stack;report.passed=false;process.exitCode=1;}fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log(out,report);}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
