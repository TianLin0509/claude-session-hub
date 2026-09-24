'use strict';
// Presentation only: every action keeps its original connection id. Grouping by
// platform is a display convenience, never identity matching — each authorization
// keeps its own state, credentials and login entry.
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
   connectionCount:members.length,loginHint:'沿用生图工具的账号登录',groupLabel:label,
   accountLabel:members.map(r=>r.accountLabel).find(Boolean)||'',
   groupNote:item.length>1?`${item.length} 个浏览器共用此账号`:''};
 });
}
const PLATFORM={
 openai:{name:'ChatGPT / OpenAI',mark:'AI',note:'同一个 ChatGPT 账号可以用于下面几项；各项仍在自己的浏览器或客户端里单独保存登录资料。'},
 anthropic:{name:'Claude',mark:'CL'},
 google:{name:'Gemini',mark:'G'},
 moonshot:{name:'Kimi',mark:'K'},
 deepseek:{name:'DeepSeek',mark:'D'},
 doubao:{name:'豆包',mark:'豆'},
 qwen:{name:'千问',mark:'Q'},
};
const ORDER=['openai','anthropic','google','moonshot','deepseek','doubao','qwen'];
const FEATURE={claude:'Claude Code 客户端',codex:'Codex 客户端',gemini:'Gemini CLI',kimi:'Kimi Code 客户端',
 bridge:'公司拉取 / 同步','chatgpt-web':'Codex Web GPT'};
// An empty key means "not a login account" — API keys and service tokens are listed apart.
function cardKey(row){
 if(row.type==='api'||row.type==='service')return '';
 if(row.provider==='images')return row.loginGroup&&row.loginGroup!=='primary'?'openai#'+row.loginGroup:'openai';
 if(row.type==='native'&&row.provider==='codex')return row.isDefault?'openai':'openai#'+row.id;
 if(['bridge','chatgpt-web','chatgpt'].includes(row.provider))return 'openai';
 if(row.provider==='claude')return 'anthropic';
 if(row.provider==='gemini')return 'google';
 if(row.provider==='kimi')return 'moonshot';
 return row.provider;
}
function featureName(row){
 if(row.type==='api'||row.type==='service')return row.name;
 if(row.provider==='images')return '网页生图';
 if(row.managedBrowser)return '网页对话（专用浏览器）';
 return FEATURE[row.provider]||row.name;
}
// A closed browser still holds the login it was given. Beyond a week we stop vouching for it,
// because web sessions do expire and a stale promise is worse than an honest "unknown".
const REST_TTL=7*24*60*60*1000;
function resting(row,now=Date.now()){return row.state==='offline'&&!!row.signedInAt&&now-row.signedInAt<REST_TTL;}
function confirmed(row,now=Date.now()){return row.state==='signed_in'&&!row.stale||resting(row,now);}
function needsAttention(row){
 return row.enabled!==false&&(row.webRecovery?.some(t=>t.canResume)||row.state==='login_required'||!!row.pending&&!confirmed(row));
}
const STATE={login_required:'需要登录',configured:'已配置',unknown:'尚未确认',unavailable:'工具不可用',opening:'等待验证'};
function ago(at,now=Date.now()){
 if(!at)return '';
 const minutes=Math.floor((now-at)/60000);
 if(minutes<1)return '刚刚';
 if(minutes<60)return minutes+' 分钟前';
 if(minutes<1440)return Math.floor(minutes/60)+' 小时前';
 return Math.floor(minutes/1440)+' 天前';
}
// tone: ok = proved just now, rest = proved earlier and nothing has contradicted it,
// warn = needs you, idle = we genuinely do not know.
function describe(row,now=Date.now()){
 if(row.enabled===false)return {tone:'idle',text:'已停用'};
 if(row.webRecovery?.length)return {tone:'warn',text:row.webRecovery.length+' 项网页任务等登录后继续'};
 if(row.pending)return row.state==='offline'
  ?{tone:'warn',text:'登录窗口已关闭，未确认登录'}
  :{tone:'warn',text:'登录窗口已打开，完成后自动确认'};
 if(row.state==='offline')return row.signedInAt
  ?{tone:resting(row,now)?'rest':'idle',text:`已登录 · 浏览器已关闭（${ago(row.signedInAt,now)}确认）`}
  :{tone:'idle',text:'浏览器未开，登录状态未知'};
 if(row.state==='signed_in')return {tone:row.stale?'rest':'ok',text:'已登录 · '+ago(row.observedAt,now)+'确认'};
 if(row.state==='configured')return {tone:'ok',text:'已配置'};
 if(row.state==='login_required')return {tone:'warn',text:'需要登录'};
 return {tone:'idle',text:(STATE[row.state]||'尚未确认')+(row.observedAt?' · '+ago(row.observedAt,now)+'检查':'')};
}
function featureAction(row){
 if(row.action!=='login')return {action:'config',label:'配置',id:row.configProvider};
 if(row.pending)return {action:'relogin',label:'重新打开',id:row.id};
 // A login restored outside the Hub still needs one deliberate click to continue its tasks.
 if(confirmed(row)&&row.webRecovery?.some(t=>t.canResume))return {action:'resume',label:'继续任务',id:row.id};
 if(confirmed(row))return row.type==='web'?{action:'open',label:'打开',id:row.id}:{action:'relogin',label:'重新登录',id:row.id};
 return {action:'login',label:'登录',id:row.id};
}
// The card button fans out to each real connection id; it never invents a group id.
function cardAction(card){
 const open=card.features.filter(r=>r.action==='login'&&r.enabled!==false);
 const missing=open.filter(r=>!confirmed(r));
 return missing.length
  ?{label:missing.length>1?`登录（${missing.length} 项）`:'登录',ids:missing.map(r=>r.id),primary:true}
  :{label:'重新登录',ids:open.map(r=>r.id),primary:false};
}
// One platform card can legitimately hold two different accounts (a Codex client on one
// login, the image pool and the company bridge on another). Say so rather than picking one.
function accountsOf(features){return [...new Set(features.map(r=>r.accountLabel).filter(Boolean))];}
function accountSummary(features){
 const names=accountsOf(features);
 if(!names.length)return '';
 return names.length===1?names[0]:`${names.length} 个账号 · ${names.join(' / ')}`;
}
function accountCards(rows){
 const map=new Map(),others=[];
 for(const row of rows){
  const key=cardKey(row);
  if(!key){others.push(row);continue;}
  if(!map.has(key))map.set(key,{key,platform:key.split('#')[0],features:[]});
  map.get(key).features.push(row);
 }
 const cards=[...map.values()].map(card=>{
  const base=PLATFORM[card.platform]||{name:card.features[0].name,mark:'·'},alt=card.key.includes('#');
  const lead=card.features[0],active=card.features.filter(r=>r.enabled!==false);
  return {...card,alt,mark:base.mark,note:alt?'':base.note||'',
   name:alt?(lead.provider==='images'?'ChatGPT 生图 · '+(lead.groupLabel||lead.loginGroup):lead.name):base.name,
   identity:accountSummary(card.features),accounts:accountsOf(card.features),
   total:active.length,signedIn:active.filter(r=>confirmed(r)).length,attention:active.filter(needsAttention).length};
 });
 const weight=c=>{const i=ORDER.indexOf(c.platform);return (i<0?ORDER.length:i)*2+(c.alt?1:0);};
 return {cards:cards.sort((a,b)=>weight(a)-weight(b)),others};
}
module.exports={accountRows,accountCards,accountsOf,accountSummary,cardKey,featureName,featureAction,cardAction,needsAttention,describe,ago,confirmed,resting,PLATFORM};
