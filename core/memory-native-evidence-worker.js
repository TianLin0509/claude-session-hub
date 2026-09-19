'use strict';
// Parse a known native transcript off the UI thread. Never discover other sessions.
const fs=require('node:fs');
const {parentPort,workerData}=require('node:worker_threads');
const {createHash}=require('node:crypto');
const {StringDecoder}=require('node:string_decoder');
const MAX_BYTES=128*1024*1024, MAX_LINE=4*1024*1024;
function instructionFromRecord(record) {
  if (record.type!=='response_item' || record.payload?.type!=='message' || record.payload.role!=='user') return null;
  const text=(record.payload.content || []).filter(c=>c.type==='input_text'||c.type==='text').map(c=>c.text||'').join('\n');
  const match=text.match(/^# AGENTS\.md instructions(?: for ([^\r\n]+))?\r?\n[\s\S]*?<INSTRUCTIONS>([\s\S]*?)<\/INSTRUCTIONS>/);
  if (!match) return null;
  // A scope directory is not proof of which individual ancestor files contributed.
  return {label:'AGENTS.md 原生注入',scope:match[1]||'',content:match[2].trim(),path:'',
    observedAt:Date.parse(record.timestamp)||0,evidence:'原生记录中的指令正文',snapshot:true};
}
async function inspect({file,nativeId}) {
  const rows=new Map(),warnings=new Set();let confirmed=false,bytes=0,carry='',discard=false;
  const stat=await fs.promises.stat(file),decoder=new StringDecoder('utf8');
  const stream=fs.createReadStream(file,{highWaterMark:64*1024,end:MAX_BYTES-1});
  function line(text) {
    if(!text.trim())return;
    let obj;try{obj=JSON.parse(text);}catch {warnings.add('原生记录存在无法解析的行，未将其作为注入证据');return;}
    if(obj.type==='session_meta') {if(obj.payload?.id!==nativeId)throw new Error('原生记录身份不匹配');confirmed=true;}
    const row=instructionFromRecord(obj);
    if(row){row.id=createHash('sha256').update(row.scope+'\0'+row.content).digest('hex'); rows.set(row.scope,row);}
  }
  for await(const chunk of stream){
    bytes+=chunk.length;carry+=decoder.write(chunk);
    let end;
    while((end=carry.indexOf('\n'))>=0){const text=carry.slice(0,end);carry=carry.slice(end+1);if(!discard){if(text.length<=MAX_LINE)line(text);else warnings.add('超过 4 MB 的原生行未解析');}discard=false;}
    if(carry.length>MAX_LINE){carry='';discard=true;warnings.add('超过 4 MB 的原生行未解析');}
  }
  carry+=decoder.end();
  if(stat.size>bytes)warnings.add('原生记录超过 128 MB，本次仅核对文件开头；结果可能不完整');
  else if(carry && !discard) line(carry);
  if(!confirmed)throw new Error('没有找到匹配的原生会话身份');
  return {rows:[...rows.values()],warnings:[...warnings],bytesRead:bytes};
}
if(parentPort)inspect(workerData).then(data=>parentPort.postMessage({ok:true,data}),error=>parentPort.postMessage({ok:false,error:error.message}));
module.exports={instructionFromRecord,inspect};
