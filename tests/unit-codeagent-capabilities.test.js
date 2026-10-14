'use strict';
// 公司版「资源」页（能力中心）盘点 CodeAgent 的技能、MCP、插件（2026-10-14 用户反馈全是 0）。
// 目录结构照 2026-10-13 公司真机探测：<配置目录>/skills、.cac.json 顶层 mcpServers 与 projects[cwd].mcpServers、
// settings.json 的 enabledPlugins、<配置目录>/plugins 下的插件；项目里的 .mcp.json 与 .cac/skills。
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {collectCapabilities}=require('../core/capability-catalog');
const {isActive,coverage}=require('../core/capability-view-model');

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'capability-codeagent-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const write=(rel,s)=>{const p=path.join(root,rel);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,typeof s==='string'?s:JSON.stringify(s));return p;};
  return {root,write};
}

test('CodeAgent 的技能、MCP、插件都盘点出来，并只算在 CodeAgent 名下', t=>{
  const {root,write}=fixture(t);
  const cwd=path.join(root,'work','proj');
  write('.cac/skills/weekly-report/SKILL.md','---\nname: weekly-report\ndescription: 写周报。\n---\n');
  write('.cac/skills/aimarket/code-review/SKILL.md','---\nname: code-review\ndescription: 审查代码。\n---\n');
  write('.cac/.cac.json',{numStartups:3,userID:'PRIVATE_USER',mcpServers:{
    'codeagent-mcp':{type:'stdio',command:'python',args:['-m','codeagent_mcp.server'],env:{TOKEN:'PRIVATE_TOKEN'}},
    'w3-search':{type:'http',url:'http://intranet.example/remote-mcp/mcp/w3_search_tool',headers:{Authorization:'PRIVATE_BEARER'}},
  },projects:{[cwd.replace(/\\/g,'/')]:{hasTrustDialogAccepted:true,mcpServers:{'project-db':{command:'db-mcp'}}}}});
  write('.cac/settings.json',{model:'GLM-5.2-WX-Auto',enabledPlugins:{'codebase-win@aimarket':true,'old-tool@aimarket':false}});
  const plugin='.cac/plugins/cache/aimarket/codebase-win/1.0.5';
  write(plugin+'/.claude-plugin/plugin.json',{name:'codebase-win',description:'代码库检索'});
  write(plugin+'/.mcp.json',{'codebase-mcp':{command:'node',args:['index.js']}});
  write('work/proj/.mcp.json',{mcpServers:{'proj-local':{command:'local-mcp'}}});
  write('work/proj/.cac/skills/proj-skill/SKILL.md','---\nname: proj-skill\ndescription: 项目专用。\n---\n');
  // Claude 的配置不该算到 CodeAgent 头上
  write('.claude/skills/claude-only/SKILL.md','---\nname: claude-only\ndescription: x\n---\n');

  const catalog=collectCapabilities({homeDir:root,dataDir:root,projects:[{cwd,kind:'codeagent'}]});
  const of=agent=>catalog.rows.filter(r=>r.agents.includes(agent));
  const names=type=>of('codeagent').filter(r=>r.type===type).map(r=>r.name).sort();
  assert.deepEqual(names('skill'),['code-review','proj-skill','weekly-report']);
  assert.deepEqual(names('mcp'),['codeagent-mcp','codebase-mcp','proj-local','project-db','w3-search']);
  assert.deepEqual(names('plugin'),['codebase-win@aimarket','old-tool@aimarket']);
  assert.ok(!of('codeagent').some(r=>r.name==='claude-only'));

  const row=name=>catalog.rows.find(r=>r.name===name);
  assert.equal(row('w3-search').sources[0].transport,'http');
  assert.equal(row('codebase-win@aimarket').description,'代码库检索');
  assert.equal(row('codebase-mcp').sources[0].plugin,'codebase-win@aimarket','插件带的 MCP 记在插件名下');
  assert.equal(coverage(row('weekly-report'),'codeagent').label,'独立入口');
  // 顶部计数只算启用的：停用的插件不计
  const active=catalog.rows.filter(isActive);
  assert.equal(active.filter(r=>r.type==='plugin').length,1);
  assert.equal(active.filter(r=>r.type==='mcp').length,5);
  assert.equal(active.filter(r=>r.type==='skill').length,4,'3 个 CodeAgent 技能 + 1 个 Claude 技能');
  // 只带名字和连接方式，不带命令参数、环境变量、请求头、用户信息
  assert.doesNotMatch(JSON.stringify(catalog),/PRIVATE_|codeagent_mcp\.server|intranet\.example/);
});

test('插件只在开关里、没找到下载目录时照样列出且算启用；安装记录指向不存在的目录才标待核对', t=>{
  const {root,write}=fixture(t);
  write('.cac/settings.json',{enabledPlugins:{'dtagent@aimarket':true,'gone@aimarket':true}});
  write('.cac/plugins/installed_plugins.json',{plugins:{'gone@aimarket':[{scope:'user',installPath:path.join(root,'nowhere'),version:'1.0.0'}]}});
  const rows=collectCapabilities({homeDir:root,dataDir:root}).rows;
  const dtagent=rows.find(r=>r.name==='dtagent@aimarket'), gone=rows.find(r=>r.name==='gone@aimarket');
  assert.ok(isActive(dtagent));assert.equal(dtagent.description,'CodeAgent 插件');
  assert.ok(!isActive(gone));assert.equal(coverage(gone,'codeagent').label,'待核对安装');
});

test('没有 .cac 目录（没装 CodeAgent）时不报警告、不出 CodeAgent 条目', t=>{
  const {root}=fixture(t);
  const catalog=collectCapabilities({homeDir:root,dataDir:root,projects:[{cwd:root,kind:'codeagent'}]});
  assert.equal(catalog.rows.length,0);
  assert.deepEqual(catalog.warnings,[]);
});

test('指定的 CodeAgent 配置目录优先于 home 下的 .cac', t=>{
  const {root,write}=fixture(t);
  write('custom-cac/.cac.json',{mcpServers:{'from-custom':{command:'x'}}});
  write('.cac/.cac.json',{mcpServers:{'from-home':{command:'x'}}});
  const names=collectCapabilities({homeDir:root,dataDir:root,codeagentConfigDir:path.join(root,'custom-cac')}).rows.map(r=>r.name);
  assert.deepEqual(names,['from-custom']);
});
