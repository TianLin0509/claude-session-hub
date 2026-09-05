'use strict';
// Exercise the actual renderer template. Keep the old regression intent (all
// authored evidence is visible), without pinning the old poll-and-shell design.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../renderer/ran.js'),'utf8');
const context={window:{},document:{readyState:'loading',addEventListener(){}},require:name=>{assert.equal(name,'electron');return {ipcRenderer:{on(){}}};},console,setTimeout,clearTimeout};
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
const escaped=render({...row,title:'<img src=x onerror=boom()>',progress:'<script>boom()</script>'});
assert(!escaped.includes('<script>'));assert(escaped.includes('&lt;img'));
const missing=render({id:'task-2',stage:{},actions:{}});
assert(!missing.includes('data-devb-action="report"'));
assert(missing.includes('尚未收到进展汇报'),'Missing reports are distinguishable from completed work');
console.log('dev-board render: PASS (evidence, navigation, failure visibility, escaping, push-only data)');
