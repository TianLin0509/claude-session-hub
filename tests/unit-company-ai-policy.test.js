'use strict';
const assert=require('node:assert/strict');
// Isolated process/module cache: never write the real distribution marker.
require.cache[require.resolve('../core/distribution')]={exports:{target:'company'}};
const policy=require('../core/company-ai-policy');
(async()=>{
 policy.assertKind('codeagent');policy.assertKind('powershell');policy.assertKind('codeagent-resume');
 for(const kind of ['codex','claude','gemini','chatgpt'])assert.throws(()=>policy.assertKind(kind),/公司版/);
 let network=0;
 const {createPromptPolisher}=require('../core/prompt-polish');
 const polish=createPromptPolisher({getConfig:()=>({deepseekApiKey:'present'}),fetchImpl:()=>{network++;throw Error('network');},runCompanyAi:async request=>{assert.match(request.system,/草稿/);return {text:request.text,model:'CodeAgent'};}});
 assert.equal((await polish('保留 `file.js`')).model,'CodeAgent');
 await assert.rejects(createPromptPolisher({getConfig:()=>({deepseekApiKey:'present'})})('text'),/尚未准备好/);
 const plan=require('../core/voice-tokenplan');
 await assert.rejects(plan.recognize(Buffer.alloc(100),{apiKey:'present',fetchImpl:()=>network++}),/公司版/);
 assert.throws(()=>new (require('../core/voice-input').VoiceStream)({socketFactory:()=>network++}),/公司版/);
 const engine=require('../core/voice-engine');
 assert.equal(engine.resolveEngine({engine:'streaming'},'.').engine,'local');
 assert.equal(engine.resolveEngine({engine:'tokenplan'},'.').planKey,'');
 const pcm=Buffer.alloc(32000);for(let i=0;i<pcm.length;i+=2)pcm.writeInt16LE(i%8?3000:-3000,i);
 const local={ready:true,touch(){},transcribe:async()=>{throw Error('local failed');}};
 await assert.rejects(engine.segmentRecognizer({engine:'tokenplan',planKey:'present',local,fetchImpl:()=>network++})(pcm),/local failed/);
 await assert.rejects(engine.transcribeRecording(pcm,{engine:'streaming',planKey:'present',local,fetchImpl:()=>network++}),/local failed/);
 const live=new (require('../core/voice-live').LiveVoice)({sampleRate:16000,local:{ready:false},openApi:()=>network++,onEvent:()=>{}});live.cancel();
 await assert.rejects(require('../core/dream-consolidation').runConsolidation({}),/造梦/);
 assert.equal(network,0);
 console.log('PASS company policy: saved keys, cloud fallbacks and unsupported kinds cannot bypass company routing');
})().catch(e=>{console.error(e);process.exitCode=1;});
