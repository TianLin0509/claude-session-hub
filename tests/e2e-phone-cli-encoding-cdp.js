'use strict';
// Actual Codex TUI and real CDP keys; no prompt submission/model response.
// Clipboard is the isolated Hub's memory clipboard throughout.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {getFreePort,click,key,waitFor}=require('./helpers/usage-refresh-fixture');
const {resolveWindowsCodex}=require('../main/codex-windows-command');
const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-phone-encoding-'));
const home=path.join(root,'codex'),cwd=path.join(root,'work'),bin=path.join(root,'bin');
for(const dir of [home,cwd,bin])fs.mkdirSync(dir);
const out=path.resolve('artifacts','20261002-phone-cli-encoding-codex1-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={out,checks:[],passed:false,boundary:'隔离真实 Codex CLI；CDP 鼠标键盘；内存剪贴板；不发送模型请求'};
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));let hub,c,sid;
async function controlKey(name,code,virtualKey) {
  for(const type of ['keyDown','keyUp'])await c.send('Input.dispatchKeyEvent',{type,key:name,code,windowsVirtualKeyCode:virtualKey,modifiers:2});
}
const check=(value,label)=>{assert(value,label);report.checks.push(label);console.log('PASS '+label);};
const shot=async name=>{const result=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(result.data,'base64'));};
const state=()=>c.eval(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal,b=t?.buffer.active;return b?{font:t.options.fontSize,rows:t.rows,cols:t.cols,text:Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n'),card:currentFontSize}:null})()`);
const paste=async text=>{
  await c.eval(`require('electron').clipboard.writeText(${j(text)});terminalCache.get(${j(sid)}).terminal.focus()`);
  await controlKey('v','KeyV',86);
};
const bad='Ìï¸ç£¬Õâ´ÎÈÔ±» Hub À¹×¡£¬ÐÂ Codex »á»°Ã»ÓÐ´´½¨£¬¹¥ÂÔÉÐÎ´¿ªÊ¼ÖÆ×÷¡£';
const good='田哥，这次仍被 Hub 拦住，新 Codex 会话没有创建，攻略尚未开始制作。';
async function clearDraft(){await c.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);await controlKey('u','KeyU',85);await sleep(250);}
async function composerPaste(text){
  await c.eval(`(()=>{const i=document.querySelector('.floating-input-box');i.textContent='前后';i.focus();const s=getSelection(),r=document.createRange();r.setStart(i.firstChild,1);r.collapse(true);s.removeAllRanges();s.addRange(r);const d=new DataTransfer();d.setData('text/plain',${j(text)});i.dispatchEvent(new ClipboardEvent('paste',{clipboardData:d,bubbles:true,cancelable:true}));})()`);
}
(async()=>{try{
  for(const field of ['NO_COLOR','FORCE_COLOR','TERM','COLORTERM','WT_SESSION','TERM_PROGRAM'])delete process.env[field];
  const source=process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(),'.codex-profiles','second');
  for(const file of ['auth.json','models_cache.json'])fs.copyFileSync(path.join(source,file),path.join(home,file));
  fs.writeFileSync(path.join(home,'config.toml'),'model="gpt-6-astra"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui.model_availability_nux]\n"gpt-6-astra"=4\n');
  fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\n"'+resolveWindowsCodex().command+'" --no-daemon %*\r\n');
  const pathKey=Object.keys(process.env).find(k=>k.toLowerCase()==='path');
  hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await getFreePort(),extraEnv:{CODEX_HOME:home,CLAUDE_CONFIG_DIR:path.join(root,'claude'),[pathKey]:bin+path.delimiter+process.env[pathKey]}});
  c=await connectFirstPage(hub);await waitFor(c,'typeof displayPresets!=="undefined" && !!displayPresets');
  await c.send('Emulation.setDeviceMetricsOverride',{width:1120,height:600,deviceScaleFactor:await c.eval('devicePixelRatio'),mobile:false});
  await c.eval(`window.__encodingTurnStarts=0;ipcRenderer.on('agent-turn-started',()=>__encodingTurnStarts++)`);
  const session=await c.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-6-astra',effort:'low',mcpProfile:'none'}})`);sid=session.id;assert(sid);
  await waitFor(c,`!!document.querySelector('.session-item[data-session-id="${sid}"]')`);await click(c,`.session-item[data-session-id="${sid}"]`);
  await waitFor(c,`terminalCache.get(${j(sid)})?._hydrated===true`);
  check(await c.eval(`currentView==='card'&&document.querySelector('#btn-backstage').getAttribute('aria-pressed')==='false'`),'真实 Codex 初次进入默认卡片');
  await click(c,'#btn-backstage');
  check(await c.eval(`currentView==='pty'&&document.querySelector('#btn-backstage').getAttribute('aria-pressed')==='true'`),'只有手动点击后台才显示真实 CLI');
  await c.eval(`window.__pasteBytes=[];terminalCache.get(${j(sid)}).terminal.onData(data=>__pasteBytes.push(data))`);
  for(let n=0;n<200;n++){if(/for shortcuts|Ask Codex to do anything/.test((await state())?.text||''))break;if(n===199)throw new Error('Codex TUI not ready');await sleep(150);}
  await click(c,'[data-display-mode="phone"]');await sleep(350);
  // Use the actual slider to obtain the old phone font geometry and then restore 14.
  await click(c,'#btn-display-settings');await click(c,'[data-display-field="terminalFontSize"]');
  await key(c,'Home','Home',36);for(let n=0;n<8;n++)await key(c,'ArrowRight','ArrowRight',39);
  await key(c,'Escape','Escape',27);await sleep(250);report.before=await state();await shot('01-cli-18');
  await click(c,'#btn-display-settings');await click(c,'[data-display-field="terminalFontSize"]');
  for(let n=0;n<4;n++)await key(c,'ArrowLeft','ArrowLeft',37);
  await key(c,'Escape','Escape',27);await sleep(400);report.after=await state();
  check(report.before.font===18&&report.after.font===14&&report.after.card===18,'CLI 14 独立于卡片 18 字号');
  check(report.after.rows>report.before.rows&&report.after.cols>report.before.cols,'同一手机横屏，CLI 可读行数与列数均增加');
  await c.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);await controlKey('+','Equal',187);await sleep(180);
  check((await state()).font===15&&(await state()).card===18,'CLI 焦点下字号快捷键只调整终端');
  await controlKey('-','Minus',189);await sleep(180);
  await c.eval(`sessions.get(${j(sid)}).title='手机端中文标题与后台编码可读性测试';renderSessionList()`);
  check(await c.eval(`(()=>{const e=document.querySelector('.session-item[data-session-id="${sid}"] .sl-title'),s=getComputedStyle(e);return s.whiteSpace==='nowrap'&&e.getBoundingClientRect().height<20&&e.getBoundingClientRect().width>120})()`),'长会话标题保持单行，时间缩写给标题让出宽度');
  check(await c.eval(`(()=>{const ids=['btn-session-details','session-model-filter','session-project-filter'],r=ids.map(id=>document.getElementById(id).getBoundingClientRect());return Math.max(...r.map(x=>x.top))-Math.min(...r.map(x=>x.top))<5&&document.querySelector('#session-model-filter option[value="all"]').textContent==='模型'&&document.querySelector('#session-project-filter option[value="all"]').textContent==='项目'&&!document.querySelector('#btn-session-details span')})()`),'详细信息、模型、项目同一行，去掉重复标签和三横图标');
  await click(c,'#session-model-filter');await key(c,'ArrowDown','ArrowDown',40);await key(c,'ArrowDown','ArrowDown',40);await key(c,'Enter','Enter',13);
  check(await c.eval("document.querySelector('#session-model-filter').value==='codex'"),'模型筛选可用');
  check(await c.eval(`(()=>{const e=document.querySelector('#session-model-filter'),s=getComputedStyle(e),x=document.createElement('canvas').getContext('2d');x.font=s.font;return x.measureText(e.selectedOptions[0].textContent).width+parseFloat(s.paddingLeft)+parseFloat(s.paddingRight)+2<=e.clientWidth})()`),'选中的 Codex 名称完整显示');
  await shot('02-phone-cli-14');
  const normal='中文输入 TEST_42 🙂';await paste(normal);await sleep(300);
  check((await state()).text.includes('中文输入 TEST_42'),'真实 Codex 终端正常 Unicode 粘贴保持中文');
  check(!await c.eval('!!document.querySelector(".paste-encoding-dialog")'),'正常粘贴无弹窗');await clearDraft();
  await paste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');
  check(await c.eval(`document.querySelector('.paste-encoding-preview').textContent===${j(good)}`),'截图同类 GBK 乱码可预览恢复');await shot('03-recovery-preview');
  await click(c,'[data-paste-choice="restore"]');await sleep(350);
  check((await state()).text.includes('田哥，这次仍被 Hub 拦住'),'恢复后中文进入真实 CLI 草稿');await clearDraft();
  await paste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');await key(c,'Escape','Escape',27);await sleep(150);
  check(!await c.eval('!!document.querySelector(".paste-encoding-dialog")')&&!(await state()).text.includes('Ìï¸ç'),'Esc 取消粘贴，不把乱码塞进终端');
  await paste('KEEP_DRAFT42');await sleep(250);
  await c.eval(`(()=>{const t=terminalCache.get(${j(sid)}).terminal,b=t.buffer.active;t.select(2,b.baseY+b.cursorY,12)})()`);
  check(await c.eval(`!!getInputLineSelection(terminalCache.get(${j(sid)}).terminal)`),'终端草稿选区可用于替换粘贴');
  await paste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');await key(c,'Escape','Escape',27);await sleep(200);
  check((await state()).text.includes('KEEP_DRAFT42'),'选中文字后取消异常粘贴，不删除已有 CLI 草稿');
  await c.eval(`terminalCache.get(${j(sid)}).terminal.clearSelection()`);await clearDraft();
  await paste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');await click(c,'[data-paste-choice="original"]');await sleep(350);
  report.rawPaste=await c.eval('window.__pasteBytes');report.rawDraft=await state();
  check(report.rawPaste.some(text=>text.includes(bad)),'保留原文以原字符送入 CLI 输入链');await clearDraft();
  await composerPaste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');await click(c,'[data-paste-choice="restore"]');await sleep(150);
  check(await c.eval(`document.querySelector('.floating-input-box').innerText===${j('前'+good+'后')}`),'卡片输入恢复中文，原插入位置和草稿保留');
  await composerPaste(bad);await waitFor(c,'!!document.querySelector(".paste-encoding-dialog[open]")');await key(c,'Escape','Escape',27);
  check(await c.eval("document.querySelector('.floating-input-box').innerText==='前后'"),'卡片输入取消保留原草稿');
  await click(c,'[data-display-mode="desktop"]');await sleep(300);check((await state()).font===16,'电脑 CLI 保留原字号');
  await click(c,'[data-display-mode="phone"]');await sleep(300);check((await state()).font===14,'手机 CLI 独立偏好保留');
  check(await c.eval('window.__encodingTurnStarts===0'),'所有粘贴只改草稿，没有发送模型请求');
  check(await c.eval("document.querySelector('#hub-system-footer').getBoundingClientRect().height===34"),'底栏仍然只占单行');
  await shot('04-phone-final');report.passed=true;
}catch(error){report.error=error.stack;process.exitCode=1;if(c)await shot('failure').catch(()=>{});}
finally{if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub);}for(const file of ['auth.json']){const target=path.join(home,file);if(fs.existsSync(target))fs.unlinkSync(target);}fs.writeFileSync(path.join(out,'evidence.json'),JSON.stringify(report,null,2));console.log('REPORT',out,report.passed?'PASS':report.error);}})();
