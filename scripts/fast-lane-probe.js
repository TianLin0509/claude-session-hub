'use strict';
// 快速通道实测：用生产 Hub 的百炼语音 Key（只读解密）调用带联网搜索的快速模型，测首字与总耗时。
// 用法：electron scripts/fast-lane-probe.js --user-data-dir=<含 Local State 副本的目录>
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {app,safeStorage}=require('electron');
const QUESTIONS=['今天南通天气怎么样？','一加一等于几？','美元兑人民币现在多少？'];
const MODELS=(process.env.PROBE_MODELS||'qwen-flash,qwen-turbo,qwen-plus').split(',');
app.whenReady().then(async()=>{
 const cfg=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub','voice-input.json'),'utf8'));
 const key=safeStorage.decryptString(Buffer.from(cfg.encryptedKey,'base64'));
 const base=cfg.region==='singapore'?'https://dashscope-intl.aliyuncs.com':'https://dashscope.aliyuncs.com';
 const rows=[];
 for(const model of MODELS)for(const q of QUESTIONS){
  const t0=Date.now();let first=null,text='',status=null,error=null,sources=null;
  try{
   const r=await fetch(base+'/compatible-mode/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},
     body:JSON.stringify({model,stream:true,enable_search:true,search_options:{forced_search:true,enable_source:true,search_strategy:process.env.PROBE_STRATEGY||'turbo'},stream_options:{include_usage:true},messages:[{role:'system',content:'你是田哥的助理。今天是 '+new Date().toLocaleDateString('zh-CN')+'，田哥在江苏南通。用一两句中文直接回答。'},{role:'user',content:q}]}),signal:AbortSignal.timeout(30000)});
   status=r.status;if(!r.ok){error=(await r.text()).slice(0,300);}
   else{const reader=r.body.getReader(),dec=new TextDecoder();let buf='';
    for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;while((i=buf.indexOf('\n'))>=0){const line=buf.slice(0,i).trim();buf=buf.slice(i+1);if(!line.startsWith('data:'))continue;const d=line.slice(5).trim();if(d==='[DONE]')continue;try{const j=JSON.parse(d);if(j.search_info?.search_results)sources=j.search_info.search_results.length;const delta=j.choices?.[0]?.delta?.content;if(delta){if(first===null)first=Date.now()-t0;text+=delta;}}catch{}}}}
  }catch(e){error=e.message;}
  rows.push({model,q,status,sources,firstMs:first,totalMs:Date.now()-t0,text:text.slice(0,120),error});
 }
 console.log(JSON.stringify(rows,null,1));app.quit();
});
