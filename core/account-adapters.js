'use strict';
const fs=require('fs'),path=require('path'),os=require('os');
const {execFile,spawn}=require('child_process');
const {AccountBrowser}=require('./account-browser');
function run(command,args,env,timeout=15000){return new Promise((resolve,reject)=>execFile(command,args,{env,windowsHide:true,timeout,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{
 if(error&&(!Number.isInteger(error.code)||error.killed))return reject(error);
 resolve({code:error?.code||0,stdout,stderr});
}));}
function jsonResult(result){const lines=String(result.stdout).trim().split('\n');for(let i=lines.length-1;i>=0;i--){try{const v=JSON.parse(lines[i]);if(result.code||v.ok===false)throw Error('工具返回失败');return v;}catch(e){if(e.message==='工具返回失败')throw e;}}try{const v=JSON.parse(result.stdout);if(result.code||v.ok===false)throw Error('工具返回失败');return v;}catch{throw Error('未收到有效工具状态');}}
function quotePS(s){return "'"+String(s).replace(/'/g,"''")+"'";}
function openTerminal(command,args,env){
 // Fixed argv, quoted as PowerShell literals; no credential values in the command.
 const text='& '+[command,...args].map(quotePS).join(' ')+'; Write-Host "完成登录后返回 AI Hub，点击检查登录。"';
 return new Promise((resolve,reject)=>{const p=spawn('powershell.exe',['-NoLogo','-NoProfile','-NoExit','-EncodedCommand',Buffer.from(text,'utf16le').toString('base64')],{env,windowsHide:false,detached:true,stdio:'ignore'});p.once('error',reject);p.once('spawn',()=>{p.unref();resolve({});});});
}
function createAccountAdapters({dataDir,homeDir=os.homedir(),env=process.env,runImpl=run,terminal=openTerminal,browser=new AccountBrowser({dataDir,env}),getConfig=()=>require('./hub-config').getConfig()}={}){
 const isolated=!!env.CLAUDE_HUB_HOME_DIR;const py=path.join(env.LOCALAPPDATA||'','Programs/Python/Python312/python.exe');
 if(isolated && env.CLAUDE_HUB_ACCOUNT_FIXTURE){
  const fixture=env.CLAUDE_HUB_ACCOUNT_FIXTURE;
  const invoke=async(action,row={})=>jsonResult(await runImpl(process.execPath,[fixture,action,JSON.stringify({id:row.id,provider:row.provider,type:row.type})],{...env,ELECTRON_RUN_AS_NODE:'1'},5000));
  return {imageAccounts:async()=>(await invoke('images')).accounts,check:row=>invoke('check',row),login:row=>invoke('login',row)};
 }
 const python=fs.existsSync(py)?py:'python';
 const toolsRoot=path.join(homeDir,'plugins/chatgpt-web-images/scripts');
 const bridgeRoot=path.join(homeDir,'tools/chatgpt_bridge');
 const cleanEnv={...env,PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'};
 for(const key of ['CLAUDECODE','ANTHROPIC_API_KEY','ANTHROPIC_AUTH_TOKEN','ANTHROPIC_BASE_URL','OPENAI_API_KEY','OPENAI_BASE_URL','CODEX_API_KEY'])delete cleanEnv[key];
 function external(){if(isolated)throw Error('隔离 Hub 不访问真实工具账号');}
 function cliEnv(row){const e={...cleanEnv};if(isolated&&row.home){const rel=path.relative(homeDir,path.resolve(row.home));if(rel.startsWith('..')||path.isAbsolute(rel))throw Error('隔离账号路径超出测试 home');}if(row.provider==='codex')e.CODEX_HOME=path.resolve(row.home);if(row.provider==='claude')e.CLAUDE_CONFIG_DIR=row.home;if(row.provider==='kimi')e.KIMI_CODE_HOME=row.home;if(isolated){e.HOME=homeDir;e.USERPROFILE=homeDir;e.BAILIAN_CONFIG_DIR=path.join(homeDir,'.bailian');}return e;}
 async function tool(tool,action,accountId){external();const root=tool==='images'?toolsRoot:bridgeRoot;if(!fs.existsSync(root))throw Error('原工具未安装');return jsonResult(await runImpl(python,[path.resolve(__dirname,'../scripts/account-tool-adapter.py'),tool,action,root,...(accountId?[accountId]:[])],cleanEnv,45000));}
 const imageAccounts=async()=>{
  const data=await tool('images','status');return (data.accounts||[]).map(a=>({id:a.id,enabled:!!a.enabled,workerAlive:Date.now()/1000-a.heartbeat<20,
   state:/login_required|credential_required|account_selection_required/.test(a.state)?'login_required':a.login_confirmed?'signed_in':'unknown',
   observedAt:a.checked_at*1000||0,message:a.control_pending?'原工具正在处理账号操作，请稍后检查':a.enabled?'原工具账号记录；额度与排队单独判断':'账号在原工具已停用'}));
 };
 return {imageAccounts,
 async check(row){
  if(row.managedBrowser)return browser.check(row.provider);
  if(row.action==='configure')return {state:row.configured?'configured':'unknown',message:row.configured?'密钥已配置；有效性和余额通过原服务入口验证':'尚未配置密钥',source:'本机配置'};
  if(row.provider==='images'){await tool('images','check',row.accountId);return {state:'unknown',message:'已在生图共享队列提交登录检查，请稍后刷新；未重新提交图片任务',source:'生图共享队列'};}
  if(row.provider==='bridge'){const v=await tool('bridge','check');return {state:v.logged_in?'signed_in':v.login_required?'login_required':'unknown',message:v.logged_in?'中转官方页面已确认登录；未读取或推进拉取游标':'请在原中转窗口完成验证',source:'中转浏览器'};}
  if(row.provider==='chatgpt-web'){external();const v=await require('./chatgpt-web-integration').webStatus();return {state:v.connected?'configured':'offline',message:v.connected?'原工具服务在线；网页登录须在原工具确认':v.message,source:'Codex Web GPT 服务健康，不是登录证明'};}
  if(row.provider==='claude'){
   const r=await runImpl('claude.exe',['auth','status','--json'],cliEnv(row));let v;try{v=JSON.parse(r.stdout);}catch{throw Error('Claude 状态无效');}
   if(typeof v.loggedIn!=='boolean'||(r.code!==0&&v.loggedIn))throw Error('Claude 状态缺少登录证据');
   return {state:v.loggedIn?'signed_in':'login_required',identity:v.email,message:v.loggedIn?'Claude 官方 CLI 已确认本机登录；会话仍保留启动身份':'Claude 官方 CLI 报告尚未登录',source:'claude auth status'};
  }
  if(row.provider==='codex'){
   const e=cliEnv(row),cmd=require('../main/codex-windows-command').resolveWindowsCodex(e);
   const r=await runImpl(cmd.command,[...cmd.args,'login','status'],cmd.env);const text=r.stdout+'\n'+r.stderr;
   if(r.code===0&&/logged in/i.test(text)&&!/not logged in/i.test(text))return {state:'signed_in',identity:require('./codex-usage-scope').readCodexAuthInfo(row.home).accountEmail,message:'Codex 官方 CLI 已确认本机登录；网页 ChatGPT 另行管理',source:'codex login status'};
   if(/not logged in/i.test(text))return {state:'login_required',message:'Codex 官方 CLI 报告尚未登录',source:'codex login status'};
   throw Error('Codex 状态未确认');
  }
  if(row.provider==='kimi'){
   if(!fs.existsSync(path.join(row.home,'credentials','kimi-code.json')))return {state:'login_required',message:'未找到 Kimi 登录凭据，请登录',source:'Kimi 凭据发现'};
   const usage=await require('../main/usage/kimi-account-usage').readKimiAccountUsage({home:row.home,env:cliEnv(row)});
   return {state:usage?'signed_in':'unknown',message:'Kimi 官方用量接口有响应；具体额度仍在侧栏展示',source:'Kimi 用量接口'};
  }
  if(row.provider==='gemini'){
   const present=fs.existsSync(path.join(row.home,'oauth_creds.json'));
   return {state:present?'configured':'unknown',message:present?'发现 Gemini CLI 登录记录；有效性需在官方 CLI 确认':'未发现 OAuth 登录记录；如使用其他方式，请在官方 CLI 确认',source:'Gemini 本地记录，不是有效性证明'};
  }
  if(row.provider==='token-plan'){
   const svc=require('../main/usage/token-plan-usage').createTokenPlanUsageService({env:cliEnv(row),...(isolated?{configDir:path.join(homeDir,'.bailian')}:{})});
   await svc.refresh(true);return {state:'signed_in',message:'百炼官方用量接口已返回计划数据',source:'百炼 CLI 用量接口'};
  }
  if(row.provider==='feishu'){
   external();const command=getConfig().notifications?.feishuCliPath||require('./completion-notifier').resolveDefaultFeishuCliPath(cleanEnv);
   const value=jsonResult(await runImpl(command,['auth','status','--json'],cleanEnv));const user=value.identities?.user,bot=value.identities?.bot;
   return {state:user?.available===true?'signed_in':user?.available===false?'login_required':'unknown',message:'这是 CLI 用户授权。回答通知使用独立机器人身份：'+(bot?.available===true?'已配置，投递结果以通知测试为准':'未确认，请在原 CLI 配置机器人'),source:'飞书 CLI 本机身份状态'};
  }
  return {state:'unknown',message:'此工具未提供已适配的只读登录检测；可直接打开官方登录入口',source:'官方工具'};
 },
 async login(row){
  if(row.managedBrowser)return browser.open(row.provider);
  if(row.provider==='bridge'){await tool('bridge','login');return {message:'已打开原中转浏览器，完成登录后检查；未推进拉取记录'};}
  if(row.provider==='images'){await tool('images','open',row.accountId);return {message:'已交给生图共享队列打开原账号浏览器；当前图片任务不会重发'};}
  if(row.provider==='chatgpt-web'){external();return require('./chatgpt-web-integration').openWebSettings();}
  let e=cliEnv(row),command,args;
  if(row.provider==='codex'){const cmd=require('../main/codex-windows-command').resolveWindowsCodex(e);command=cmd.command;args=[...cmd.args,'login'];e=cmd.env;}
  else if(row.provider==='claude'){command='claude.exe';args=['auth','login'];}
  else if(row.provider==='kimi'){command='kimi.exe';args=['login'];}
  else if(row.provider==='gemini'){command='gemini';args=[];}
  else if(row.provider==='token-plan'){command='bl';args=['auth','login','--console'];}
  else if(row.provider==='feishu'){external();command=getConfig().notifications?.feishuCliPath||require('./completion-notifier').resolveDefaultFeishuCliPath(e);args=['auth','login'];}
  else throw Error('此连接没有登录入口');
  if(!path.isAbsolute(command)){
   const found=await runImpl('where.exe',[command],e,5000);
   if(found.code!==0)throw Error('未找到 '+command+'，请先安装官方 CLI');
  }
  return terminal(command,args,e);
 }};
}
module.exports={createAccountAdapters,quotePS,jsonResult,run,openTerminal};
