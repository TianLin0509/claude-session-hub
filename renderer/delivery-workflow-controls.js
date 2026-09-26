'use strict';
const {ipcRenderer}=require('electron');
const Recipients=require('../core/groupchat-recipients');
const states=new Map(),pending=new Set(),versions=new Map(),expanded=new Set(),busy=new Set();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let refresh=()=>{};
ipcRenderer.on('delivery:changed',(_e,s)=>{if(s?.meetingId){versions.set(s.meetingId,(versions.get(s.meetingId)||0)+1);states.set(s.meetingId,s);refresh(s.meetingId);}});
function render(row,meeting,onRefresh,onError) {
  refresh=onRefresh;
  const id=meeting.id,s=states.get(id);
  const recipients=Recipients.selectedSids(meeting).map(sid=>{const i=meeting.subSessions.indexOf(sid),slot=meeting.slotSpecs?.[i];return slot?.title || slot?.displayName || (slot?.kind?require('../core/ai-kinds').getKindLabel(slot.kind)+' '+(i+1):`成员 ${i+1}`);});
  if(!s && !pending.has(id)){const version=versions.get(id)||0;pending.add(id);ipcRenderer.invoke('delivery:status',{meetingId:id}).then(r=>{
    if(version===(versions.get(id)||0))states.set(id,r.ok?r:{error:r.error,label:'状态读取失败'});
  }).catch(e=>{if(version===(versions.get(id)||0))states.set(id,{error:e.message,label:'状态读取失败'});}).finally(()=>{pending.delete(id);onRefresh(id);});}
  row.dataset.deliveryMeeting=id;
  const active=!!s?.runId && !s.finished,paused=s?.paused || s?.recoveryPending;
  const title=!s?'读取交付进度…':s.error && !s.runId?'状态读取失败':s.finished?s.label:!s.runId?'工作流已就绪':`${paused?'已暂停 · ':''}${s.name}`;
  const primary=active?(paused?'<button type="button" data-delivery="resume" title="核对已交付文件后接续，不重复派发已确认任务">核对并接续</button>':'<button type="button" data-delivery="stop" title="暂停自动接续，并中断当前成员">暂停</button>'):'';
  const status=s?.runId&&!s.finished?`${s.delivered}/${s.total} 位已交付${s.round?` · 第 ${s.round} 轮`:''}`:s?.finished?'记录和交付文件已保留':'输入目标后按配置的步骤执行';
  row.innerHTML=`<section class="mr-file-flow mr-delivery-flow" aria-label="工作流进度" data-delivery-status="${esc(s?.status || 'loading')}" aria-busy="${busy.has(id)}">
    <div class="mr-file-detail"><strong>${esc(title)}</strong><small>${esc(status)}</small></div>
    <div class="mr-file-actions">${primary}${s?.error&&!s.runId?'<button type="button" data-delivery="refresh">重试读取</button>':''}<button type="button" data-delivery="files">交付文件</button>
      <button type="button" data-delivery-details aria-expanded="${expanded.has(id)}" aria-controls="mr-delivery-details">${expanded.has(id)?'收起详情':'流程详情'}</button></div>
    ${s?.error?`<div class="mr-file-error" role="status">${esc(s.error)}</div>`:''}
    <div id="mr-delivery-details" class="mr-delivery-details" ${expanded.has(id)?'':'hidden'}>
      <ol class="mr-delivery-stages">${(s?.stageNames || meeting.serialWorkflow.deliveryStages.map(stage=>stage.name)).map((name,i)=>`<li ${active&&s.stageIndex===i?'aria-current="step"':''}>${esc(name)}</li>`).join('')}</ol>
      <p>${s?.missing?.length?'待交付：'+esc(s.missing.join('、')):'每位成员交付结果后接续；聊天结束不会提前交棒'}</p>
      ${active?`<div class="mr-file-actions">${!paused?'<button type="button" data-delivery="resume" title="只核对交付，不重复发送任务">重新核对交付</button><button type="button" data-delivery="continue" title="只向尚未交付且已空闲的成员补发继续指令">提醒未交付成员</button>':''}<button type="button" data-delivery="cancel" title="保留记录，结束本次任务后才能启动新目标">结束任务</button></div>`:''}
    </div><small class="mr-delivery-recipients">${esc(recipients.length?'发送给 '+recipients.join('、'):'请点亮至少一位成员头像')}</small></section>`;
  row.querySelector('[data-delivery-details]').addEventListener('click',()=>{
    if(expanded.has(id))expanded.delete(id);else expanded.add(id);
    render(row,meeting,onRefresh,onError);
    row.querySelector('[data-delivery-details]').focus();
  });
  row.querySelectorAll('[data-delivery]').forEach(b=>b.addEventListener('click',async()=>{
    if(busy.has(id))return;busy.add(id);
    row.querySelectorAll('[data-delivery]').forEach(button=>button.disabled=true);
    try{
      if(b.dataset.delivery==='refresh'){versions.set(id,(versions.get(id)||0)+1);states.delete(id);onRefresh(id);return;}
      if(b.dataset.delivery==='files'){
        const r=await ipcRenderer.invoke('delivery:status',{meetingId:id});if(!r.ok || !r.dir)throw new Error(r.error || '任务目录不可用');
        await require('fs').promises.mkdir(r.dir,{recursive:true});
        if(!row.isConnected || !row.getClientRects().length || row.dataset.deliveryMeeting!==id)return;
        const result=await window.FileManagerPanel.open({cwd:r.dir,label:'工作流交付'});if(!result?.ok)throw new Error(result?.error || '打开失败');return;
      }
      if(b.dataset.delivery==='cancel' && !window.confirm('结束本次任务？已交付文件与记录会保留，之后可输入新目标。'))return;
      const result=await ipcRenderer.invoke('delivery:'+b.dataset.delivery,{meetingId:id});if(!result.ok)throw new Error(result.error || '工作流操作失败');
      states.delete(id);onRefresh(id);
    }catch(e){
      if(row.isConnected && row.getClientRects().length && row.dataset.deliveryMeeting===id)onError(e.message);
      else console.warn('[delivery-controls] previous group operation failed:',id,e.message);
    }finally{busy.delete(id);onRefresh(id);}
  }));
  if(busy.has(id))row.querySelectorAll('[data-delivery]').forEach(button=>button.disabled=true);
}
async function submit(meeting,text,recipientSids) {
  const targets=Recipients.resolveRecipients(meeting,recipientSids);
  const s=await ipcRenderer.invoke('delivery:status',{meetingId:meeting.id});if(!s.ok)throw new Error(s.error);
  if(s.runId && !s.finished){
    const r=await ipcRenderer.invoke('groupchat:user-supplement',{meetingId:meeting.id,text,recipientSids:targets});
    if(!r.ok)throw new Error(r.reason || r.error);return {...r,supplement:true};
  }
  const first=meeting.serialWorkflow.deliveryStages[0].members;
  const chosen=Recipients.memberIds(meeting,targets);
  if(first.length!==chosen.length || first.some(id=>!chosen.includes(id)))throw new Error('启动工作流需选中首步成员：'+first.map(id=>meeting.slotSpecs.find(m=>m.memberId===id)?.title || id).join('、')+'；本条未发送');
  const r=await ipcRenderer.invoke('delivery:start',{meetingId:meeting.id,userInput:text,recipientSids:targets});if(!r.ok)throw new Error(r.error);return r;
}
module.exports={render,submit,clear:id=>{versions.set(id,(versions.get(id)||0)+1);states.delete(id);}};
