'use strict';
// 快验证：复用已 ready 的 research 房，走真人 UI（showModal 设 _meetingId + 点开始）触发，
// 监控 ~3min 看 curAct 是否真推进（委员真发言则每幕 >30s；若仍秒过则委员 ready 问题）。
const WebSocket = require('ws'); const http = require('http');
const CDP = process.env.CM_CDP || 'http://127.0.0.1:9344';
const MID = process.env.MID || '238a48cd-ba3f-4b9b-abe7-0ef07eabdecb';
function get(u){return new Promise((s,j)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>s(d))}).on('error',j)})}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function ts(){return new Date().toISOString().slice(11,19)}
function log(m){console.log(`[${ts()}] ${m}`)}
function newCdp(w){const ws=new WebSocket(w);let id=1;const p=new Map();return new Promise((ok,rj)=>{ws.on('open',()=>ok({send(m,pr={}){const i=id++;return new Promise((r,j)=>{p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pr}))})},close(){ws.close()}}));ws.on('error',rj);ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);if(m.error)j(new Error(m.error.message));else r(m.result)}})})}
(async()=>{
  const tg=JSON.parse(await get(`${CDP}/json/list`));const t=tg.find(x=>x.type==='page'&&/index\.html/.test(x.url))||tg.find(x=>x.type==='page');
  const cdp=await newCdp(t.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
  const ev=async e=>{const r=await cdp.send('Runtime.evaluate',{expression:`(async function(){${e}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||JSON.stringify(r.exceptionDetails));return r.result.value};
  // 确认房委员数
  const meeting = await ev(`try{var ms=window.committeeUI; return 'ok'}catch(e){return 'no-ui'}`);
  log('committee-ui: '+meeting);
  // 真人 UI：showModal 设 _meetingId + 填 + 点开始
  log('showModal('+MID.slice(0,8)+') 设 _meetingId...');
  await ev(`window.committeeUI.closePanel();window.committeeUI.showModal({id:'${MID}'});return '';`);
  await sleep(600);
  const clicked = await ev(`var ta=document.querySelector('[data-cm-stocks]');var rd=document.querySelector('[data-cm-rounds]');if(!ta||!rd)return 'NO_MODAL';ta.value='688256 寒武纪';rd.value='3';document.querySelector('[data-cm-start]').click();return 'CLICKED';`);
  log('点开始 → '+clicked);
  if(clicked!=='CLICKED'){ log('FAIL: 弹窗未出现'); cdp.close(); process.exit(1); }
  // 监控 ~3.5min
  let last='', t0=Date.now();
  for(let i=0;i<26;i++){
    await sleep(8000);
    let s;
    try{ s=JSON.parse(await ev(`var s=window.committeeUI._getState();return JSON.stringify({active:s.active,done:s.done,curAct:s.curAct,actRound:s.actRound,nBoards:(s.boards&&s.boards.chase_ranking||[]).length,err:s.err||s.error||'',mlen:(s.members||[]).length})`)); }catch(e){ log('poll err '+e.message); continue; }
    const dt=Math.round((Date.now()-t0)/1000);
    if(s.curAct!==last){ log(`+${dt}s ▶ 幕次=${s.curAct||'(空)'}${s.actRound?' 第'+s.actRound+'轮':''} members=${s.mlen} boards=${s.nBoards} ${s.err?'ERR:'+s.err:''}`); last=s.curAct; }
    if(s.nBoards>0){ log(`✓ 双榜真出！chase_ranking ${s.nBoards} 只`); }
    if(s.done){ log(`+${dt}s ✓ done=true`); break; }
  }
  const fin=JSON.parse(await ev(`return JSON.stringify(window.committeeUI._getState())`));
  log('终态: curAct='+fin.curAct+' done='+fin.done+' members='+JSON.stringify(fin.members)+' nBoards='+((fin.boards&&fin.boards.chase_ranking)||[]).length);
  cdp.close();
})().catch(e=>{console.error('THREW',e);process.exit(2)});
