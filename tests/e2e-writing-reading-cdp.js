'use strict';
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms)), j = JSON.stringify;
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-writing-reading-'));
  const out = path.resolve('artifacts', '20261010-writing-reading-' + Date.now()); fs.mkdirSync(out, { recursive:true });
  let hub, c;
  const evidence = { passed:false, checks:[], kind:'isolated real Hub UI with deterministic article and dispatch fixtures' };
  const check = (label, value) => { assert(value, label); evidence.checks.push(label); console.log('PASS', label); };
  const wait = async (expr, label) => { for (let i=0;i<200;i++) { if (await c.eval(expr)) return; await sleep(100); } throw Error('Timeout '+label); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center',behavior:'instant'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed','mouseReleased']) await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});
  };
  const shot = async name => { const r = await c.send('Page.captureScreenshot',{format:'png'}); fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64')); };
  try {
    hub = await launchIsolatedHub({dataDir:path.join(root,'data'),port:await freePort(),windowMode:'hidden',extraEnv:{HUB_STARTUP_TRACE:'1',CLAUDE_CONFIG_DIR:path.join(root,'claude'),CODEX_HOME:path.join(root,'codex'),CLAUDE_HUB_WRITING_ROOT:path.join(root,'writing'),CLAUDE_HUB_WRITING_SKILLS_DIR:path.join(root,'skills')}});
    c = await connectFirstPage(hub); let ready=false;
    c.ws.on('message',msg=>{if(String(msg).includes('renderer-sidebar-ready sent'))ready=true;}); await c.send('Runtime.enable');
    for(let i=0;!ready&&i<200;i++)await sleep(100); assert(ready,'startup');
    await c.send('Emulation.setDeviceMetricsOverride',{width:1450,height:950,deviceScaleFactor:1,mobile:false}); await sleep(400);
    await wait("typeof window.__writingShow==='function'",'writing loaded');
    await c.eval(`window.__readingCalls=[];window.__readingView={dir:'fixture-writing',meetingId:'fixture-meeting',title:'多模型协作：先读文章，再讨论问题',idea:'讨论不同模型之间的互补，先给完整文章，再提出问题。',latestTurn:1,steps:{idea:true,draft:true},questions:[{sid:'writer-a',from:'Claude',key:'qa',q:'Claude：是否加入工程案例？',recommend:'加入一个案例'},{sid:'writer-b',from:'Codex',key:'qb',q:'Codex：是否展开误差分析？',recommend:'简要展开'}],columns:['Claude','Codex'].map((name,i)=>({sid:i?'writer-b':'writer-a',name,status:'done',items:[{kind:'draft',version:1,chars:400,title:name+' 的文章',text:'# '+name+' 的文章\\n\\n先明确问题，再比较不同路径。'+('\\n\\n不同模型可能拥有不同的盲区。协作的价值取决于信息是否互补，也取决于验证能否发现共同的错误。').repeat(14),note:'这是'+name+'写给你的说明，正文后再看。'}]}))};
      meetings['fixture-meeting']={id:'fixture-meeting',subSessions:['writer-a','writer-b']};
      const original=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=async(channel,...args)=>{
        if(channel==='writing:article-list')return {ok:true,articles:[{dir:'fixture-writing',meetingId:'fixture-meeting',title:__readingView.title,createdAt:Date.now(),drafts:[{},{}]}]};
        if(channel==='writing:article-view')return {ok:true,view:JSON.parse(JSON.stringify(__readingView))};
        if(channel==='groupchat:turn'){__readingCalls.push(args[0]);return {status:'completed',results:[]};}
        if(channel==='meeting-append-user-turn')return {ok:true};
        return original(channel,...args);
      };`);
    await click('#btn-writing'); await wait("!!document.querySelector('.wb-panel .wr-paper')",'article');
    const metrics = await c.eval(`(()=>{const r=s=>document.querySelector(s).getBoundingClientRect();return{header:r('.wr-head').height,paperTop:r('.wb-panel .wr-paper').top,paperWidth:r('.wb-panel .wr-paper').width};})()`);
    evidence.metrics = metrics;
    check('compact single row header',metrics.header<=50);
    check('article begins near top of workspace',metrics.paperTop<260);
    check('article uses available width',metrics.paperWidth>950);
    const ownQuestions = () => c.eval(`(()=>{const p=document.querySelector('.wb-panel .wr-paper'),q=document.querySelector('.wb-member-questions');return !!(p.compareDocumentPosition(q)&Node.DOCUMENT_POSITION_FOLLOWING)&&q.dataset.member===document.querySelector('.wb-panel').dataset.col;})()`);
    check('article before its own questions',await ownQuestions());
    check('no global questions before drafts',await c.eval("document.querySelector('[data-wb=questions]').hidden"));
    check('author note follows article',await c.eval("!!(document.querySelector('.wb-panel .wr-paper').compareDocumentPosition(document.querySelector('.wb-aside'))&Node.DOCUMENT_POSITION_FOLLOWING)"));
    await shot('desktop-article-first');
    await click('.wb-tab:nth-child(2)');
    check('second author only sees own questions',await c.eval("document.querySelector('.wb-member-questions').innerText.includes('Codex：')&&!document.querySelector('.wb-member-questions').innerText.includes('Claude：')"));
    await click('.wb-q-input'); await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65}); await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65}); await c.send('Input.insertText',{text:'保留我的回答'});
    await sleep(3300);
    check('polling preserves question answer',await c.eval("document.querySelector('.wb-q-input').value==='保留我的回答'"));
    await click('.wb-member-questions button'); await wait('__readingCalls.length===1','answer dispatch');
    check('answer dispatch contains only displayed author questions',await c.eval("__readingCalls[0].userInput.includes('保留我的回答')&&!__readingCalls[0].userInput.includes('是否加入工程案例')"));
    await click('.wb-tabbar > button:last-child');
    check('comparison places questions below each corresponding article',await c.eval("document.querySelectorAll('.wb-col').length===2&&[...document.querySelectorAll('.wb-col')].every(col=>{const q=col.querySelector('.wb-member-questions');return q.dataset.member===col.dataset.col&&!!(col.querySelector('.wr-paper').compareDocumentPosition(q)&Node.DOCUMENT_POSITION_FOLLOWING);})"));
    await c.eval("document.querySelector('.wr-studio-main').scrollTop=0"); await shot('desktop-compare');
    await c.send('Emulation.setDeviceMetricsOverride',{width:960,height:800,deviceScaleFactor:1,mobile:false}); await sleep(500);
    check('narrow layout returns to article tabs',await c.eval("document.querySelectorAll('.wb-panel').length===1&&document.querySelectorAll('.wb-col').length===0"));
    check('narrow header stays compact',await c.eval("document.querySelector('.wr-head').getBoundingClientRect().height<=50"));
    check('writing tools remain available',await c.eval("!!document.querySelector('.wb-basket .voice-mic')&&!!document.querySelector('.wb-basket .composer-collapse')&&document.querySelectorAll('.writing-recipient').length===2"));
    await c.eval("document.querySelector('.wr-studio-main').scrollTop=0"); await shot('narrow-article-first'); evidence.passed=true;
  } catch(e) { evidence.error=e.stack;if(c)await shot('failure').catch(()=>{});throw e; }
  finally { if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}fs.writeFileSync(path.join(out,'checks.json'),JSON.stringify(evidence,null,2));console.log('ARTIFACT_ROOT',out); }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
