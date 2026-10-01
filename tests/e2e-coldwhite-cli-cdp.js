'use strict';
const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),net=require('net');
const {launchIsolatedHub,gracefulQuit,_waitMs}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const ROOT=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(os.tmpdir(),'hub-coldwhite-cli-'));
const workspace=path.join(temp,'workspace');fs.mkdirSync(workspace);
const out=path.join(ROOT,'artifacts/coldwhite-cli');fs.mkdirSync(out,{recursive:true});
const port=()=>new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
const j=JSON.stringify;
(async()=>{
 let hub,c;const result={passed:false,checks:[]};
 const check=(v,label)=>{assert(v,label);result.checks.push(label);};
 const until=async(expression,timeout=30000)=>{const end=Date.now()+timeout;while(Date.now()<end){if(await c.eval(expression))return;await _waitMs(120);}throw Error('timeout: '+expression);};
 const click=async(selector)=>{
  const p=await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...p,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...p,button:'left',clickCount:1});await _waitMs(150);
 };
 const shot=async name=>{const s=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
 const buffer=()=>c.eval(`(()=>{const b=terminalCache.get(activeSessionId).terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n')})()`);
 try {
  hub=await launchIsolatedHub({dataDir:path.join(temp,'data'),port:await port(),label:'coldwhite-cli',extraEnv:{CLAUDE_HUB_E2E:'1',AI_HUB_WORKSPACE_ROOT:temp,CODEX_HOME:path.join(temp,'codex'),CLAUDE_CONFIG_DIR:path.join(temp,'claude'),CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.join(ROOT,'tests/fixtures/codex-app-server.js')}});
  c=await connectFirstPage(hub);await until('typeof themeController!=="undefined"');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:960,deviceScaleFactor:0,mobile:false});
  const session=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'codex',opts:{cwd:workspace,model:'gpt-6-sol',effort:'low',mcpProfile:'none'}})})`);
  await until('!!document.querySelector(".floating-input-box")');
  await click('.floating-input-box');await c.send('Input.insertText',{text:'fixture:terminal-design'});await click('.floating-input-send');
  await until(`(()=>{const t=terminalCache.get(${j(session.id)})?.terminal;if(!t)return false;const b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('').includes('✓ 已完成')})()`);
  await click('#btn-backstage');await until('!!document.querySelector(".cb-tabs")');
  for(const [i,name] of ['readable','raw','legacy'].entries()){
   await click(`.cb-tabs button:nth-child(${i+1})`);
   check(await c.eval(`getComputedStyle(document.querySelector('.codex-backstage')).backgroundColor==='rgb(251, 252, 253)'`),'浅色后台 '+name);
   await shot('codex-'+name);
   if(name==='readable')check(await c.eval(`getComputedStyle(document.querySelector('.cb-markdown pre code')).color==='rgb(48, 59, 75)'`),'浅色代码正文可读');
  }
  const before=await buffer();
  check(before.includes('const theme')&&before.includes('✓ 已完成'),'原终端保留完整输出与代码');
  check(await c.eval('terminalCache.get(activeSessionId).terminal.options.minimumContrastRatio===4.5'),'浅色启用 RGB 对比保护');
  await c.eval('themeController.setTheme("dark")');await _waitMs(160);
  check(await c.eval('terminalCache.get(activeSessionId).terminal.options.theme.background==="#081420" && terminalCache.get(activeSessionId).terminal.options.minimumContrastRatio===1'),'切回深色恢复原有终端');
  check(await buffer()===before,'换主题不改终端文本');
  await c.eval('themeController.setTheme("codex")');
  await c.eval('terminalCache.get(activeSessionId).terminal.selectAll()');
  check(await c.eval('terminalCache.get(activeSessionId).terminal.getSelection().includes("const theme")'),'文本仍可选择');
  await c.eval('terminalCache.get(activeSessionId).terminal.clearSelection()');
  const shell=await c.eval(`ipcRenderer.invoke('create-session',${j({kind:'powershell',opts:{cwd:workspace}})})`);
  await until(`activeSessionId===${j(shell.id)} && !!terminalCache.get(activeSessionId)?._hydrated`);
  if(await c.eval('currentView')!=='pty')await click('#btn-backstage');
  const command="$e=[char]27; @( @('RED',31), @('GREEN',32), @('YELLOW',33), @('BLUE',34), @('MAGENTA',35), @('CYAN',36), @('DIM',90), @('WHITE',97)) | ForEach-Object { [Console]::WriteLine(('{0}[{1}mCW_COLOR_{2} readable text{0}[0m' -f $e, $_[1], $_[0])) }; [Console]::WriteLine(('{0}[38;2;240;246;252mCW_RGB_WHITE readable text{0}[0m' -f $e)); [Console]::WriteLine('CW_'+'DONE')\r";
  await c.eval(`ipcRenderer.send('terminal-input',${j({sessionId:shell.id,data:command})})`);
  await until(`(()=>{const b=terminalCache.get(activeSessionId).terminal.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').some(x=>x.trim()==='CW_DONE')})()`);
  const text=await buffer();for(const name of ['RED','GREEN','YELLOW','BLUE','MAGENTA','CYAN','DIM','WHITE'])check(text.includes('CW_COLOR_'+name),'真实 PowerShell ANSI '+name);
  check(text.includes('CW_RGB_WHITE'),'真实 PowerShell RGB 亮白样本');
  await shot('powershell-colors');
  result.shell=await c.eval('(()=>{const t=terminalCache.get(activeSessionId).terminal;return {theme:t.options.theme,contrast:t.options.minimumContrastRatio,cols:t.cols,rows:t.rows,canvasCount:t.element.querySelectorAll("canvas").length}})()');
  await c.send('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:0,mobile:false});await _waitMs(250);
  check(await c.eval('terminalCache.get(activeSessionId).terminal.cols>20 && document.documentElement.scrollWidth<=innerWidth'),'窄窗口终端保持可用');
  await shot('powershell-narrow');result.passed=true;
 } catch(e){result.error=e.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
 finally {if(c)await c.close();if(hub)result.shutdown=await gracefulQuit(hub);fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
})();
