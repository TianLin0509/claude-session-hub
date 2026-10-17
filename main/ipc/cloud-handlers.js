'use strict';
function registerCloudIpc(ipcMain,{service,shell,distribution=require('../../core/distribution')}={}){
  if(!distribution.personalModules||!service?.enabled)return;
  const methods={'cloud:state':()=>service.getState(),'cloud:refresh':()=>service.refresh(),'cloud:settings':p=>service.setSettings(p),'cloud:plan':()=>service.planOptimization(),'cloud:run':p=>service.runOptimization(p),'cloud:open':p=>service.openService(p.id,url=>shell.openExternal(url))};
  for(const [name,run] of Object.entries(methods))ipcMain.handle(name,async(_event,payload={})=>{try{return await run(payload||{});}catch(e){const {MESSAGES}=require('../../core/cloud/service');return {ok:false,error:MESSAGES[e.message]||'操作未完成，请刷新后重试。'};}});
}
module.exports={registerCloudIpc};
