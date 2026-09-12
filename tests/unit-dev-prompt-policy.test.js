'use strict';
const assert=require('node:assert/strict');
const F=require('../core/dev-file-workflow');
const V=require('../renderer/conversation-message-view');
const path=require('node:path');
const meeting={groupChat:true,scene:'dev',workspace:'PROJECT',slotSpecs:[{memberId:'qa'},{memberId:'writer'}],serialWorkflow:{fileFlowVersion:2,steps:[['writer'],['qa']]}};
const members=[{memberId:'qa',displayName:'Claude 审查'},{memberId:'writer',displayName:'Kimi 开发'}];
assert(F.common(meeting,'TASK',members).includes('Kimi 开发 负责开题与实现，Claude 审查 负责独立验证与合并'));
assert(!/第一席位|第二席位|codex ?[12]/i.test(F.common(meeting,'TASK',members)));
for(const phase of ['kickoff','build','merge']) {
  const spec=F.spec(phase,phase==='kickoff'?0:1),prompt=F.phasePrompt(meeting,'TASK',spec,members);
  assert(prompt.includes(path.join('TASK',spec.draft)) && prompt.includes(path.join('TASK',spec.completed)));
  assert(prompt.includes('原子改名') && prompt.includes('目标存在、草稿消失'));
  assert(prompt.includes('大白话') && prompt.includes('HTML'));
  assert(!prompt.includes('## AI HUB 文件工作流'),'phase must not embed the common protocol again');
}
const key=F.protocolKey(meeting,members);members[1].displayName='Renamed 开发';
assert.notEqual(F.protocolKey(meeting,members),key);assert(F.phasePrompt(meeting,'TASK',F.spec('build',2),members).includes('Renamed 开发'));
assert(F.phasePrompt(meeting,'TASK',F.spec('build',2),members).includes('需返工-合并手册-轮次1.md'));
meeting.serialWorkflow.soloDevelopment=true;meeting.serialWorkflow.steps=[['writer'],['writer']];
const solo=F.independentPrompt(meeting,'TASK',members);
assert(solo.includes('Renamed 开发') && solo.includes(path.join('TASK','任务记录.md')));
assert(!solo.includes('已完成-') && solo.includes('不改名、不等待派工'));
const text='PLAN: 先检查\nUPDATE：验证通过\n```text\nUPDATE: 保留代码示例\n```\n普通内容';
assert.equal(V.plainProgressText(text),'先检查\n验证通过\n```text\nUPDATE: 保留代码示例\n```\n普通内容');
const render={escapeHtml:x=>x,renderMarkdown:x=>x};
assert.equal(V.renderMessageBody('PLAN: 用户原文',{...render,isUser:true,plainProgress:true}),'<div class="conversation-user-text">PLAN: 用户原文</div>');
assert.equal(V.renderMessageBody('UPDATE: 旧协议',{...render}), 'UPDATE: 旧协议');
console.log('dev prompt policy: dynamic identities, complete handoffs, concise human reports, solo records and presentation compatibility passed');
