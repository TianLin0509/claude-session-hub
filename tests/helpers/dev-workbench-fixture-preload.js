'use strict';
// TEST ONLY. Loaded by the isolated E2E entry, never shipped
// or imported by the application. Real manager/orchestrator/IPC remain in use.
if (process.type === 'browser' && process.env.HUB_DEV_WORKBENCH_FIXTURE === '1') {
  const path=require('node:path'),fs=require('node:fs'),os=require('node:os');
  const dir=path.resolve(process.env.CLAUDE_HUB_DATA_DIR||'');
  const relative=path.relative(os.tmpdir(),dir);
  if(!relative||relative.startsWith('..')||path.isAbsolute(relative)||!dir.includes('hub-dev-workbench-e2e-'))throw new Error('Fixture refused non-isolated Hub');
  const {ipcMain,app}=require('electron');
  const room=require('../../core/meeting-room'),Original=room.MeetingRoomManager;
  let manager;
  room.MeetingRoomManager=class extends Original{constructor(){super();manager=this;}};
  const groupchat=require('../../core/group-chat-orchestrator');
  const WT=require('../../renderer/workflow-templates');
  const ids=[];
  ipcMain.handle('fixture:dev-seed',(_event,{count=6}={})=>{
    for(let i=ids.length;i<count;i++){
      const m=manager.createMeeting({mode:i===5?'general':'dev',title:i===0?'群聊创建页更紧凑':i===1?'报告导出异常恢复':i===2?'附件预览保留阅读位置':`开发任务 ${i}`,workspace:dir,workspaceLabel:i%2?'实验笔记':'AI Hub'});
      const wf=WT.createTemplateConfig('dev-task',[{memberId:'m1',kind:'claude'},{memberId:'m2',kind:'codex'}]);
      wf.loopState={runId:'fixture-'+m.id,goal:'改进现有功能，保留配置能力，并实际验证。',status:i===2?'done':'paused',round:1,currentStep:'reviewer',history:[],lastError:i===1?{reason:'测试样例：审核席位暂未响应'}:null};
      manager.updateMeeting(m.id,{serialWorkflow:wf});ids.push(m.id);
      const orch=groupchat.getOrchestrator(dir,m.id);
      const {turnNum:n}=orch.beginTurn('改进当前功能');
      orch.completeTurn(n,'改进当前功能',[{sid:'fixture-author',text:`PROGRESS: 已完成第 ${i} 项功能的实现，正在核对验收证据。\nVERIFIED: 12 项示例检查通过\nRISK: ${i===1?'需要处理失联席位':'无'}\nREPORT: ${path.join(dir,'fixture-report.html')}`}],{'fixture-author':{memberId:'m1',displayName:'工作席'}});
      if(i===2)orch.completeTurn(2,'审核',[{sid:'fixture-reviewer',text:'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 示例验收成立\nNEXT: 请维护者查看效果'}],{'fixture-reviewer':{memberId:'m2',displayName:'审核席'}});
    }
    fs.writeFileSync(path.join(dir,'fixture-report.html'),'<!doctype html><meta charset="utf-8"><h1>测试报告</h1><p>仅供隔离工作台验证。</p>','utf8');
    return ids;
  });
  ipcMain.handle('fixture:dev-publish',(_event,{id,text,progress=false}={})=>{
    if(!ids.includes(id))throw new Error('unknown fixture task');
    const orch=groupchat.getOrchestrator(dir,id);
    const {turnNum:n}=orch.beginTurn('测试更新');
    if(progress){orch.recordTurnPrompt(n,'fixture-author','原始测试要求');return orch.recordProgressUpdate('fixture-author',text,Date.now(),'工作席');}
    orch.completeTurn(n,'测试更新',[{sid:'fixture-author',text}],{'fixture-author':{memberId:'m1',displayName:'工作席'}});
    return true;
  });
  ipcMain.handle('fixture:dev-malform',(_event,{id}={})=>{
    if(!ids.includes(id))throw new Error('unknown fixture task');
    const original=manager.getMeeting(id);
    // A malformed historical field must not poison the rest of the board.
    manager.meetings.get(id).serialWorkflow.loopState.history=[null,{pass:false}];
    return original.title;
  });
  ipcMain.handle('fixture:dev-quit',()=>{setTimeout(()=>app.quit(),20);return true;});
}
