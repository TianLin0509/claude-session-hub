'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');
const { AccountBrowser } = require('../account-browser');
const { dataDir, sleep } = require('./store');
class CDP {
  constructor(ws) { this.ws=ws; this.next=0; this.pending=new Map();this.networkErrors=[];
    ws.on('message', bytes => { let m; try { m=JSON.parse(bytes); } catch { this.fail(Error('Invalid CDP message')); return; }
      if(m.method==='Network.responseReceived'&&m.params.response.status>=400){const r=m.params.response;try{const u=new URL(r.url);this.networkErrors.push({site:u.origin,path:u.pathname,status:r.status});this.networkErrors=this.networkErrors.slice(-10);}catch{ /* Non-URL network metadata is not useful. */ }}
      const p=this.pending.get(m.id); if (!p) return; this.pending.delete(m.id); clearTimeout(p.timer); m.error?p.reject(Error(m.error.message)):p.resolve(m.result); });
    ws.on('error', e=>this.fail(e)); ws.on('close',()=>this.fail(Error('Browser disconnected')));
  }
  static async connect(url, port) { const u=new URL(url); if (!['127.0.0.1','localhost'].includes(u.hostname) || Number(u.port)!==port || u.protocol!=='ws:') throw Error('Unsafe CDP endpoint'); const ws=new WebSocket(u.href); const c=new CDP(ws); await new Promise((resolve,reject)=>{ const timer=setTimeout(()=>{ ws.terminate(); reject(Error('CDP connect timeout')); },5000); ws.once('open',()=>{clearTimeout(timer);resolve();}); ws.once('error',e=>{clearTimeout(timer);reject(e);}); }); return c; }
  fail(e) { for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(e);} this.pending.clear(); }
  call(method,params={}) { return new Promise((resolve,reject)=>{ if(this.ws.readyState!==WebSocket.OPEN)return reject(Error('Browser disconnected')); const id=++this.next,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout: '+method));},15000); this.pending.set(id,{resolve,reject,timer}); this.ws.send(JSON.stringify({id,method,params})); }); }
  async evaluate(expression) { const r=await this.call('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true}); if(r.exceptionDetails)throw Error(r.exceptionDetails.exception?.description||r.exceptionDetails.text); return r.result?.value; }
  close(){this.ws.close();}
}
async function endpoint(profile) {
  let text; try { text=fs.readFileSync(path.join(profile,'DevToolsActivePort'),'utf8').trim().split('\n'); } catch(e){if(e.code==='ENOENT')return null;throw e;}
  const port=Number(text[0]); if(!Number.isInteger(port)||port<1024||port>65535)return null;
  try { const r=await fetch(`http://127.0.0.1:${port}/json/version`,{signal:AbortSignal.timeout(1500)}); if(!r.ok)return null; const value=await r.json(); if(new URL(value.webSocketDebuggerUrl).pathname!==text[1]?.trim())throw Error('Profile CDP identity mismatch'); return {port,...value}; }
  catch(e){if(e.message==='Profile CDP identity mismatch')throw e;return null;}
}
async function open(provider, url, options={}) {
  const accounts=new AccountBrowser({dataDir:options.dataDir||dataDir()}), profile=accounts.profile(provider); fs.mkdirSync(profile,{recursive:true});
  let info=await endpoint(profile), owned=false, child, launchError;
  if(!info){
    owned=true; child=spawn(accounts.executable(),['--headless=new','--user-data-dir='+profile,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','about:blank'],{windowsHide:true,stdio:'ignore'});
    child.on('error',e=>{launchError=e;});
    const end=Date.now()+20000;
    while(!info&&Date.now()<end){if(launchError)throw launchError;if(child.exitCode!==null)throw Error('Browser profile busy or browser failed to start');await sleep(200); info=await endpoint(profile);}
    if(!info){if(child.exitCode===null)child.kill();throw Error('Browser did not expose its profile CDP endpoint');}
  }
  const browser=await CDP.connect(info.webSocketDebuggerUrl,info.port);
  let targetId,page;
  try {
    // Chrome may hand a concurrent launch to an already running profile owner.
    // Only close a browser whose main PID is the exact child we spawned.
    let browserPid=null;
    if(owned){owned=false;const processes=await browser.call('SystemInfo.getProcessInfo');browserPid=processes.processInfo?.find(p=>p.type==='browser')?.id;owned=browserPid===child.pid;if(!owned)child.unref();}
    ({targetId}=await browser.call('Target.createTarget',{url:'about:blank'}));
    const tabs=await (await fetch(`http://127.0.0.1:${info.port}/json/list`,{signal:AbortSignal.timeout(3000)})).json();
    const tab=tabs.find(t=>t.id===targetId); if(!tab)throw Error('New browser tab missing');
    page=await CDP.connect(tab.webSocketDebuggerUrl,info.port); await page.call('Page.enable');await page.call('Network.enable');await page.call('Page.navigate',{url});
    return {page,targetId,owned,browserPid,headless:/HeadlessChrome/.test(info['User-Agent']||''),async close(){page.close();try{if(owned){await browser.call('Browser.close');}else await browser.call('Target.closeTarget',{targetId});}finally{browser.close();if(owned&&child.exitCode===null)await Promise.race([new Promise(r=>child.once('exit',r)),sleep(5000)]);}}};
  } catch(e){page?.close();try{if(owned)await browser.call('Browser.close');else if(targetId)await browser.call('Target.closeTarget',{targetId});}catch(cleanup){e.message+='; cleanup: '+cleanup.message;}browser.close();throw e;}
}
module.exports={CDP,endpoint,open};
