'use strict';
// 诊断：committee-ui 实际状态 + meeting 委员发言，定位 15s 空跑根因
const WebSocket = require('ws'); const http = require('http');
const CDP = process.env.CM_CDP || 'http://127.0.0.1:9344';
const MID = process.env.MID || '7ae81864-88f3-4a7c-8333-f1b2f54f5ae7';
function get(u){return new Promise((s,j)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>s(d))}).on('error',j)})}
function newCdp(w){const ws=new WebSocket(w);let id=1;const p=new Map();return new Promise((ok,rj)=>{ws.on('open',()=>ok({send(m,pr={}){const i=id++;return new Promise((r,j)=>{p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pr}))})},close(){ws.close()}}));ws.on('error',rj);ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);if(m.error)j(new Error(m.error.message));else r(m.result)}})})}
(async()=>{
  const ts=JSON.parse(await get(`${CDP}/json/list`));const t=ts.find(x=>x.type==='page'&&/index\.html/.test(x.url))||ts.find(x=>x.type==='page');
  const cdp=await newCdp(t.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
  const ev=async e=>{const r=await cdp.send('Runtime.evaluate',{expression:`(async function(){${e}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||JSON.stringify(r.exceptionDetails));return r.result.value};
  const st=JSON.parse(await ev(`return JSON.stringify(window.committeeUI._getState())`));
  console.log('=== committee-ui state ===');
  console.log('curAct=',st.curAct,'done=',st.done,'error=',JSON.stringify(st.error));
  console.log('members=',JSON.stringify(st.members));
  console.log('boards=',JSON.stringify(st.boards));
  console.log('chairReport=',JSON.stringify(st.chairReport));
  const ms=await ev(`try{var r=await require('electron').ipcRenderer.invoke('groupchat:get-state',{meetingId:'${MID}'});return JSON.stringify({keys:Object.keys(r||{}),mode:r&&r.currentMode,msgCount:(r&&r.messages||[]).length,sample:(r&&r.messages||[]).slice(-8).map(function(m){return {sid:(m.sid||'').slice(0,6),role:m.role,len:((m.text||m.content||'')+'').length,txt:((m.text||m.content||'')+'').slice(0,60)}})})}catch(e){return 'ERR:'+e.message}`);
  console.log('=== meeting state (messages = 委员发言) ===');
  console.log(ms);
  // 委员 session 状态
  const sess=await ev(`try{var r=await require('electron').ipcRenderer.invoke('groupchat:get-state',{meetingId:'${MID}'});var subs=(r&&r.subSessions)||[];return JSON.stringify(subs.map(function(s){return typeof s==='string'?s.slice(0,8):s}))}catch(e){return 'ERR:'+e.message}`);
  console.log('=== subSessions ===');
  console.log(sess);
  cdp.close();
})().catch(e=>{console.error('THREW',e);process.exit(2)});
