'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),net=require('net'),assert=require('assert/strict');
const {randomUUID}=require('crypto');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const {CodexAppServerClient}=require('../main/codex-app-server-client');
const MODEL=process.env.REAL_CODEX_MODEL||'gpt-6.1-sol';
const j=JSON.stringify,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const port=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
async function registerHistory(home, cwd, id, answer) {
  const turn = randomUUID(), ts = new Date().toISOString(), d = new Date();
  const dir = path.join(home, 'sessions', String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0'));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-${ts.slice(0, 19).replace(/:/g, '-')}-${id}.jsonl`);
  const records = [
    { type: 'session_meta', payload: { id, timestamp: ts, cwd, originator: 'codex_cli_rs', cli_version: '0.153.4', source: 'cli', model_provider: 'openai' } },
    { type: 'event_msg', payload: { type: 'task_started', turn_id: turn, model_context_window: 258400, collaboration_mode_kind: 'default' } },
    { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Account B old question' }] } },
    { type: 'response_item', payload: { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: answer }] } },
    { type: 'event_msg', payload: { type: 'user_message', message: 'Account B old question', images: [], local_images: [], text_elements: [] } },
    { type: 'event_msg', payload: { type: 'agent_message', message: answer, phase: 'final_answer' } },
    { type: 'event_msg', payload: { type: 'task_complete', turn_id: turn, last_agent_message: answer } },
  ];
  fs.writeFileSync(file, records.map(r => j({ timestamp: ts, ...r })).join('\n') + '\n');
  // 真实 app-server 按路径打开一次，把线程登记进 B 的索引库（和生产里 B 的状态一致）。
  const c = new CodexAppServerClient({ cwd, env: { ...process.env, CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '', CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: '' }, args: [] });
  try {
    await c.start();
    const r = await c.request('thread/resume', { threadId: id, path: file, model: MODEL, approvalPolicy: 'never', sandbox: 'read-only' });
    if (r.thread.id !== id) throw Error('fixture: app-server returned another thread');
  } finally { c.close(); await c.waitForExit(); }
  return file;
}

