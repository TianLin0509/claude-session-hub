'use strict';
const fs=require('node:fs'),path=require('node:path');
function registerPhoneIpc(ipcMain,assistant,{dataDir,electron}){
 const dir=path.join(dataDir,'assistant','phone');let channel;
 const ensure=()=>{if(channel)return channel;if(!electron.safeStorage.isEncryptionAvailable())throw Error('系统安全存储不可用，手机连接信息未保存');
  const {PhoneJournal}=require('../../core/hub-phone/journal'),{PhoneChannel}=require('../../core/hub-phone/channel');
  channel=new PhoneChannel({assistant,journal:new PhoneJournal(dir,electron.safeStorage),imageRoots:[dataDir,process.env.AI_HUB_WORKSPACE_ROOT||'C:/AIWork',path.join(require('node:os').homedir(),'Desktop','claude-artifacts')],renderCards:text=>require('../../core/hub-phone/cards').renderCards(electron,text),transcribe:pcm=>require('../../core/hub-phone/voice').transcribe(pcm,{dataDir,safeStorage:electron.safeStorage}),
    fastLane:process.env.HUB_ASSISTANT_FAST_LANE==='0'?null:new (require('../../core/hub-assistant/fast-lane').FastLane)({credentials:()=>require('../../core/hub-phone/voice').dashscopeCredentials({dataDir,safeStorage:electron.safeStorage})})});
  if(channel.journal.state.enabled)channel.start();return channel;
 };
 for(const [name,fn]of Object.entries({status:()=>ensure().status(),pair:()=>ensure().pair(),pause:()=>ensure().pause(),resume:()=>{const c=ensure();c.journal.change(s=>{s.enabled=true;});c.start();return c.status();}}))ipcMain.handle('assistant:phone-'+name,async()=>{try{return await fn();}catch(e){return{ok:false,error:e.message};}});
 if(fs.existsSync(path.join(dir,'channel.bin')))try{ensure();}catch(e){console.warn('[phone] unavailable:',e.message);}
 return{observeReceipt:r=>channel?.observeReceipt(r),kick:()=>channel?.kick?.(),close:()=>channel?.close()};
}
module.exports={registerPhoneIpc};
