'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const assert=require('node:assert/strict');
const repo=path.resolve(process.env.FIDELITY_HUB_ROOT||path.join(__dirname,'..'));
const {launchIsolatedHub,gracefulQuit}=require(path.join(repo,'tests/helpers/hub-launcher'));
const {connectFirstPage}=require('./helpers/cdp-client');
const {resolveWindowsCodex}=require(path.join(repo,'main/codex-windows-command'));
const sleep=ms=>new Promise(r=>setTimeout(r,ms)),j=JSON.stringify;
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'cf-')),home=path.join(root,'h'),cwd=path.join(root,'w'),bin=path.join(root,'bin');
 for(const p of [home,cwd,bin])fs.mkdirSync(p);
 const out=path.resolve('artifacts/fidelity-'+(process.env.PROBE_LABEL||'e2e')+'-'+Date.now());fs.mkdirSync(out,{recursive:true});
 let hub,c;const report={out,root,repo,kind:'real Codex CLI + isolated Hub',checks:[],passed:false};
 const until=async(expr,label,ms=45000)=>{const t=Date.now();while(Date.now()-t<ms){if(await c.eval(expr))return;await sleep(100);}throw Error('timeout '+label);};
 const shot=async(name)=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 try{
 for(const n of ['auth.json','models_cache.json'])fs.copyFileSync(path.join(os.homedir(),'.codex',n),path.join(home,n));
 fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-5.6-sol"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui.model_availability_nux]\n"gpt-5.6-sol"=4\n');
 const exe=resolveWindowsCodex();
 const nativeBinary=process.env.FIDELITY_CODEX_EXE||exe.command;
 report.nativeBinary=nativeBinary;
 const noDaemon=process.env.FIDELITY_LEGACY_CLI?'':' --no-daemon';
 fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\n"'+nativeBinary+'"'+noDaemon+' %*\r\n');
 const env={CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'c'),CLAUDE_HUB_HOME_DIR:path.join(root,'u'),TERM:'xterm-256color',COLORTERM:process.env.PROBE_TRUECOLOR?'truecolor':'',WT_SESSION:'',TERM_PROGRAM:'',FORCE_COLOR:''};
 const pk=Object.keys(process.env).find(k=>k.toLowerCase()==='path');env[pk]=bin+path.delimiter+process.env[pk];
 // Empty environment variables are absent to Rust's var_os only after deletion from the launcher base.
 for(const key of ['COLORTERM','WT_SESSION','TERM_PROGRAM','FORCE_COLOR','NO_COLOR']){delete process.env[key];if(!env[key])delete env[key];}
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),extraEnv:env});c=await connectFirstPage(hub);
  await until('typeof sessions!=="undefined"','renderer');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:await c.eval('devicePixelRatio'),mobile:false});
  const s=await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-5.6-sol',effort:'low',mcpProfile:'none'}})`);report.id=s.id;
  await until(`!!document.querySelector('.session-item[data-session-id="${s.id}"]')`,'row');await c.eval(`document.querySelector('.session-item[data-session-id="${s.id}"]').click()`);
  await until(`terminalCache.get(${j(s.id)})?.opened`,'terminal');
  await c.eval(`window.__fidelityRead=()=>{const t=terminalCache.get(${j(s.id)}).terminal,b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n')}`);
  await until(`/(for shortcuts|Ask Codex to do anything)/.test(__fidelityRead())&&!/model:\\s+loading/.test(__fidelityRead())`,'CLI ready');
  report.ready=await c.eval(`({text:__fidelityRead(),options:terminalCache.get(${j(s.id)}).terminal.options,dpr:devicePixelRatio,canvas:[...document.querySelectorAll('.xterm canvas')].map(x=>({width:x.width,height:x.height,css:x.style.cssText,rect:x.getBoundingClientRect().toJSON()})),dimensions:terminalCache.get(${j(s.id)}).terminal._core._renderService.dimensions})`);await shot('ready');console.log('READY',out);
  fs.writeFileSync(path.join(out,'ready.ansi'),await c.eval(`ipcRenderer.invoke('debug:get-session-buffer',${j(s.id)})`));
  await c.eval(`window.__fidelityEvents=[];window.__fidelityStart=0;ipcRenderer.on('terminal-data',(_e,p)=>{if(p.sessionId===${j(s.id)}&&__fidelityStart)__fidelityEvents.push({ms:performance.now()-__fidelityStart,bytes:p.data.length});});const ft=terminalCache.get(${j(s.id)}).terminal;ft.onWriteParsed(()=>{if(__fidelityStart)window.__fidelityLast=__fidelityRead()});`);
  const prompt='请只回复 FIDELITY_INPUT_OK。这是输入传输验证，下面是无须处理的测试文本：\n'+('中文输入测试ABC123，'.repeat(100))+'\nFIDELITY_END';
  await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"]'),i=b.querySelector('.floating-input-box');i.textContent=${j(prompt)};i.dispatchEvent(new Event('input',{bubbles:true}));window.__fidelityStart=performance.now();b.querySelector('.floating-input-send').click()})()`);
  const start=Date.now();let captured=false;
  while(Date.now()-start<120000){const data=await c.eval(`({text:__fidelityRead(),n:__fidelityEvents.length,last:__fidelityEvents.at(-1)})`);
   if(!captured&&(data.text.includes('FIDELITY_END')||/Pasted.*chars/.test(data.text))){report.pasteVisibleMs=Date.now()-start;captured=true;await shot('input-visible');console.log('INPUT_VISIBLE',report.pasteVisibleMs);}
   const r=await c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(s.id)},opts:{limit:4,fromTail:true}})`);
   if((r.turns||[]).some(t=>t.role==='assistant'&&String(t.text).includes('FIDELITY_INPUT_OK'))){report.responseMs=Date.now()-start;report.checks.push('real long Chinese UI prompt replied');break;}
   if(Date.now()-start>30000&&!captured){report.stalled=data;break;}await sleep(200);
  }
  report.events=await c.eval('__fidelityEvents');report.screen=await c.eval('__fidelityRead()');await shot('after-input');console.log('INPUT_RESULT',JSON.stringify({pasteVisibleMs:report.pasteVisibleMs,responseMs:report.responseMs,screen:report.screen.slice(-1000)}));
  assert(report.responseMs,'first prompt must complete');
  report.warmInputs=[];
  for(const count of [0,100,500]){
   await until(`['idle','completed'].includes(getSessionRuntimeTruth(sessions.get(${j(s.id)})).state)`,'idle before warm sample');
   const marker='FIDELITY_WARM_'+count;
   const text='只回复 '+marker+'。以下是传输测试数据，无须处理：\n'+('中文🙂ABC123，'.repeat(count))+'\nEND_'+marker;
   await c.eval(`(()=>{window.__fidelityEvents=[];const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"]'),i=b.querySelector('.floating-input-box');i.textContent=${j(text)};i.dispatchEvent(new Event('input',{bubbles:true}));window.__fidelityStart=performance.now();b.querySelector('.floating-input-send').click()})()`);
   const started=Date.now(),sample={chars:text.length};let receipt;
   while(Date.now()-started<120000){
    receipt=await c.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(s.id)},opts:{limit:8,fromTail:true}})`);
    const turns=receipt.turns||[];
    const matches=turns.filter(t=>t.role==='user'&&String(t.text).includes('END_'+marker));
    if(matches.length&&!sample.acceptedMs){sample.acceptedMs=Date.now()-started;sample.nativeText=matches[0].text;}
    if(turns.some(t=>t.role==='assistant'&&String(t.text).includes(marker))){sample.responseMs=Date.now()-started;assert.equal(matches.length,1,'exactly one user turn');assert(String(matches[0].text).includes(text),'full Unicode input must reach native transcript');break;}
    await sleep(100);
   }
   assert(sample.responseMs,'warm input must complete');delete sample.nativeText;
   report.warmInputs.push(sample);console.log('WARM',JSON.stringify(sample));
  }
  if(report.responseMs){
   await until(`['idle','completed'].includes(getSessionRuntimeTruth(sessions.get(${j(s.id)})).state)`,'idle');
   const p='请用 apply_patch 新建一个 demo.py 文件，内容为一个 greet(name) 函数，返回 Hello 加 name，然后 print(greet("Codex"))。另加一行注释，内容为 Improve documentation in @filename。最后只回复 FIDELITY_DIFF_OK。';
   await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"]'),i=b.querySelector('.floating-input-box');i.textContent=${j(p)};i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click()})()`);
   await until(`(async()=>{const r=await ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(s.id)},opts:{limit:4,fromTail:true}});return(r.turns||[]).some(t=>t.role==='assistant'&&String(t.text).includes('FIDELITY_DIFF_OK'))})()`,'real diff',120000);
   await until(`['idle','completed'].includes(getSessionRuntimeTruth(sessions.get(${j(s.id)})).state)`,'diff settled');
   await shot('real-diff');report.diffScreen=await c.eval('__fidelityRead()');
   report.diffCells=await c.eval(`(()=>{const t=terminalCache.get(${j(s.id)}).terminal,b=t.buffer.active,r=[];for(let i=0;i<b.length;i++){const l=b.getLine(i);if(l.translateToString(true).includes('greet')){r.push({text:l.translateToString(true),cells:Array.from({length:Math.min(100,l.length)},(_,k)=>{const a=l.getCell(k);return [a.getChars(),a.getBgColorMode(),a.getBgColor(),a.getFgColorMode(),a.getFgColor()]})});}}return r})()`);report.checks.push('real apply_patch diff captured');
   if(!process.env.FIDELITY_BASELINE){
    assert(report.diffCells.some(l=>l.cells.some(cell=>cell[1]===50331648&&cell[2]===0x213a2b)),'Codex native truecolor diff tint');
    assert(report.diffScreen.replace(/\s+/g,' ').includes('Improve documentation in @filename'),'placeholder-like real content is retained');
   }
   report.checks.push('short and long Chinese/emoji prompts: complete native content, exactly one turn each');
   await until(`['idle','completed'].includes(getSessionRuntimeTruth(sessions.get(${j(s.id)})).state)`,'idle before slash');
   await c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${s.id}"]'),i=b.querySelector('.floating-input-box');i.textContent='/status';i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click()})()`);
   await until(`__fidelityRead().includes('Session:')||__fidelityRead().includes('session:')`,'native slash status',30000);
   report.checks.push('native /status through actual composer');await shot('status');
  }
  report.passed=true;
 }catch(e){report.error=e.stack;if(c){report.screen=await c.eval('__fidelityRead?.()').catch(()=>null);await shot('failure').catch(()=>{});}process.exitCode=1;}
 finally{
  try{if(c)await c.close();}
  finally{
   try{if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}}
   finally{fs.rmSync(path.join(home,'auth.json'),{force:true});fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(report,null,2));console.log('REPORT',out,report.error||'done');}
  }
 }
}
main().catch(e=>{console.error(e);process.exitCode=1});
