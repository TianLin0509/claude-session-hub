'use strict';
// Read-only inventory. No recursive home scan, deletion, or rule replacement.
const fs=require('node:fs'),path=require('node:path');
const {collectCatalog}=require('../core/hub-memory-catalog');
const args={};for(let i=2;i<process.argv.length;i+=2)args[process.argv[i]]=process.argv[i+1];
for(const key of ['--data-dir','--home','--workspace-root','--out'])if(!args[key])throw new Error('Required: '+key);
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
const data=path.resolve(args['--data-dir']),state=read(path.join(data,'state.json'),{}),registry=read(path.join(data,'workspaces.json'),{});
const catalog=collectCatalog({homeDir:path.resolve(args['--home']),workspaceRoot:path.resolve(args['--workspace-root']),
 memoryRoot:path.join(data,'memory'),sessions:state.sessions||[],workspaces:registry.workspaces||[]});
const rules=catalog.files.filter(f=>f.rule),counts={};for(const f of rules)counts[f.rule.state]=(counts[f.rule.state]||0)+1;
const report={generatedAt:new Date().toISOString(),boundary:'只读已知会话和注册工作区。unchanged 表示自复制后未改，不代表现在可安全删除；须先验证替代规则路径。',counts,
 globalRules:catalog.globalRules,globalRulesAligned:catalog.globalRulesAligned,rules,warnings:catalog.warnings};
const out=path.resolve(args['--out']);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'inventory.json'),JSON.stringify(report,null,2),'utf8');
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
fs.writeFileSync(path.join(out,'index.html'),`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>AI Hub 规则盘点</title><style>body{font:16px/1.6 system-ui;max-width:1400px;margin:40px auto;padding:20px;color:#243141}td,th{padding:12px;border-bottom:1px solid #ddd;text-align:left;overflow-wrap:anywhere}table{width:100%;table-layout:fixed}code{background:#eee}summary{cursor:pointer}h1{font-size:28px}</style><h1>AI Hub 规则文件盘点</h1><p>${esc(report.boundary)}</p><p>${esc(JSON.stringify(counts))} · 全局规则${report.globalRulesAligned?'一致':'存在差异或缺失'}</p><p>新临时会话不再复制规则或自动建 Git；需要补充的共享规则随实际提交发送并留回执。旧文件保留，未改副本在文件库默认折叠。原生记忆与 Hub 梦境继续独立。</p>${['owned','unchanged','modified','unknown'].map(state=>`<details ${state==='modified'||state==='unknown'?'open':''}><summary>${esc(state)} · ${counts[state]||0}</summary><table><tr><th>文件</th><th>来源</th><th>判断</th></tr>${rules.filter(f=>f.rule.state===state).map(f=>`<tr><td>${esc(f.path)}</td><td>${esc(f.rule.source)}</td><td>${esc(f.rule.note)}</td></tr>`).join('')}</table></details>`).join('')}<h2>读取问题</h2><pre>${esc(report.warnings.join('\n')||'无')}</pre></html>`,'utf8');
console.log(JSON.stringify({out,counts,warnings:report.warnings.length,globalRulesAligned:report.globalRulesAligned}));
