'use strict';
// Run with the explicit main subscription's credential copied to an isolated
// home. Raw prompts and outputs are local artifacts; secrets are never logged.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');const {AssistantHistory}=require('../core/hub-assistant/history');const {buildPrompt,auditCitations}=require('../core/hub-assistant/context');
const runLabel=process.argv[2]||'baseline';
if(!/^[a-z0-9-]+$/.test(runLabel))throw new Error('实验目录名无效');
const root=path.resolve(__dirname,'../artifacts/assistant-codex-probe',runLabel);fs.mkdirSync(root,{recursive:true});
const config=JSON.parse(fs.readFileSync(path.join(os.homedir(),'.claude-session-hub/config.json'),'utf8'));
const profiles=config.providers?.codex?.subscription_profiles||[];
const profile=profiles.find(p=>p.label==='主账号');if(!profile)throw new Error('未找到明确标为主账号的 profile');
const profileHome=profile.home||path.join(os.homedir(),'.codex');
const isolatedHome=path.join(root,'private-codex-home');fs.mkdirSync(isolatedHome,{recursive:true});
fs.copyFileSync(path.join(profileHome,'auth.json'),path.join(isolatedHome,'auth.json'));
const history=new AssistantHistory(path.join(os.homedir(),'.claude-session-hub/cache/session-search-v3.sqlite'));
const cases=[
  {id:'recent',question:'最近 24 小时有哪些真正推进？哪些只是助手自述、仍未验收？用白话回答，最多五项。',hours:24},
  {id:'decisions',question:'请从这些近期材料找出我现在需要决定或处理的事情。如果只有建议或信息不足，也说清楚。最多三项。',hours:24},
  {id:'preferences',question:'按照我的偏好，汇报当前 AI Hub 助理这件事真正做到哪一步了，我接下来需要干什么？',query:'助理'},
  {id:'missing',question:'项目「紫晶月球电梯 ZQ-938471」已经完成了吗？告诉我是否能据目前检索得出结论。',query:'紫晶月球电梯 ZQ-938471'},
];
async function run(item){
 const dir=path.join(root,item.id);fs.mkdirSync(dir,{recursive:true});const context=history.context({hours:item.hours||24,query:item.query||'',maxChars:20000});
 const prompt=buildPrompt(item.question,context,[]);fs.writeFileSync(path.join(dir,'request.json'),JSON.stringify({question:item.question,context},null,2));fs.writeFileSync(path.join(dir,'prompt.txt'),prompt);
 const answerFile=path.join(dir,'answer.txt'),stdoutFile=path.join(dir,'events.jsonl');const env={...process.env,CODEX_HOME:isolatedHome};
 for(const key of Object.keys(env))if(key.startsWith('CLAUDE_')||key.startsWith('HUB_')||['OPENAI_API_KEY','CODEX_API_KEY','CLAUDECODE'].includes(key))delete env[key];
 const args=['C:/DevTools/Codex/0.159.3/node_modules/@openai/codex/bin/codex-managed.js','exec','--ignore-user-config','--skip-git-repo-check','--sandbox','read-only','--json','-m','gpt-6-astra','-c','model_reasoning_effort="medium"','-o',answerFile,'-'];
 const started=Date.now();const child=spawn(process.execPath,args,{cwd:dir,env,windowsHide:true,stdio:['pipe','pipe','pipe']});
 const output=fs.createWriteStream(stdoutFile);let stderr='';child.stdout.pipe(output);child.stderr.on('data',d=>{stderr+=d.toString();});child.stdin.end(prompt);
 const timer=setTimeout(()=>child.kill(),240000);const exitCode=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve);});clearTimeout(timer);
 const answer=fs.existsSync(answerFile)?fs.readFileSync(answerFile,'utf8'):'';
 const result={id:item.id,profileId:profile.id,profileLabel:profile.label,model:'gpt-6-astra',effort:'medium',runtime:'isolated codex exec; not Tab PTY E2E',elapsedMs:Date.now()-started,exitCode,answerChars:answer.length,selectedSources:context.sources.length,selectedChars:context.selectedChars,truncated:context.truncated,audit:auditCitations(answer,context),stderrTail:stderr.slice(-1800)};
 fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));return result;
}
(async()=>{const results=[];try{for(const item of cases.filter(item=>!process.argv[3]||process.argv[3].split(',').includes(item.id)))results.push(await run(item));fs.writeFileSync(path.join(root,'results.json'),JSON.stringify(results,null,2));}finally{fs.rmSync(path.join(isolatedHome,'auth.json'),{force:true});}})().catch(error=>{console.error(error.message);process.exitCode=1;});
