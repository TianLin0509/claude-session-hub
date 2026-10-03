'use strict';
const fs=require('node:fs'),path=require('node:path');
async function transcribe(data,{dataDir,safeStorage}){
 const pcm=Buffer.from(data,'base64');if(!pcm.length||pcm.length%2||pcm.length>16000*2*90)throw Error('录音需为 16kHz 单声道，且不超过 90 秒');
 let cfg={region:'beijing'},key=process.env.DASHSCOPE_API_KEY||'';
 const file=path.join(dataDir,'voice-input.json');if(fs.existsSync(file)){cfg=JSON.parse(fs.readFileSync(file,'utf8'));if(cfg.encryptedKey)key=safeStorage.decryptString(Buffer.from(cfg.encryptedKey,'base64'));}
 if(!key)throw Error('电脑尚未设置语音识别，请在 Hub 输入框的语音设置中配置');
 const {VoiceStream}=require('../voice-input');let finish,fail;const result=new Promise((a,b)=>{finish=a;fail=b;});result.catch(()=>{});
 const stream=new VoiceStream({config:cfg,apiKey:key,sampleRate:16000,profile:{},onEvent:r=>{if(r.type==='done')finish(r.text);if(r.type==='error')fail(Error(r.message));}});
 try{await stream.ready;for(let at=0;at<pcm.length;at+=3200){await stream.audio(pcm.subarray(at,at+3200));await new Promise(r=>setTimeout(r,90));}await stream.finish();return await result;}finally{if(!stream.ended)stream.cancel();}
}
module.exports={transcribe};
