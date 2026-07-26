'use strict';
// 第二轮真测 smoke：连隔离 Hub CDP，真实验证「过往投委会」端到端——
// committee-history IPC（list/get）+ UI 历史回看（showHistory → 列表 → 点开 → 五幕 tab → 每幕发言）。
// 前置：<dataDir>/committee-history/ 已预写 mock record；Hub 已启动（CM_CDP env 指向其 CDP 端口）。
const WebSocket = require('ws'); const http = require('http');
const CDP = process.env.CM_CDP || 'http://127.0.0.1:9345';
function get(u){return new Promise((s,j)=>{http.get(u,r=>{let d='';r.on('data',c=>d+=c);r.on('end',()=>s(d))}).on('error',j)})}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}
function ts(){return new Date().toISOString().slice(11,19)}
function log(m){console.log(`[${ts()}] ${m}`)}
function newCdp(w){const ws=new WebSocket(w);let id=1;const p=new Map();return new Promise((ok,rj)=>{ws.on('open',()=>ok({send(m,pr={}){const i=id++;return new Promise((r,j)=>{p.set(i,{r,j});ws.send(JSON.stringify({id:i,method:m,params:pr}))})},close(){ws.close()}}));ws.on('error',rj);ws.on('message',raw=>{const m=JSON.parse(raw.toString());if(m.id&&p.has(m.id)){const{r,j}=p.get(m.id);p.delete(m.id);if(m.error)j(new Error(m.error.message));else r(m.result)}})})}
(async()=>{
  const tg=JSON.parse(await get(`${CDP}/json/list`));
  const t=tg.find(x=>x.type==='page'&&/index\.html/.test(x.url))||tg.find(x=>x.type==='page');
  if(!t){console.error('NO renderer page');process.exit(2)}
  const cdp=await newCdp(t.webSocketDebuggerUrl);await cdp.send('Runtime.enable');
  const ev=async e=>{const r=await cdp.send('Runtime.evaluate',{expression:`(async function(){${e}})()`,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(r.exceptionDetails.exception&&r.exceptionDetails.exception.description||JSON.stringify(r.exceptionDetails));return r.result.value};
  let pass=0,fail=0;
  const ok=(c,m)=>{ if(c){pass++;log('  ok  '+m)}else{fail++;log(' FAIL '+m)} };

  // 1. committee-ui 真实加载
  ok(await ev(`return !!(window.committeeUI&&window.committeeUI.showHistory&&window.committeeUI.showModal&&window.committeeUI.closePanel)`), 'committeeUI 加载（showHistory/showModal/closePanel）');

  // 2. history:list IPC 端到端（含预写 mock record）
  const list=JSON.parse(await ev(`var x=await require('electron').ipcRenderer.invoke('committee:history:list');return JSON.stringify(x)`));
  ok(list&&list.status==='ok'&&(list.items||[]).length>=1, 'history:list IPC ok，≥1 场 (实得 '+((list.items||[]).length)+')');
  const item0=(list.items||[])[0]||{};
  ok(item0.stocks&&item0.stocks.length&&item0.chair, 'list 摘要含 stocks + chair');
  ok(item0.acts===undefined, 'list 摘要轻量（不带 acts）');
  const mockId=item0.id;

  // 3. history:get IPC 端到端（完整 record 含每幕 speeches）
  const got=JSON.parse(await ev(`var x=await require('electron').ipcRenderer.invoke('committee:history:get',{id:${JSON.stringify(mockId)}});return JSON.stringify(x)`));
  ok(got&&got.status==='ok'&&got.record&&(got.record.acts||[]).length>=4, 'history:get 返回完整 record (acts '+((got.record&&got.record.acts)||[]).length+')');
  ok(got.record&&got.record.acts.some(a=>a.speeches&&a.speeches.length), 'record 每幕含委员发言原文');

  // 4. UI 历史回看：showHistory → 历史列表 DOM
  await ev(`if(window.committeeUI.closePanel)window.committeeUI.closePanel();await window.committeeUI.showHistory({id:'r2'});return ''`);
  await sleep(450);
  ok(await ev(`return !!document.querySelector('.cm-panel [data-cm-hist-id]')`), 'showHistory 渲染历史列表（DOM [data-cm-hist-id]）');
  ok(await ev(`return (document.querySelector('.cm-panel')||{}).innerHTML.indexOf('过往投委会')>=0`), '面板显示「过往投委会」标题');

  // 5. 点历史项 → 回看面板（历史回看徽章 + 五幕 tab）
  await ev(`document.querySelector('.cm-panel [data-cm-hist-id]').click();return ''`);
  await sleep(600);
  ok(await ev(`return !!document.querySelector('.cm-panel [data-cm-tab]')`), '回看面板渲染五幕 tab（[data-cm-tab]）');
  ok(await ev(`return (document.querySelector('.cm-panel')||{}).innerHTML.indexOf('历史回看')>=0`), '面板显示「历史回看」徽章');
  ok(await ev(`return !!document.querySelector('.cm-panel [data-cm-drag]')`), '面板有拖动手柄 [data-cm-drag]（点3a）');

  // 6. 点 tab → 渲染该幕委员发言原文（点4）
  const hitTab=await ev(`var tabs=document.querySelectorAll('.cm-panel [data-cm-tab]');var found='';for(var i=0;i<tabs.length;i++){tabs[i].click();if(document.querySelector('.cm-panel .cm-sp')){found=tabs[i].getAttribute('data-cm-tab');break}}return found`);
  ok(hitTab, '点 tab 渲染该幕委员发言原文（.cm-sp），命中幕='+hitTab);

  // 7. 双榜总览渲染（点1/3b：输名字也聚合出双榜）
  ok(await ev(`var h=(document.querySelector('.cm-panel')||{}).innerHTML||'';return h.indexOf('绝对体检')>=0&&h.indexOf('相对买入榜')>=0`), '面板渲染双榜总览（绝对体检+相对买入榜）');

  log(`\n=== R2 smoke: ${pass} passed, ${fail} failed ===`);
  cdp.close();
  process.exit(fail?1:0);
})().catch(e=>{console.error('THREW',e&&e.stack||e);process.exit(2)});
