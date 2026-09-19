'use strict';
const fs=require('fs'),path=require('path');
const {spawn}=require('child_process');
const WebSocket=require('ws');
const SITES={deepseek:'https://chat.deepseek.com/',gemini:'https://gemini.google.com/app',chatgpt:'https://chatgpt.com/'};
// Read visible UI only. A guest composer is deliberately insufficient evidence.
const PROBE=`(()=>{const visible=e=>!!e&&e.getClientRects().length>0;
 const labels=[...document.querySelectorAll('button,a')].filter(visible).map(e=>(e.innerText||e.getAttribute('aria-label')||'').trim());
 const login=labels.some(t=>/^(log in|sign in|登录|登入|登录帐号|登录账号)$/i.test(t));
 const profile=[...document.querySelectorAll('[data-testid="accounts-profile-button"],[aria-label*="Google Account"],[aria-label*="Google 帐号"],[aria-label*="Google 账号"],[data-testid="user-avatar"]')].some(visible);
 const challenge=/challenges.cloudflare.com/.test(location.hostname)||!!document.querySelector('iframe[src*="challenges.cloudflare.com"]');
 return {login,profile,challenge,host:location.hostname};})()`;
class AccountBrowser {
 constructor({dataDir,env=process.env}){this.root=path.join(dataDir,'account-browsers');this.env=env;}
 profile(provider){if(!SITES[provider])throw Error('不支持的网页登录');return path.join(this.root,provider);}
 executable(){const candidates=[path.join(this.env.PROGRAMFILES||'C:\\Program Files','Google/Chrome/Application/chrome.exe'),path.join(this.env['PROGRAMFILES(X86)']||'C:\\Program Files (x86)','Microsoft/Edge/Application/msedge.exe'),path.join(this.env.LOCALAPPDATA||'','Google/Chrome/Application/chrome.exe')];const found=candidates.find(p=>fs.existsSync(p));if(!found)throw Error('未找到 Chrome 或 Edge 浏览器');return found;}
 async open(provider){const dir=this.profile(provider);fs.mkdirSync(dir,{recursive:true});await new Promise((resolve,reject)=>{const child=spawn(this.executable(),['--user-data-dir='+dir,'--remote-debugging-port=0','--no-first-run','--no-default-browser-check','--new-window',SITES[provider]],{env:this.env,windowsHide:false,detached:true,stdio:'ignore'});child.once('error',reject);child.once('spawn',()=>{child.unref();resolve();});});return {message:'已打开此账号的专用浏览器；登录状态会保留。完成后检查登录。'};}
 async check(provider){
  let port;try{port=Number(fs.readFileSync(path.join(this.profile(provider),'DevToolsActivePort'),'utf8').split('\n')[0]);}catch(e){if(e.code==='ENOENT')return {state:'unknown',message:'尚无运行中的专用浏览器；点击登录',source:'专用浏览器'};throw e;}
  if(!Number.isInteger(port)||port<1024||port>65535)throw Error('浏览器调试地址无效');
  let tabs;try{const response=await fetch('http://127.0.0.1:'+port+'/json/list',{signal:AbortSignal.timeout(3000)});if(!response.ok)throw Error('CDP unavailable');tabs=await response.json();}catch{return {state:'offline',message:'浏览器未在线；本地登录配置仍保留，打开后再检查',source:'专用浏览器'};}
  const host=new URL(SITES[provider]).hostname;
  const tab=Array.isArray(tabs)&&tabs.find(t=>{try{return t.type==='page'&&new URL(t.url).hostname===host;}catch{return false;}});
  if(!tab?.webSocketDebuggerUrl)return {state:'unknown',message:'未找到目标网站页面；请在专用浏览器完成登录',source:'专用浏览器'};
  const wsURL=new URL(tab.webSocketDebuggerUrl);if(!['127.0.0.1','localhost'].includes(wsURL.hostname)||Number(wsURL.port)!==port)throw Error('无效浏览器连接');
  const result=await new Promise((resolve,reject)=>{
   const ws=new WebSocket(wsURL.href);const timer=setTimeout(()=>done(Error('浏览器检查超时')),5000);let ended=false;
   function done(error,value){if(ended)return;ended=true;clearTimeout(timer);ws.close();error?reject(error):resolve(value);}
   ws.on('error',e=>done(e));ws.on('close',()=>done(Error('浏览器连接关闭')));
   ws.on('open',()=>ws.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:PROBE,returnByValue:true}})));
   ws.on('message',bytes=>{try{const m=JSON.parse(bytes);if(m.id===1){if(m.error||m.result?.exceptionDetails)return done(Error('网页检查失败'));done(null,m.result?.result?.value);}}catch(e){done(e);}});
  });
  if(result?.host!==host)throw Error('网页身份检查期间页面已切换');
  return {state:result.challenge?'unknown':result.login?'login_required':result.profile?'signed_in':'unknown',
   message:result.challenge?'请在官方页面完成人机验证':result.login?'网站显示登录入口':result.profile?'当前官方页面显示账号入口；具体功能额度另行确认':'未取得明确登录证据；请查看官方页面，不能仅凭输入框判断',source:'官方网页可见状态'};
 }
}
module.exports={AccountBrowser,SITES,PROBE};
