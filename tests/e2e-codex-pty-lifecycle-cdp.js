'use strict';
// Real CLI / provider test. Prompt entry and reopening use the renderer UI;
// close-session is an explicit lifecycle setup step, not claimed as a click.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { resolveWindowsCodex } = require('../main/codex-windows-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const home = path.join(root, 'h'), cwd = path.join(root, 'w'), bin = path.join(root, 'b');
  for (const dir of [home, cwd, bin]) fs.mkdirSync(dir);
  const out = path.resolve('artifacts', 'codex-lifecycle-' + (process.env.AUDIT_LABEL || 'candidate') + '-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { root, out, checks: [], passed: false, samples: [] };
  if (process.platform === 'win32') {
    const probe = `Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public class MotionProbe{[DllImport("user32.dll")] public static extern bool SystemParametersInfo(uint a,uint b,out int c,uint d);}';$v=0;if(![MotionProbe]::SystemParametersInfo(0x1042,0,[ref]$v,0)){throw 'motion probe failed'};Write-Output $v`;
    report.systemAnimations = execFileSync('powershell.exe', ['-NoProfile', '-Command', probe], { windowsHide: true, encoding: 'utf8' }).trim() === '1';
  }
  let hub, client, sid;
  const check = (name, ok, evidence) => { report.checks.push({ name, ok: !!ok, evidence }); console.log(name, ok ? 'PASS' : 'FAIL', evidence || ''); };
  const until = async (fn, label, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(150); }
    throw new Error('timeout: ' + label);
  };
  const capture = async name => {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const state = async () => client.eval(`(() => {
    const s=sessions.get(${j(sid)}),c=terminalCache.get(${j(sid)}),t=c?.terminal,b=t?.buffer.active;
    if(!b)return null;
    const lines=Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'');
    const working=[];
    for(let i=b.baseY;i<b.length;i++)if(/^\\s*(?:[^\\w\\s]\\s*)?(?:Working|Thinking|Waiting)\\b/.test(lines[i])){
      const l=b.getLine(i);working.push({text:lines[i],cells:Array.from({length:l.length},(_,x)=>{const a=l.getCell(x);return[a.getChars(),a.getFgColor(),a.getBgColor(),a.isBold(),a.isDim()]})});
    }
    return {model:s.currentModel,truth:getSessionRuntimeTruth(s),status:s.status,sid:s.codexSid,path:s.transcriptPath,
      hydrated:c._hydrated,text:lines.join('\\n'),working,rows:t.rows,cols:t.cols,baseY:b.baseY,viewportY:b.viewportY,buffer:b.type,modes:t.modes,
      style:{fontSize:t.options.fontSize,fontFamily:t.options.fontFamily,lineHeight:t.options.lineHeight,theme:t.options.theme},
      sidebar:document.querySelector('.session-item[data-session-id="'+s.id+'"]')?.dataset.runtimeState,
      composer:document.querySelector('.floating-input-bar[data-session-id="'+s.id+'"]')?.innerText};
  })()`);
  const send = async text => client.eval(`(() => {
    const bar=document.querySelector('.floating-input-bar[data-session-id="${sid}"]'),i=bar.querySelector('.floating-input-box');
    i.textContent=${j(text)};i.dispatchEvent(new Event('input',{bubbles:true}));bar.querySelector('.floating-input-send').click();
  })()`);
  const response = async marker => {
    const result = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)},opts:{limit:8,fromTail:true}})`);
    return (result.turns || []).some(t => t.role === 'assistant' && String(t.text).includes(marker));
  };
  const escape = async () => {
    await client.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);
    await client.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    await client.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  };
  const history = async () => {
    const seen = new Set();
    const screens = [];
    for (let step=0;step<64;step++) {
      const s=await state();screens.push(s.text);
      for(const match of s.text.matchAll(/PARITY_HISTORY_(\d{3})/g))seen.add(match[1]);
      if(seen.size===70)break;
      const pos=await client.eval(`(()=>{const r=terminalCache.get(${j(sid)}).container.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);
      await client.send('Input.dispatchMouseEvent',{type:'mouseWheel',...pos,deltaX:0,deltaY:-420});
      await sleep(250);
    }
    return {count:seen.size,first:seen.has('001'),last:seen.has('070'),screens};
  };
  const overlayScroll = async () => {
    await escape();await sleep(250);
    const before=(await state()).text;
    const pos=await client.eval(`(()=>{const r=document.querySelector('.floating-input-bar[data-session-id="${sid}"]').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+12}})()`);
    for(let i=0;i<6;i++){
      await client.send('Input.dispatchMouseEvent',{type:'mouseWheel',...pos,deltaX:0,deltaY:-420});await sleep(200);
    }
    const after=(await state()).text;
    return {before,after,moved:before!==after && /PARITY_HISTORY_/.test(after)};
  };
  try {
    // Match a desktop Hub launch, not the coding agent's non-interactive console.
    for(const key of ['NO_COLOR','FORCE_COLOR','TERM','COLORTERM','WT_SESSION','TERM_PROGRAM'])delete process.env[key];
    const authHome = process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(), '.codex');
    for (const file of ['auth.json', 'models_cache.json']) fs.copyFileSync(path.join(authHome, file), path.join(home, file));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6-astra"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui]\nstatus_line=["model-with-reasoning","context-remaining","current-dir"]\n[tui.model_availability_nux]\n"gpt-6-astra"=4\n');
    const binary = process.env.PARITY_CODEX_EXE || resolveWindowsCodex().command;
    report.binary = binary;
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n"' + binary + '"' + (process.env.PARITY_LEGACY ? '' : ' --no-daemon') + ' %*\r\n');
    const key = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'd'), port: await port(), extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'c'), [key]: bin + path.delimiter + process.env[key],
    } });
    client = await connectFirstPage(hub);
    await until(() => client.eval('typeof sessions!=="undefined"'), 'renderer');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: await client.eval('devicePixelRatio'), mobile: false });
    await client.eval(`window.__parityRaw=[];window.__parityHooks=[];ipcRenderer.on('terminal-data',(_e,p)=>__parityRaw.push(p.data));ipcRenderer.on('hook-event',(_e,p)=>__parityHooks.push({event:p.event,provider:p.provider,sid:p.sessionId,at:Date.now()}));`);
    const session = await client.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-6-astra',effort:'low',mcpProfile:'none'}})`);
    assert(session.id, j(session)); sid = session.id; report.id = sid;
    await until(() => client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`), 'row');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async () => { const s = await state(); return s?.hydrated && /for shortcuts|Ask Codex to do anything/.test(s.text) && !/model:\s+loading/.test(s.text); }, 'ready');
    report.ready = await state(); await capture('ready');
    if(process.env.BOOTSTRAP_AUDIT_ONLY){
      await send('执行 node -e "setTimeout(()=>console.log(1),20000)"，等待它结束，然后只回复 PARITY_BOOTSTRAP_OK');
      await until(()=>client.eval(`__parityHooks.some(h=>h.sid===${j(sid)}&&h.event==='tool-start')`),'real tool before bootstrap');
      await client.send('Page.enable');
      await client.send('Page.addScriptToEvaluateOnNewDocument',{source:`(()=>{
        const ipc=require('electron').ipcRenderer,invoke=ipc.invoke.bind(ipc);
        window.__bootstrapEvents=[];
        ipc.on('session-updated',(_e,p)=>__bootstrapEvents.push(p.session));
        ipc.invoke=async(channel,...args)=>{
          const result=await invoke(channel,...args);
          if(channel==='get-sessions')window.__initialRows=result;
          if(channel==='get-dormant-sessions')await new Promise(resolve=>window.__releaseMetadata=resolve);
          return result;
        };
      })()`});
      await client.send('Page.reload');
      await until(()=>client.eval(`typeof __releaseMetadata==='function'&&Array.isArray(window.__initialRows)`),'delayed bootstrap list');
      report.initialRuntime=await client.eval(`__initialRows.find(s=>s.id===${j(sid)})?.runtimeTruth`);
      check('bootstrap-starts-with-running-snapshot',report.initialRuntime?.state==='running');
      await until(()=>client.eval(`__bootstrapEvents.some(s=>s.id===${j(sid)}&&s.runtimeTruth?.state==='completed')`),'main completion delivered during bootstrap',90000);
      await client.eval('__releaseMetadata()');
      await until(()=>client.eval(`sessions.has(${j(sid)})&&!!document.querySelector('.session-item[data-session-id="${sid}"]')`),'bootstrap installed');
      await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(async()=>!!(await state())?.hydrated,'bootstrap hydrated');
      await sleep(800);report.final=await state();await capture('bootstrap-completed');
      check('new-completion-beats-stale-bootstrap-list',report.final.truth.state==='completed'&&report.final.sidebar==='completed',{truth:report.final.truth,sidebar:report.final.sidebar});
      check('bootstrap-real-answer-present',await response('PARITY_BOOTSTRAP_OK'));
      report.passed=report.checks.every(c=>c.ok);return;
    }
    const prompt = '请执行 node -e "setTimeout(()=>console.log(\'PARITY_TOOL_DONE\'),8000)"，等待它结束。然后输出 70 行，每行严格为 PARITY_HISTORY_加三位编号，从001到070，不加其他内容。';
    await send(prompt);
    const started = Date.now(); let completed = false;
    while (Date.now() - started < 150000) {
      const s = await state();
      report.samples.push({ ms: Date.now() - started, working: s.working, state: s.truth.state });
      if (!report.busyCaptured && s.working.length) { await capture('working'); report.busyCaptured = true; }
      const turns = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)},opts:{limit:4,fromTail:true}})`);
      if ((turns.turns || []).some(t => t.role === 'assistant' && /PARITY_HISTORY_070/.test(t.text))) { completed = true; break; }
      await sleep(200);
    }
    check('real-provider-completion', completed);
    report.after = await state(); await capture('after');
    fs.writeFileSync(path.join(out,'live.ansi'),await client.eval('__parityRaw.join("")'));
    const colors = report.samples.flatMap(s => s.working.filter(w=>w.text.includes('Working')).map(w=>{
      const start=w.text.indexOf('Working');return j(w.cells.slice(start,start+7).map(c=>c.slice(1)));
    }));
    const distinctColors=new Set(colors).size;
    if(report.systemAnimations === false && !process.env.PARITY_LEGACY) {
      check('native-reduced-motion-honored',colors.length>3 && distinctColors===1,{samples:colors.length,distinctColors,systemAnimations:false});
    } else check('native-working-color-animation',distinctColors>=4,{samples:colors.length,distinctColors});
    check('model-id-remains-canonical', report.after.model?.id === 'gpt-6-astra', report.after.model);
    await until(async()=>{const s=await state();return ['completed','idle'].includes(s.truth.state)&&s.working.length===0;},'idle before navigation');
    if(report.after.buffer==='alternate'){
      const firstMarker=text=>Number(text.match(/PARITY_HISTORY_(\d{3})/)?.[1]||0);
      const beforePage=firstMarker((await state()).text);
      await client.eval(`document.querySelector('.prompt-nav-btn[data-dir="up"]').click()`);
      await until(async()=>{const s=await state();return /Back to bottom/.test(s.text)&&firstMarker(s.text)<beforePage;},'native page-up button');
      const afterUp=firstMarker((await state()).text);
      await client.eval(`document.querySelector('.prompt-nav-btn[data-dir="down"]').click()`);
      await until(async()=>firstMarker((await state()).text)>afterUp+5,'native page-down button');
      check('native-page-navigation-buttons',true,{beforePage,afterUp,afterDown:firstMarker((await state()).text)});
      const key=async name=>{
        await client.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);
        await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:name,code:name,modifiers:2,windowsVirtualKeyCode:name==='Home'?36:35});
        await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:name,code:name,modifiers:2,windowsVirtualKeyCode:name==='Home'?36:35});
      };
      await key('Home');await until(async()=>(await state()).text.includes('PARITY_HISTORY_001'),'native Ctrl+Home');
      await key('End');await until(async()=>!/Back to bottom/.test((await state()).text),'native Ctrl+End');
      check('native-history-keyboard-shortcuts',true);
    }
    report.overlayScroll=await overlayScroll();
    check('wheel-over-floating-composer',report.overlayScroll.moved);
    await escape();await sleep(250);
    report.liveHistory=await history();
    check('live-history-complete', report.liveHistory.count===70, {count:report.liveHistory.count,buffer:report.after.buffer,modes:report.after.modes});
    assert(completed, 'provider completion required for resume');
    await until(async () => {const s=await state();return ['completed','idle'].includes(s.truth.state)&&s.working.length===0;}, 'settled including hooks');
    const beforeNativeId = report.after.sid;
    const closed = await client.eval(`closeSessionAsSleep(${j(sid)})`);
    assert(closed?.ok, j(closed));
    await until(() => client.eval(`sessions.get(${j(sid)})?.status==='dormant'`), 'dormant');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async () => { const s=await state(); return s?.hydrated && s.status!=='dormant' && /PARITY_HISTORY_070/.test(s.text) && !/model:\s+loading|Resuming session/.test(s.text); }, 'resumed');
    await sleep(2000);
    report.resumed = await state(); await capture('resumed');
    check('resume-same-identity', report.resumed.sid === beforeNativeId, report.resumed.sid);
    report.resumeHistory=await history();
    check('resume-history-complete', report.resumeHistory.count===70, {count:report.resumeHistory.count,buffer:report.resumed.buffer});
    await escape();await send(`执行 node -e "setTimeout(()=>console.log(1),${process.env.ACTIVITY_AUDIT ? 70000 : 12000})"，等待它结束，然后只回复 PARITY_RESUME_OK`);
    await until(async()=>(await state()).working.length>0,'busy before scroll');
    report.busyHistory=await history();
    check('scroll-up-during-real-work',report.busyHistory.count===70,{count:report.busyHistory.count});
    if(process.env.ACTIVITY_AUDIT){
      report.activity=[];
      const untilAt=Date.now()+20000;
      while(Date.now()<untilAt){
        const s=await state();report.activity.push({at:Date.now(),truth:s.truth,sidebar:s.sidebar,composer:s.composer});await sleep(250);
      }
      check('native-work-stays-active-while-browsing',report.activity.every(x=>['starting','running'].includes(x.truth.state)),{states:[...new Set(report.activity.map(x=>x.truth.state+':'+x.truth.source))]});
      await capture('active-history');
      const shell=await client.eval(`ipcRenderer.invoke('create-session',{kind:'powershell',opts:{cwd:${j(cwd)}}})`);
      await until(()=>client.eval(`!!document.querySelector('.session-item[data-session-id="${shell.id}"]')`),'background row');
      await client.eval(`document.querySelector('.session-item[data-session-id="${shell.id}"]').click()`);
      await sleep(5000);
      check('native-work-stays-active-unfocused',['starting','running'].includes((await state()).truth.state));
      await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      report.hookEvents=await client.eval('__parityHooks');
      await client.send('Page.reload');
      await until(()=>client.eval(`typeof sessions!=='undefined'&&sessions.has(${j(sid)})`),'busy renderer reload');
      await client.eval(`window.__parityHooks=[];ipcRenderer.on('hook-event',(_e,p)=>__parityHooks.push({event:p.event,provider:p.provider,sid:p.sessionId,at:Date.now()}));`);
      await until(()=>client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`),'busy reloaded row');
      await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await until(async()=>!!(await state())?.hydrated,'busy terminal hydration');
      await sleep(1500);report.busyReload=await state();
      check('native-work-survives-renderer-reload',report.busyReload.truth.state==='running'&&report.busyReload.sidebar==='running',{truth:report.busyReload.truth,sidebar:report.busyReload.sidebar});
    }
    await until(() => response('PARITY_RESUME_OK'),'native assistant resume response',90000);
    await until(async () => {const s=await state();return ['completed','idle'].includes(s.truth.state)&&s.working.length===0;},'resume settled');
    report.final = await state(); await capture('resume-response');
    check('resume-can-answer', report.final.truth.state !== 'failed', { model: report.final.model, state: report.final.truth.state, composer: report.final.composer });
    await until(async()=>/已就绪/.test((await state()).composer),'completed composer');
    check('completed-turn-is-not-running',true);
    report.hookEvents=[...(report.hookEvents||[]),...await client.eval('__parityHooks')];
    check('native-hook-lifecycle-arrives',['prompt','tool-start','tool-complete'].every(event=>report.hookEvents.some(h=>h.provider==='codex'&&h.sid===sid&&h.event===event)));
    await send('/status');
    await until(async()=>/Session:/i.test((await state()).text),'native status');
    check('native-status-command',true);await capture('status');
    await escape();await send('/model');
    await until(async()=>/Select Model|Select model|Select reasoning|Reasoning effort/i.test((await state()).text),'native model picker');
    check('native-model-picker',true);await capture('model-picker');await escape();
    await client.send('Emulation.setDeviceMetricsOverride',{width:1100,height:820,deviceScaleFactor:await client.eval('devicePixelRatio'),mobile:false});
    await sleep(700);report.narrow=await state();await capture('narrow');
    check('resize-native-terminal',report.narrow.cols<report.final.cols&&report.narrow.cols>40,{before:report.final.cols,after:report.narrow.cols});
    await client.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:await client.eval('devicePixelRatio'),mobile:false});
    const codexId=sid;
    const claude=await client.eval(`ipcRenderer.invoke('create-session',{kind:'claude',opts:{cwd:${j(cwd)},model:'haiku',mcpProfile:'none'}})`);
    assert(claude.id,j(claude));sid=claude.id;
    await until(()=>client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`),'Claude row');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async()=>!!(await state())?.hydrated,'Claude terminal');
    report.claudeStyle=(await state()).style;
    sid=codexId;
    const originalSize=await client.eval('currentFontSize');
    report.styles=[];
    for(const theme of ['dark','light'])for(const size of [14,18]){
      await client.eval(`themeController.setTheme(${j(theme)});setFontSize(${size})`);
      const pair=await client.eval(`(()=>{const read=id=>{const o=terminalCache.get(id).terminal.options;return{fontSize:o.fontSize,fontFamily:o.fontFamily,lineHeight:o.lineHeight,theme:o.theme}};return{codex:read(${j(codexId)}),claude:read(${j(claude.id)})}})()`);
      report.styles.push({theme,size,...pair});
      assert.deepEqual(pair.codex,pair.claude,'Claude and Codex share all typography/theme settings');
    }
    check('claude-typography-theme-parity',true,{sizes:[14,18],themes:['dark','light']});
    await client.eval(`themeController.setTheme('dark');setFontSize(${originalSize});document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await sleep(500);await capture('claude-aligned');
    await escape();await sleep(250);report.switchedHistory=await history();
    check('scroll-after-session-switch',report.switchedHistory.count===70,{count:report.switchedHistory.count});
    await client.send('Page.reload');
    await until(()=>client.eval(`typeof sessions!=='undefined'&&sessions.has(${j(sid)})`),'renderer reload');
    await until(()=>client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`),'reloaded row');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async()=>!!(await state())?.hydrated,'rehydrated terminal');
    await escape();await sleep(500);report.reloadedHistory=await history();
    check('scroll-after-renderer-reload',report.reloadedHistory.count===70,{count:report.reloadedHistory.count,modes:(await state()).modes});
    await capture('reloaded-history');
    const failed=await client.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-parity-invalid',effort:'low',mcpProfile:'none'}})`);
    assert(failed.id,j(failed));sid=failed.id;
    await until(()=>client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`),'error case row');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async()=>{const s=await state();return s?.hydrated&&/for shortcuts|Ask Codex to do anything/.test(s.text);},'error case ready');
    await send('只回复 PARITY_EXPECTED_REJECTION');
    await until(async()=>(await state()).truth.state==='failed','provider rejection');
    await until(async()=>/上一轮执行失败/.test((await state()).composer),'failure displayed');
    report.rejection=await state();await capture('provider-error');
    check('request-error-keeps-live-session',!/重连|已断开/.test(report.rejection.composer)&&report.rejection.status!=='dormant',report.rejection.composer);
    if(process.env.ACTIVITY_INTERACTION_AUDIT){
      sid=codexId;
      await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
      await escape();await sleep(300);
      const interruptAt=Date.now();
      await client.eval(`window.__interruptHooks=[];ipcRenderer.on('hook-event',(_e,p)=>__interruptHooks.push({event:p.event,sid:p.sessionId,at:Date.now()}));`);
      await send('执行 node -e "setTimeout(()=>console.log(123),60000)"，等待它结束。');
      await until(()=>client.eval(`__interruptHooks.some(h=>h.sid===${j(sid)}&&h.event==='tool-start'&&h.at>${interruptAt})`),'interruptible real tool');
      await escape();
      await until(async()=>['idle','interrupted'].includes((await state()).truth.state),'native interrupt');
      report.interrupted=[];
      const stableUntil=Date.now()+6000;
      while(Date.now()<stableUntil){const s=await state();report.interrupted.push({truth:s.truth,sidebar:s.sidebar});await sleep(250);}
      check('native-interrupt-stays-settled',report.interrupted.every(s=>!['starting','running'].includes(s.truth.state)));
      await capture('interrupted');
      await send('/plan');await sleep(1200);
      await send('请调用 request_user_input，问我选择红色还是蓝色，两个选项分别为红色和蓝色。收到选择后只回复 PARITY_QUESTION_OK。');
      await until(async()=>(await state()).truth.state==='waiting','native question waits',90000);
      await sleep(1800);report.question=await state();
      check('native-question-remains-waiting',report.question.truth.state==='waiting');
      await capture('question');
      await client.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);
      await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
      await until(()=>response('PARITY_QUESTION_OK'),'native question answered',90000);
      await until(async()=>(await state()).truth.state==='completed','question completes');
      check('native-question-answer-completes',true);
    }
    report.passed = report.checks.every(c => c.ok);
  } catch (error) {
    report.error = error.stack;
    if (client && sid) { report.failure = await state().catch(() => null); await capture('failure').catch(() => {}); }
  } finally {
    try {
      try { if (client) await client.close(); }
      finally { if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); } }
    } catch (error) {
      report.cleanupError=error.stack;report.passed=false;
    } finally {
      fs.rmSync(path.join(home, 'auth.json'), { force: true });
      fs.writeFileSync(path.join(out, 'result.json'), j(report));
      console.log('REPORT', out, report.passed ? 'PASS' : report.error || report.cleanupError || 'FAIL');
      if (!report.passed) process.exitCode = 1;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
