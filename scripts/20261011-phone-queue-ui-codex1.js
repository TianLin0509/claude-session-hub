'use strict';
// 真实隔离 Hub，使用合成对话记录验证排队/未知/回答三种界面状态；不调用模型。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('../tests/helpers/hub-launcher');
const {connectFirstPage}=require('../tests/helpers/cdp-client');
const {DialogLog}=require('../core/hub-assistant/dialog-log');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'phone-queue-ui-')),data=path.join(root,'data');
 const out=path.resolve('artifacts/20261011-phone-queue-codex1');fs.mkdirSync(out,{recursive:true});
 const log=new DialogLog(path.join(data,'assistant')),id='fixture-photo-123456';
 log.append({id,role:'user',input:'text',text:'请解答照片里的练习题。'});
 log.append({id,role:'delivery',state:'queued',text:'已到电脑，等待助理接收'});
 const port=await new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});
 let hub,c;const result={scope:'真实隔离 Hub 界面，合成对话数据，无模型调用',checks:[]};
 const until=async(fn)=>{for(let i=0;i<100;i++){const v=await fn();if(v)return v;await wait(200);}throw Error('UI timeout');};
 const click=async selector=>{const p=await until(()=>c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return r.width&&r.height?{x:r.x+r.width/2,y:r.y+r.height/2}:null})()`));for(const type of ['mousePressed','mouseReleased'])await c.send('Input.dispatchMouseEvent',{type,...p,button:'left',clickCount:1});};
 const shot=async name=>{const r=await c.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(r.data,'base64'));};
 try{
  hub=await launchIsolatedHub({dataDir:data,port,label:'phone-queue-ui',windowMode:'background',extraEnv:{CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),ANTHROPIC_API_KEY:'',OPENAI_API_KEY:''}});
  c=await connectFirstPage(hub);await c.send('Emulation.setDeviceMetricsOverride',{width:1200,height:850,deviceScaleFactor:1,mobile:false});
  await until(()=>c.eval('typeof assistantPanel!=="undefined"'));
  if(await c.eval('document.getElementById("app-container").classList.contains("rail-hidden")'))await click('#btn-toggle-navigation');
  await click('#btn-assistant');
  await until(()=>c.eval('document.querySelector(".ap-msg.typing .ap-cap")?.textContent==="已到电脑，等待助理接收"'));
  await shot('20261011-queued-codex1');result.checks.push('排队显示已到电脑，等待助理接收');
  log.append({id,role:'delivery',state:'unknown',text:'任务是否送达尚未确认，正在核对，不会自动再发。'});
  await click('#btn-home');await click('#btn-assistant');
  await until(()=>c.eval('document.querySelector(".ap-msg.typing .ap-cap")?.textContent.includes("送达尚未确认")'));
  await shot('20261011-unknown-codex1');result.checks.push('未知回执显示核对中，不冒充正在回答');
  log.append({id,role:'assistant',lane:'assistant',by:'测试助理',text:'测试题答案为 2。'});
  await click('#btn-home');await click('#btn-assistant');
  await until(()=>c.eval('!document.querySelector(".ap-msg.typing")&&document.querySelector(".ap-list")?.textContent.includes("测试题答案为 2")'));
  await shot('20261011-answer-codex1');result.checks.push('回答出现后等待提示消失，原题保留');result.passed=true;
 }catch(e){result.error=e.stack;process.exitCode=1;if(c)await shot('20261011-failure-codex1').catch(()=>{});}
 finally{c?.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,'20261011-ui-verification-codex1.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
