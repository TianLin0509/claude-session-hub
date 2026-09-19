'use strict';
function registerAccountCenterIpc(ipcMain,service){
 for(const [name,fn] of Object.entries({snapshot:()=>service.snapshot(),check:p=>service.check(p.id),login:p=>service.login(p.id),release:p=>service.release(p.id)})){
  ipcMain.handle('accounts:'+name,async(_event,p={})=>{try{if(name!=='snapshot'&&(typeof p.id!=='string'||p.id.length>100))throw Error('连接标识无效');return {ok:true,data:await fn(p)};}catch(e){return {ok:false,error:e.message||'账号操作失败'};}});
 }
}
module.exports={registerAccountCenterIpc};
