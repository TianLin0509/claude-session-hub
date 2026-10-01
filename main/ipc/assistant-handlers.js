'use strict';
const {AssistantService}=require('../../core/hub-assistant/service');
function registerAssistantIpc(ipcMain,deps){
  const service=new AssistantService(deps);
  for(const [name,handler] of Object.entries({
    'get-overview':()=>service.overview(),status:()=>service.overview(),
    'ensure-session':()=>service.ensureSession(),context:request=>service.context(request),
    send:request=>service.send(request),actions:()=>({ok:true,actions:service.store.list()}),
  }))ipcMain.handle('assistant:'+name,async(_event,request={})=>{try{return await handler(request);}catch(error){return{ok:false,error:error.message};}});
  return service;
}
module.exports={registerAssistantIpc};
