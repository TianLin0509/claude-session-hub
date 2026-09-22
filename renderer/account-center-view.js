'use strict';
// Presentation only: each action keeps an original connection id. Never infer identity
// from a suffix, a masked email, or a shared website.
function accountRows(connections) {
 const groups=new Map(),rows=[];
 for(const row of connections){
  if(row.provider!=='images'||!row.loginGroup){rows.push(row);continue;}
  if(!groups.has(row.loginGroup)){const members=[];groups.set(row.loginGroup,members);rows.push(members);}
  groups.get(row.loginGroup).push(row);
 }
 const rank=r=>r.state==='login_required'?0:r.pending?1:r.state==='unavailable'?2:r.state==='unknown'?3:r.state==='offline'?4:r.stale?5:6;
 return rows.map(item=>{
  if(!Array.isArray(item))return item;
  const enabled=item.filter(r=>r.enabled!==false),members=enabled.length?enabled:item;
  const leader=members.find(r=>r.accountId===r.loginGroup)||members[0];
  const representative=members.reduce((a,b)=>rank(b)<rank(a)?b:a,leader);
  const label=({primary:'主账号',secondary:'备用账号'})[leader.loginGroup]||leader.loginGroup;
  return {...representative,name:'ChatGPT 生图 · '+label,members:item,enabled:!!enabled.length,
   stale:members.some(r=>r.stale),observedAt:Math.min(...members.map(r=>r.observedAt||0)),
   connectionCount:members.length,loginHint:'沿用生图工具的账号登录',
   groupNote:item.length>1?`${item.length} 个浏览器共用此账号；按需展开连接详情。`:''};
 });
}
function isPrimary(row){
 return row.managedBrowser || row.type==='native'&&['claude','codex'].includes(row.provider) || row.provider==='bridge' || row.provider==='images'&&row.enabled!==false;
}
function bindingRows(rows){
 const groups=new Map();
 for(const row of rows){const key=row.uses.join(' / ');if(!groups.has(key))groups.set(key,{name:key,accounts:[]});groups.get(key).accounts.push(row);}
 return [...groups.values()];
}
// Platform grouping is not identity matching: each authorization retains its ID.
function isOpenAI(row){return row.type==='native'&&row.provider==='codex'||['images','bridge','chatgpt-web'].includes(row.provider)||row.managedBrowser&&row.provider==='chatgpt';}
function accountSections(rows){
 const result=[],openai=[];
 for(const row of rows){if(isOpenAI(row)){if(!openai.length)result.push({id:'openai',name:'OpenAI',rows:openai});openai.push(row);}else result.push({id:row.id,rows:[row]});}
 return result;
}
function needsAttention(row){
 return row.enabled!==false&&(row.state==='login_required'||!!row.pending&&!(row.state==='signed_in'&&!row.stale));
}
function accountAction(row){
 if(row.action!=='login')return {action:'config',label:'接入配置',id:row.configProvider};
 if(row.pending)return {action:'attention',label:'继续验证',id:row.id};
 if(row.state==='login_required')return {action:'login',label:'登录账号',id:row.id};
 if(row.type==='web')return {action:'open',label:'打开网页',id:row.id};
 return row.state==='signed_in'&&!row.stale?{action:'select',label:'查看授权',id:row.id}:{action:'login',label:'登录账号',id:row.id};
}
module.exports={accountRows,isPrimary,bindingRows,isOpenAI,accountSections,needsAttention,accountAction};