async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-codex-reliability-'));
 const out=path.resolve('artifacts/codex-reliability/'+Date.now());fs.mkdirSync(out,{recursive:true});
 const data=path.join(root,'data'),a=path.join(root,'a'),b=path.join(root,'b'),cwd=path.join(root,'work'),bin=path.join(root,'bin');
 for(const p of [data,a,b,cwd,bin])fs.mkdirSync(p);
 const auth=path.join(process.env.REAL_CODEX_AUTH_SOURCE||process.env.CODEX_HOME,'auth.json');
 fs.copyFileSync(auth,path.join(a,'auth.json'));
 const config=`model=${j(MODEL)}\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui.model_availability_nux]\n${j(MODEL)}=4\n`;
 for(const p of [a,b])fs.writeFileSync(path.join(p,'config.toml'),config);
 const binary=require('../main/codex-windows-command').resolveWindowsCodex().command;
 fs.writeFileSync(path.join(bin,'codex.cmd'),'@echo off\r\n"'+binary+'" --no-daemon %*\r\n');
 const key=Object.keys(process.env).find(k=>k.toLowerCase()==='path');
 for(const k of ['NO_COLOR','FORCE_COLOR','TERM','COLORTERM','WT_SESSION','TERM_PROGRAM'])delete process.env[k];
 const nativeId=randomUUID(),id=randomUUID(),mid=randomUUID();
 const answer=Array.from({length:90},(_,i)=>'SCROLL_LINE_'+String(i+1).padStart(3,'0')).join('\n')+'\nRemember the codeword: ORCHID_7391';
 const rollout=await registerHistory(b,cwd,nativeId,answer);
 // Age fixture history so opening it cannot produce a new unread answer.
 fs.writeFileSync(rollout,fs.readFileSync(rollout,'utf8').split('\n').map(l=>{if(!l)return l;const r=JSON.parse(l);r.timestamp=new Date(Date.now()-3600000).toISOString();return j(r)}).join('\n'));
 fs.writeFileSync(path.join(data,'config.json'),j({providers:{codex:{backend:'subscription',subscription_profile:'default',subscription_profiles:[{id:'default',label:'A',home:a},{id:'second',label:'B',home:b}]}}}));
 fs.writeFileSync(path.join(data,'state.json'),j({version:1,cleanShutdown:true,immersiveByMeeting:{},meetings:[{id:mid,title:'Codex regression group',workspace:cwd,mode:'group',scene:'general',subSessions:[id],createdAt:Date.now()}],sessions:[{hubId:id,title:'Codex group member',kind:'codex',meetingId:mid,cwd,transcriptPath:rollout,codexSid:nativeId,codexSessionsRoot:path.join(b,'sessions'),codexProfile:'second',currentModel:{id:MODEL},effort:'low',mcpProfile:'none',codexSpeedTier:'inherit',savedAt:Date.now(),schemaVersion:1}]}));
 const result={out,root,checks:[]};let hub,c;
 const until=async(expr,ms=90000)=>{const end=Date.now()+ms;while(Date.now()<end){if(await c.eval(expr))return;await sleep(150)}throw Error('Timeout: '+expr)};
 const text=sid=>`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return '';const b=t.buffer.active;return Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'').join('\\n')})()`;
 const send=async(sid,prompt)=>c.eval(`(()=>{const b=document.querySelector('.floating-input-bar[data-session-id="${sid}"]'),i=b.querySelector('.floating-input-box');i.textContent=${j(prompt)};i.dispatchEvent(new Event('input',{bubbles:true}));b.querySelector('.floating-input-send').click()})()`);
 const shot=async name=>fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await c.send('Page.captureScreenshot',{format:'png'})).data,'base64'));
 try{
 hub=await launchIsolatedHub({dataDir:data,port:await port(),extraEnv:{CODEX_HOME:a,HUB_CODEX_PROFILE:'',HUB_CODEX_BACKEND:'subscription',CLAUDE_HUB_AGENT_RUNTIME:'pty',CLAUDE_CONFIG_DIR:path.join(root,'claude'),CODEX_SQLITE_HOME:'',[key]:bin+path.delimiter+process.env[key]}});
 c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1180,height:750,deviceScaleFactor:1,mobile:false});
 await until(`typeof sessions!=='undefined'&&sessions.has('${id}')`);
 // Expand group via its actual sidebar button before selecting the member.
 await c.eval(`document.querySelector('.meeting-item[data-meeting-id="${mid}"] .meeting-expand')?.click()`);
 await c.eval(`if(!document.querySelector('.session-item[data-session-id="${id}"]')){const m=document.querySelector('[data-meeting-id="${mid}"]');m?.querySelector('.meeting-toggle,.sl-expand,.meeting-chevron')?.click();}`);
 // Opening the member through its documented renderer entry also covers collapsed groups.
 await c.eval(`selectSession('${id}')`);
 await c.eval("if(currentView!=='pty')document.querySelector('#btn-backstage').click()");
 await until("currentView==='pty'");
 await until(`(${text(id)}).includes('SCROLL_LINE_090')`);
 result.checks.push('real CLI resumes account-B history using current account A');
 const before=await c.eval(text(id));
 await c.send('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});
 const rect=await c.eval(`(()=>{const r=terminalCache.get('${id}').terminal.element.querySelector('.xterm-screen').getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height*0.3,h:r.height}})()`);
 for(let n=0;n<3;n++){
   await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:rect.x,y:rect.y,id:1}]});
   for(let i=1;i<=8;i++){await c.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:rect.x,y:rect.y+i*12,id:1}]});await sleep(35)}
   await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(250);
 }
 const after=await c.eval(text(id));result.touch={before:before.match(/SCROLL_LINE_\d+/g),after:after.match(/SCROLL_LINE_\d+/g)};
 assert.notDeepEqual(result.touch.after,result.touch.before,'touch must move numbered native transcript lines');
 assert(result.touch.after?.length);result.checks.push('real CDP finger swipe scrolls Codex fullscreen history');await shot('touch');
 await c.eval(`document.querySelector('.floating-input-bar[data-session-id="${id}"] .fi-bridge-fork').click()`);
 await until(`Array.from(sessions.values()).some(s=>s.branchSourceSessionId==='${id}')`);
 const child=await c.eval(`Array.from(sessions.values()).find(s=>s.branchSourceSessionId==='${id}').id`);result.child=child;
 await until(`(${text(child)}).includes('SCROLL_LINE_090')||(${text(child)}).includes('ORCHID_7391')`);
 assert(!/Failed to fork|must be in Codex home/.test(await c.eval(text(child))));
 await send(child,'只回复前文约定的 codeword。');
 await until(`(async()=>{const r=await ipcRenderer.invoke('parse-session-transcript',{hubSessionId:'${child}',opts:{limit:3,fromTail:true}});return(r.turns||[]).some(t=>t.role==='assistant'&&t.text?.trim()==='ORCHID_7391')})()`);
 result.checks.push('UI fork across accounts creates independent child; real model recalls inherited codeword');await shot('fork-reply');
 await c.eval(`selectSession('${id}')`);await until(`activeSessionId==='${id}'&&!!document.querySelector('.floating-input-bar[data-session-id="${id}"]')`);
 await send(id,'只回复 GROUP_DIRECT_DONE。');await c.eval("document.querySelector('#btn-home').click()");
 await until(`(sessions.get('${id}').unreadCount||0)>0&&['completed','idle'].includes(getSessionRuntimeTruth(sessions.get('${id}')).state)`);
 result.unread=await c.eval(`(()=>{const s=sessions.get('${id}');return{count:s.unreadCount,truth:getSessionRuntimeTruth(s),members:[...meetingUnread.getMeetingUnreadMemberIds(meetings['${mid}'],sessions)]}})()`);
 assert.equal(result.unread.count,1);assert(result.unread.members.includes(id));await sleep(1500);assert.equal(await c.eval(`sessions.get('${id}').unreadCount`),1);
 result.checks.push('direct group-member CLI answer settles and enters unread exactly once without dispatcher round');await shot('unread');
 result.passed=true;
 }catch(e){result.error=e.stack;if(c){result.terminal=await c.eval(text(id)).catch(()=>null);await shot('failure').catch(()=>{})}process.exitCode=1}
 finally{if(c)await c.close();if(hub){fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));await gracefulQuit(hub)}fs.unlinkSync(path.join(a,'auth.json'));fs.writeFileSync(path.join(out,'evidence.json'),j(result));console.log(j(result))}
}
main().catch(e=>{console.error(e);process.exitCode=1});

