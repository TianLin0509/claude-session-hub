'use strict';
// Real renderer + IPC + isolated files. No provider/model response is mocked,
// and no cloud model or external login is invoked in this layout regression.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { PieceStore } = require('../core/writing/piece-store');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function port() { const s=net.createServer(); await new Promise(r=>s.listen(0,'127.0.0.1',r)); const p=s.address().port; await new Promise(r=>s.close(r)); return p; }
(async () => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-porcelain-'));
  const home=path.join(root,'home'), data=path.join(root,'data'), writing=path.join(root,'writing');
  const voice=path.join(home,'.codex','skills','tiange-voice');
  const out=path.resolve('artifacts/porcelain-ui');
  for (const dir of [home,data,voice,out]) fs.mkdirSync(dir,{recursive:true});
  const voiceText='# 文风\n\n## 写法\n\n先说清楚问题，再给出判断。\n条件放在结论附近。\n';
  for (const name of ['SKILL.md','exemplars.md','learned-from-edits.md']) fs.writeFileSync(path.join(voice,name),voiceText,'utf8');
  fs.writeFileSync(path.join(voice,'CHANGELOG.md'),'# 变更记录\n\n2026-10-01 手动确认\n','utf8');
  const pieces=new PieceStore({piecesRoot:path.join(writing,'写作台')});
  const first=pieces.create();
  fs.writeFileSync(path.join(first,'final.md'),'# 从仿真到判断\n\n这是隔离测试文章。先明确条件，再比较结果。\n\n## 证据与边界\n\n定稿正文与公式都要保留：$x^2+y^2=1$。\n');
  pieces.mutate(first,m=>{m.voice={status:'done',changed:false,finalMtime:fs.statSync(path.join(first,'final.md')).mtimeMs};});
  const second=pieces.create();fs.writeFileSync(path.join(second,'drafts','Codex.md'),'# 让 AI 学会我的写法\n\n先说清楚中心思想。');
  fs.writeFileSync(path.join(home,'.codex','AGENTS.md'),'# 隔离规则\n保留当前的全部操作。');
  const memoFile=path.resolve('memo.json');
  // Production uses its existing repo-local memo.json. This test refuses to
  // overwrite even a worktree memo and only removes the exact file it creates.
  assert.equal(fs.existsSync(memoFile),false,'run in a dedicated worktree without memo.json');
  fs.writeFileSync(memoFile,JSON.stringify([{id:'fixture',ts:Date.now(),text:'记下当下，找回聊过的事。'}]));
  const result={root,out,checks:[],cloudCalls:false,errors:[]}; let hub,cdp;
  const until=async(expr,label)=>{const end=Date.now()+35000;while(Date.now()<end){if(await cdp.eval(`Boolean(${expr})`))return;await sleep(100);}throw Error('timeout: '+label);};
  const click=async selector=>{await until(`document.querySelector(${JSON.stringify(selector)})`,'exists '+selector);await cdp.eval(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest'})`);const p=await cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();if(!r.width||!r.height)throw Error('hidden '+${JSON.stringify(selector)});return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});await cdp.send('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});await cdp.send('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});await sleep(150);};
  const textButton=async(scope,label)=>{const id='porcelain-test-action';await until(`[...document.querySelectorAll(${JSON.stringify(scope+' button')})].some(b=>b.textContent.trim()===${JSON.stringify(label)})`,label);await cdp.eval(`(()=>{document.getElementById('${id}')?.removeAttribute('id');[...document.querySelectorAll(${JSON.stringify(scope+' button')})].find(b=>b.textContent.trim()===${JSON.stringify(label)}).id='${id}';})()`);await click('#'+id);};
  const check=async(expr,label)=>{assert.equal(await cdp.eval(expr),true,label);result.checks.push(label);};
  const shot=async name=>{const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  try {
    hub=await launchIsolatedHub({dataDir:data,port:await port(),label:'porcelain-workspaces',extraEnv:{CLAUDE_HUB_HOME_DIR:home,CLAUDE_HUB_WRITING_ROOT:writing,CLAUDE_HUB_WRITING_EVOLVE_SETTLE_MS:'3600000'}});
    cdp=await connectFirstPage(hub,t=>t.type==='page'&&t.url.includes('index.html'));
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
    await until('window.hubWorkspaces && typeof window.__writingShow==="function"','controllers ready');
    await cdp.eval('window.__porcelainErrors=[];window.addEventListener("error",e=>window.__porcelainErrors.push(e.message));window.addEventListener("unhandledrejection",e=>window.__porcelainErrors.push(String(e.reason)));');
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:250});await sleep(400);
    await click('#btn-writing');await until('document.querySelectorAll(".wr-article").length===2','two articles');
    await check('getComputedStyle(document.querySelector("#session-sidebar")).visibility==="hidden"','writing hides session sidebar');
    await check('document.getElementById("writing-panel").getBoundingClientRect().left===document.getElementById("scene-rail").getBoundingClientRect().right','writing uses full content width');
    // 2026-10-01 写作台改为「左文章列表 + 右文章工作台」：点文章，定稿在工作台顶部阅读
    await cdp.eval(`(()=>{document.getElementById('porcelain-test-article')?.removeAttribute('id');[...document.querySelectorAll('#wr-view-studio .wr-article')].find(a=>a.textContent.includes('从仿真到判断')).id='porcelain-test-article';})()`);
    await click('#porcelain-test-article');await until('document.querySelector(".wb-final:not([hidden]) .wr-paper")?.textContent.includes("先明确条件")','real final text');await shot('01-writing');
    await click('[data-view="library"]');await until('document.querySelectorAll(".wr-item").length===1','final enters library');await click('.wr-item');await until('document.querySelector(".wr-reader .wr-paper")','reader');
    await check('document.querySelectorAll(".wr-filters input[type=checkbox]").length>=5','all library filters retained');await shot('02-library');
    await click('[data-view="voice"]');await until('document.querySelector(".wr-lines")','voice source');await textButton('#wr-view-voice','编辑');await until('document.querySelector(".wr-voice-editor")','voice editor');await click('.wr-voice-editor');await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'End',code:'End',modifiers:2,windowsVirtualKeyCode:35});await cdp.send('Input.insertText',{text:'\n界面回归：保留原有行为。\n'});await textButton('#wr-view-voice','保存（Ctrl+S）');await until('!document.querySelector(".wr-voice-editor")','save done');assert(fs.readFileSync(path.join(voice,'SKILL.md'),'utf8').includes('界面回归'));result.checks.push('voice saves real isolated file');await shot('03-voice');
    const hasAssistant=await cdp.eval('!!document.getElementById("btn-assistant")');
    if(hasAssistant){await click('#btn-assistant');await until('document.body.classList.contains("assistant-open")','assistant open');}
    await click('#btn-rail-capabilities');await until('document.querySelector("#hub-workspace[data-area=resources]") && document.querySelector("#capability-page.hw-embedded")','resources');await shot('04-tools');
    if(hasAssistant){
      await check('!document.body.classList.contains("assistant-open")','assistant closes on resource navigation');
      await click('#btn-assistant');await check('document.getElementById("hub-workspace").hidden','resources close on assistant navigation');
      await click('#btn-rail-memo');await check('!document.body.classList.contains("assistant-open")','assistant closes on review navigation');
      await click('#btn-rail-capabilities');
    }
    await click('[data-cp-tab="coverage"]');await until('document.querySelector(".cp-matrix")','coverage matrix');await check('document.querySelectorAll(".cp-matrix th").length>=5','AI coverage columns retained');
    await click('[data-hw-tab="memory"]');await until('document.querySelector("#memory-page.hw-embedded .mp-content")','memory');await check('document.querySelector("[data-tab=library]").getAttribute("aria-selected")==="true"','memory defaults to library');await shot('05-memory');
    await click('#memory-page [data-tab="dream"]');await until('document.querySelector("#memory-page [data-tab=dream]").getAttribute("aria-selected")==="true"','dream');result.checks.push('dream remains reachable');
    await click('[data-hw-tab="context"]');await until('document.querySelector("#memory-page [data-tab=context]").getAttribute("aria-selected")==="true"','context');await check('document.querySelector(".mp-content").textContent.includes("请先打开")','no session remains explicit');await click('[data-hw-context="capabilities"]');await until('document.querySelector(".cp-session")','runtime tools');result.checks.push('runtime tool reports remain reachable');
    await click('#btn-rail-memo');await until('document.querySelector("#memo-panel.hw-embedded")','memo');await check('document.querySelector("#memo-list").textContent.includes("记下当下")','existing memo is preserved');await click('#memo-input');await cdp.send('Input.insertText',{text:'新增备忘：功能不能变。'});await click('#memo-add-btn');await check('document.querySelectorAll(".memo-item").length===2','memo add');assert.equal(JSON.parse(fs.readFileSync(memoFile)).length,2);await check('document.getElementById("memo-panel").getBoundingClientRect().width>1000','memo fills workspace');await shot('06-memo');await click('.memo-copy-btn');await check('document.querySelector(".memo-copy-btn").textContent==="✓"','copy through existing clipboard adapter');await click('.memo-del-btn');await check('document.querySelectorAll(".memo-item").length===1','single memo delete');
    await click('[data-hw-tab="history"]');await until('document.querySelector("#search-modal.hw-embedded").style.display==="flex"','history embedded');await check('document.querySelector("#search-query")!==null && document.querySelector("#session-search-index-status")!==null','history search and index controls');await click('#session-search-filter-toggle');await check('document.querySelector("#session-search-advanced").hidden===false','advanced history filters');await shot('07-history');
    await click('[data-hw-close]');await check('document.querySelector("#hub-workspace").hidden && document.querySelector("#search-modal").parentElement.id!=="hub-workspace"','close releases embedded page');
    await click('#btn-rail-accounts');await until('!document.getElementById("account-page").hidden','accounts');await check('document.querySelectorAll(".ac-tabs [role=tab]").length===6','all six account categories');await shot('08-accounts');
    await click('#btn-rail-capabilities');await until('!document.getElementById("hub-workspace").hidden','accounts to resources');await check('document.getElementById("account-page").hidden&&!document.body.classList.contains("accounts-open")','account page closes on resource navigation');
    await click('#btn-home');await until('document.getElementById("hub-workspace").hidden','return home');await check('!document.body.classList.contains("writing-open")','writing flag cleared on home');
    await click('#btn-quick-memo');await check('document.getElementById("memo-panel").style.display==="flex"&&!document.getElementById("memo-panel").classList.contains("hw-embedded")','quick memo uses original drawer');await click('#memo-clear-btn');
    await cdp.send('Input.dispatchKeyEvent',{type:'keyDown',key:'F',code:'KeyF',modifiers:10,windowsVirtualKeyCode:70});await until('document.querySelector("#hub-workspace[data-area=review][data-section=history]")&&!document.getElementById("hub-workspace").hidden','history keyboard shortcut');result.checks.push('Ctrl+Shift+F enters history');
    for(const width of [1280,1024]){await cdp.send('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await click('#btn-writing');await check('document.getElementById("writing-panel").scrollWidth<=document.getElementById("writing-panel").clientWidth+1',`writing fits ${width}`);await click('#btn-rail-memo');await check('document.getElementById("hub-workspace").scrollWidth<=document.getElementById("hub-workspace").clientWidth+1',`review fits ${width}`);}
    result.errors=await cdp.eval('window.__porcelainErrors');assert.deepEqual(result.errors,[]);result.passed=true;
  } finally {
    if(cdp)await cdp.close();if(hub)result.shutdown=await gracefulQuit(hub);
    fs.unlinkSync(memoFile);
    fs.writeFileSync(path.join(out,'ui-regression.json'),JSON.stringify(result,null,2));
    console.log(JSON.stringify({passed:result.passed,checks:result.checks,errors:result.errors,out}));
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
