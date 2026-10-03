'use strict';
const fs=require('node:fs'),path=require('node:path');
const MAX_SECONDS=120;
// 手机语音不属于某个项目：合并电脑端各项目的专业词表，领域说明因项目而异不带。
function mergedProfile(cfg){
 const terms=new Set();
 for(const profile of Object.values(cfg.profiles||{}))for(const term of String(profile?.terms||'').split(/[,，;；\n]/).map(t=>t.trim()))if(term&&term.length<=60&&terms.size<80)terms.add(term);
 return{terms:[...terms].join('\n'),context:''};
}
async function transcribe(data,{dataDir,safeStorage,chunkDelayMs=0}){
 const pcm=Buffer.from(data,'base64');if(!pcm.length||pcm.length%2||pcm.length>16000*2*MAX_SECONDS)throw Error(`录音需为 16kHz 单声道，且不超过 ${MAX_SECONDS} 秒`);
 let cfg={region:'beijing'},key=process.env.DASHSCOPE_API_KEY||'';
 const file=path.join(dataDir,'voice-input.json');if(fs.existsSync(file)){cfg=JSON.parse(fs.readFileSync(file,'utf8'));if(cfg.encryptedKey)key=safeStorage.decryptString(Buffer.from(cfg.encryptedKey,'base64'));}
 if(!key)throw Error('电脑尚未设置语音识别，请在 Hub 输入框的语音设置中配置');
 const {VoiceStream}=require('../voice-input');let finish,fail;const result=new Promise((a,b)=>{finish=a;fail=b;});result.catch(()=>{});
 // 整段一次推完，服务端收尾时间随录音长度增加，等待放宽到 30 秒。
 const stream=new VoiceStream({config:cfg,apiKey:key,sampleRate:16000,timeoutMs:30000,profile:mergedProfile(cfg),onEvent:r=>{if(r.type==='done')finish(r.text);if(r.type==='error')fail(Error(r.message));}});
 // 录音已完整到手，不再按说话节奏回放（旧做法让 30 秒语音多等约 27 秒）；按 0.1 秒一块连续推送。
 try{await stream.ready;for(let at=0;at<pcm.length;at+=3200){await stream.audio(pcm.subarray(at,at+3200));if(chunkDelayMs)await new Promise(r=>setTimeout(r,chunkDelayMs));}await stream.finish();return await result;}finally{if(!stream.ended)stream.cancel();}
}
module.exports={transcribe,mergedProfile,MAX_SECONDS};
