'use strict';
// 纯监控已触发的投委会五幕（_meetingId 已由 quickverify showModal 设对），查 _getState 直到 done。
const WebSocket = require('ws'); const http = require('http'); const fs = require('fs');
const CDP = process.env.CM_CDP || 'http://127.0.0.1:9344';
const ART = 'C:/Users/lintian/Desktop/claude-artifacts';
function get(u){return new Promise((s,j)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>s(d))}).on('error',j)})}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function ts(){return new Date().toISOString().slice(11,19)}
function log(m){console.log(`[${ts()}] ${m}`)}
function newCdp(w){const ws=new WebSocket(w);let id=1;const p=new Map();return new Promise((ok,rj)=>{ws.on('open',()=>ok({send(m,pr={}){const i=id++;return new Promise((r,j)=>{p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pr}))})},close(){ws.close()}}));ws.on('error',rj);ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);if(m.error)j(new Error(m.error.message));else r(m.result)}})})}
(async()=>{
  const tg=JSON.parse(await get(`${CDP}/json/list`));const t=tg.find(x=>x.type==='page'&&/index\.html/.test(x.url))||tg.find(x=>x.type==='page');
  const cdp=await newCdp(t.webSocketDebuggerUrl);await cdp.send('Runtime.enable');await cdp.send('Page.enable');
  const ev=async e=>{const r=await cdp.send('Runtime.evaluate',{expression:`(async function(){${e}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||JSON.stringify(r.exceptionDetails));return r.result.value};
  const shot=async n=>{try{const r=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(`${ART}/${n}.png`,Buffer.from(r.data,'base64'));log('截图 '+n)}catch(e){}};
  let last='',boardsSeen=false,chairSeen=false,t0=Date.now();
  for(let i=0;i<80;i++){ // 最多 ~13min
    await sleep(10000);
    let s;
    try{ s=JSON.parse(await ev(`var s=window.committeeUI._getState();return JSON.stringify({active:s.active,done:s.done,curAct:s.curAct,actRound:s.actRound,nBoards:(s.boards&&s.boards.chase_ranking||[]).length,chaseTop:(s.boards&&s.boards.chase_ranking&&s.boards.chase_ranking[0])||null,ambTop:(s.boards&&s.boards.ambush_ranking&&s.boards.ambush_ranking[0])||null,probes:(s.boards&&s.boards.probes||[]).length,iso:(s.boards&&s.boards.isolated||[]).length,hasChair:!!(s.chairReport&&!s.chairReport.degraded&&(s.chairReport.chase_buys||[]).length),err:s.error||''})`)); }catch(e){ log('poll '+e.message); continue; }
    const dt=Math.round((Date.now()-t0)/1000);
    if(s.curAct!==last){ log(`+${dt}s ▶ ${s.curAct||'(空)'}${s.actRound?' 第'+s.actRound+'轮':''}`); last=s.curAct; await shot('committee-real-'+s.curAct); }
    if(s.nBoards>0&&!boardsSeen){ boardsSeen=true; log(`✓ 双榜真出！追涨榜首=${JSON.stringify(s.chaseTop)} 低吸榜首=${JSON.stringify(s.ambTop)} 探针=${s.probes} 隔离=${s.iso}`); }
    if(s.hasChair&&!chairSeen){ chairSeen=true; log('✓ 主席报告(真实非降级)生成'); }
    if(s.err) log('⚠ '+s.err);
    if(s.done){ log(`+${dt}s ✓✓ done=true 五幕完成`); break; }
  }
  await shot('committee-real-final');
  const fin=await ev(`return JSON.stringify(window.committeeUI._getState())`);
  fs.writeFileSync(`${ART}/committee-real-result.json`,fin);
  const f=JSON.parse(fin);
  log('=== 终态 ===');
  log('done='+f.done+' curAct='+f.curAct);
  log('boards.chase_ranking='+JSON.stringify((f.boards&&f.boards.chase_ranking)||[]));
  log('boards.ambush_ranking='+JSON.stringify((f.boards&&f.boards.ambush_ranking)||[]));
  log('chairReport='+JSON.stringify(f.chairReport));
  log(`验证: 双榜出=${boardsSeen} 主席报告=${chairSeen}`);
  cdp.close();
  process.exit(boardsSeen?0:1);
})().catch(e=>{console.error('THREW',e);process.exit(2)});
