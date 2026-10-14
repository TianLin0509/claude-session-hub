'use strict';
// 真实验收：公司版「资源」页（能力中心）能看到 CodeAgent 的技能、MCP、插件（2026-10-14 用户反馈全是 0）。
//   ① 隔离 home 里按公司真机的结构放一份 .cac：技能、.cac.json 顶层 MCP、enabledPlugins + 插件目录；
//   ② 点左侧栏「资源」，顶部三个数字不再是 0，列表里有这些条目；
//   ③ 点一个 MCP，详情的「AI 覆盖」写着 CodeAgent。
// E2E_ENTRY 指向公司版导出目录（目录里要有指向生产依赖的 node_modules 链接）；不设则跑主干。
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),net=require('node:net'),assert=require('node:assert/strict');
const {launchIsolatedHub,gracefulQuit}=require('./helpers/hub-launcher');
const {connectFirstPage}=require('./helpers/cdp-client');
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const j=JSON.stringify;
const freePort=()=>new Promise(r=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>r(p));});});

async function main(){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-ca-capability-')),home=path.join(root,'home'),data=path.join(root,'data'),empty=path.join(root,'empty');
  const out=path.resolve(process.env.E2E_OUT||'artifacts/20261014-codeagent-capabilities-claude3');
  for(const p of [home,data,empty,out])fs.mkdirSync(p,{recursive:true});
  const write=(rel,s)=>{const p=path.join(home,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof s==='string'?s:j(s),'utf8');};
  const cac=path.join(home,'.cac');
  write('.cac/skills/weekly-report/SKILL.md','---\nname: weekly-report\ndescription: 按团队模板写周报。\n---\n');
  write('.cac/skills/aimarket/code-review/SKILL.md','---\nname: code-review\ndescription: 审查代码改动并指出风险。\n---\n');
  write('.cac/.cac.json',{mcpServers:{'codeagent-mcp':{type:'stdio',command:'unused'},'w3-search':{type:'http',url:'http://127.0.0.1:9/mcp'}}});
  write('.cac/settings.json',{enabledPlugins:{'codebase-win@aimarket':true}});
  write('.cac/plugins/cache/aimarket/codebase-win/1.0.5/.claude-plugin/plugin.json',{name:'codebase-win',description:'代码库检索'});
  write('.cac/plugins/cache/aimarket/codebase-win/1.0.5/.mcp.json',{'codebase-mcp':{command:'unused'}});
  const result={company:!!process.env.E2E_ENTRY,checks:[],passed:false};let hub,cdp;
  const until=async(expr,label,ms=30000)=>{const end=Date.now()+ms;while(Date.now()<end){try{if(await cdp.eval(`Boolean(${expr})`))return;}catch{}await pause(150);}throw Error('timeout: '+label);};
  const click=async selector=>{
    await until(`document.querySelector(${j(selector)})`,'present '+selector);
    const p=await cdp.eval(`(()=>{const el=document.querySelector(${j(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    for(const type of ['mousePressed','mouseReleased'])await cdp.send('Input.dispatchMouseEvent',{type,button:'left',clickCount:1,...p});
    await pause(300);
  };
  const shot=async name=>{const s=await cdp.send('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(s.data,'base64'));};
  const check=(ok,label)=>{assert.ok(ok,label);result.checks.push(label);console.log('  ✓ '+label);};
  try{
    hub=await launchIsolatedHub({dataDir:data,port:await freePort(),windowMode:'hidden',label:'codeagent capabilities',
      ...(process.env.E2E_ENTRY?{entryPath:process.env.E2E_ENTRY}:{}),extraEnv:{
        CLAUDE_HUB_E2E:'1',CLAUDE_HUB_HOME_DIR:home,AI_HUB_CODEAGENT_CONFIG_DIR:cac,AI_HUB_WORKSPACE_ROOT:root,
        CODEX_HOME:path.join(home,'.codex'),CLAUDE_CONFIG_DIR:path.join(home,'.claude'),
        HUB_SESSION_SEARCH_CODEX_ROOTS:empty,HUB_SESSION_SEARCH_CLAUDE_ROOTS:empty,HUB_SESSION_SEARCH_KIMI_ROOTS:empty,HUB_SESSION_SEARCH_GEMINI_ROOTS:empty,
        AI_HUB_RULES_BASE_URL:'http://127.0.0.1:9/hub-rules/',
        AI_HUB_UPDATE_SOURCES:j([{id:'x',name:'x',manifest:'http://127.0.0.1:9/x.json',files:'http://127.0.0.1:9/'}])}});
    cdp=await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:950,deviceScaleFactor:1,mobile:false});
    await until('typeof ipcRenderer!=="undefined" && typeof sessions!=="undefined"','renderer ready',60000);
    result.product=await cdp.eval(`document.querySelector('#hub-identity strong')?.textContent || ''`);
    await cdp.send('Input.dispatchMouseEvent',{type:'mouseMoved',x:5,y:250});await pause(350);
    await click('#btn-rail-capabilities');
    await until('document.querySelectorAll("#capability-page .cp-row").length>=6','catalog rows');
    const stat=t=>cdp.eval(`(document.querySelector(".cp-stat[data-cp-type=${t}]")?.innerText||"").replace(/\\s+/g," ")`);
    const stats={skill:await stat('skill'),mcp:await stat('mcp'),plugin:await stat('plugin')};result.stats=stats;
    const first=s=>Number((s.match(/\d+/)||[])[0]);
    check(first(stats.skill)===2&&first(stats.mcp)===3&&first(stats.plugin)===1,`顶部数字：技能 ${first(stats.skill)}、MCP ${first(stats.mcp)}、插件 ${first(stats.plugin)}（不再是 0）`);
    const list=await cdp.eval('document.querySelector(".cp-list").innerText');
    check(['weekly-report','code-review','w3-search','codeagent-mcp','codebase-mcp','codebase-win'].every(n=>list.includes(n)),'列表里有 CodeAgent 的技能、MCP 和插件');
    await shot('01-capabilities');
    await click('[data-cp-row="mcp:w3-search"]');
    await until('document.querySelector(".cp-detail h2")?.innerText.includes("w3-search")','mcp detail');
    const chips=await cdp.eval('document.querySelector(".cp-detail .cp-chips")?.innerText||""');
    check(/CodeAgent/.test(chips),`MCP 详情的「AI 覆盖」写明 CodeAgent（${chips.replace(/\s+/g,' ').trim()}）`);
    await shot('02-mcp-detail');
    await click('[data-cp-row="plugin:codebase-win@aimarket"]');
    await until('document.querySelector(".cp-detail .cp-components")','plugin components');
    check((await cdp.eval('document.querySelector(".cp-detail .cp-components").innerText')).includes('codebase-mcp'),'插件详情列出它带的 MCP（codebase-mcp）');
    await shot('03-plugin-detail');
    result.passed=true;
  }finally{
    fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(result,null,2));
    if(!result.passed&&cdp){try{await shot('99-failure');}catch{}}
    try{cdp?.close();}catch{}
    if(hub)await gracefulQuit(hub).catch(()=>{});
    try{fs.rmSync(root,{recursive:true,force:true});}catch{}
  }
}
main().then(()=>console.log('PASS e2e-codeagent-capabilities-cdp'),error=>{console.error(error);process.exit(1);});
