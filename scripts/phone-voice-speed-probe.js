'use strict';
// 手机语音识别提速的实测探针：同一段录音分别按「说话节奏回放（旧）」和「连续推送（新）」送百炼识别，
// 记录耗时与文字。用法：electron scripts/phone-voice-speed-probe.js <wav...>（读取生产 Hub 的语音配置，只读）。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {app,safeStorage}=require('electron');
const {transcribe}=require('../core/hub-phone/voice');
function pcmOf(file){const b=fs.readFileSync(file);let at=12;while(at+8<=b.length){const name=b.toString('latin1',at,at+4),n=b.readUInt32LE(at+4);if(name==='data')return b.subarray(at+8,at+8+n);at+=8+n+(n%2);}throw Error('no data chunk');}
app.whenReady().then(async()=>{
 const dataDir=process.env.PROBE_VOICE_DATA_DIR||path.join(os.homedir(),'.claude-session-hub'),rows=[];
 for(const file of process.argv.slice(2).filter(a=>a.endsWith('.wav'))){
  const pcm=pcmOf(file).toString('base64'),seconds=Buffer.from(pcm,'base64').length/32000;
  for(const [mode,chunkDelayMs] of (process.env.PROBE_NEW_ONLY?[['new',0]]:[['new',0],['old',90]])){
   const t=Date.now();try{const text=await transcribe(pcm,{dataDir,safeStorage,chunkDelayMs});rows.push({file:path.basename(file),seconds:+seconds.toFixed(1),mode,ms:Date.now()-t,text});}
   catch(e){rows.push({file:path.basename(file),mode,ms:Date.now()-t,error:e.message});}
  }
 }
 console.log(JSON.stringify(rows,null,1));app.quit();
});
