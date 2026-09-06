'use strict';
// Exercise the actual renderer template. Keep the old regression intent (all
// authored evidence is visible), without pinning the old poll-and-shell design.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer/ran.js'),'utf8');
const context={window:{},localStorage:{getItem:()=>null},document:{readyState:'loading',addEventListener(){}},require:name=>{if(name==='./dev-workbench-model')return require('../renderer/dev-workbench-model');assert.equal(name,'electron');return {ipcRenderer:{on(){}}};},console,setTimeout,clearTimeout};
vm.runInNewContext(source.replace(/\}\)\(\);\s*$/,'window.__renderTask = rowHtml;})();'),context);
const render=context.window.__renderTask;
const row={id:'task-1',title:'示例开发任务',stage:{label:'工作位实现中',tone:'run'},progress:'干了活',card:{progress:'干了活',verified:'跑了 7 条',risk:'有点风险',report:'C:\\a.html'},review:{decision:'fail',blockers:'需要补测',verified:'独立验证 3 项'},blockers:'需要补测',report:'C:\\a.html',actions:{takeover:true}};
const html=render(row);
for(const expected of ['干了活','跑了 7 条','有点风险','需要补测','独立验证 3 项','查看报告','进入群聊','手动接管'])assert(html.includes(expected),expected+' must be visible');
assert(html.includes('data-devb-action="report"'));
assert(source.includes('window.openPathInHub(reportPath'),'Reports reuse Hub preview routing after checking the selected file');
assert(source.includes('报告打不开'),'Preview errors must remain visible per task');
assert(!source.includes("invoke('groupchat:get-state'"),'Dashboard must not fetch per-group transcripts');
assert(!source.includes('setInterval('),'Dashboard must not poll');
assert(source.includes("ipcRenderer.on('dev-workbench:changed'"),'Dashboard subscribes to published summaries');
// 人话通道（2026-09-06）：需要维护者出手的事必须自己占一行，方案/纪事/交付说明进详情。
// 阻断项在没有 attention 的行上仍要可见 —— 少一层兜底，证据就会静默消失。
const attentive=render({...row,attention:{kind:'ask',label:'需要你拍板',text:'手机推送要不要现在做？'},
  plan:'先改解析器，再接工作台',card:{...row.card,notes:'没做手机推送，那一项独立'},
  chronicle:[{kind:'plan',text:'先改解析器，再接工作台',speaker:'Claude 1',at:Date.now()},
             {kind:'update',text:'解析器改完了',speaker:'Claude 1',at:Date.now()}]});
for(const expected of ['需要你拍板','手机推送要不要现在做？','任务纪事','先改解析器','解析器改完了','没做手机推送'])
  assert(attentive.includes(expected),'人话通道内容必须可见：'+expected);
assert(!render({...row,attention:null}).includes('devb-attention'),'没有需要处理的事就不占位');
const escaped=render({...row,title:'<img src=x onerror=boom()>',progress:'<script>boom()</script>'});
assert(!escaped.includes('<script>'));assert(escaped.includes('&lt;img'));
const missing=render({id:'task-2',stage:{},actions:{}});
assert(!missing.includes('data-devb-action="report"'));
assert(missing.includes('尚未收到进展汇报'),'Missing reports are distinguishable from completed work');
console.log('dev-board render: PASS (evidence, navigation, failure visibility, escaping, push-only data)');
