'use strict';
const {ipcRenderer}=require('electron');
const states=new Map(),pending=new Set(),versions=new Map();
const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let refresh=()=>{};
ipcRenderer.on('delivery:changed',(_e,s)=>{if(s?.meetingId){versions.set(s.meetingId,(versions.get(s.meetingId)||0)+1);states.set(s.meetingId,s);refresh(s.meetingId);}});
function render(row,meeting,onRefresh,onError) {
  refresh=onRefresh;
  const id=meeting.id,s=states.get(id);
  if(!s && !pending.has(id)){const version=versions.get(id)||0;pending.add(id);ipcRenderer.invoke('delivery:status',{meetingId:id}).then(r=>{
    if(version===(versions.get(id)||0))states.set(id,r.ok?r:{error:r.error,label:'状态读取失败'});
  }).catch(e=>{if(version===(versions.get(id)||0))states.set(id,{error:e.message,label:'状态读取失败'});}).finally(()=>{pending.delete(id);onRefresh(id);});}
  row.innerHTML=`<div class="mr-file-flow mr-delivery-flow" data-delivery-status="${esc(s?.status || 'loading')}"><div class="mr-file-detail"><strong>${esc(s?.label || '读取交付进度…')}</strong>${s?.round?` · 第 ${s.round} 轮`:''}
    <small>${s?.missing?.length?'待交付：'+esc(s.missing.join('、')):'每位成员交付结果后接续；聊天结束不会提前交棒'}</small>
    ${s?.paused || s?.recoveryPending?'<span>已暂停或待恢复 · 核对文件后接续</span>':''}
    ${s?.error?`<span class="mr-file-error">${esc(s.error)}</span>`:''}</div>
    <div class="mr-file-actions"><button type="button" data-delivery="files">任务文件</button>
    ${s?.runId && !s.finished?'<button type="button" data-delivery="resume" title="重新核对已交付文件；不会重发任务">核对并接续</button><button type="button" data-delivery="continue" title="向尚未交付且已空闲的成员发送继续指令">继续未交付成员</button><button type="button" class="stop" data-delivery="stop">暂停</button><button type="button" data-delivery="cancel" title="结束本次任务并保留所有交付记录，之后可输入新目标">结束任务</button>':''}</div></div>`;
  row.querySelectorAll('[data-delivery]').forEach(b=>b.addEventListener('click',async()=>{
    b.disabled=true;
    try{
      if(b.dataset.delivery==='files'){
        const r=await ipcRenderer.invoke('delivery:status',{meetingId:id});if(!r.ok || !r.dir)throw new Error(r.error || '任务目录不可用');
        await require('fs').promises.mkdir(r.dir,{recursive:true});
        const result=await window.FileManagerPanel.open({cwd:r.dir,label:'工作流交付'});if(!result?.ok)throw new Error(result?.error || '打开失败');return;
      }
      if(b.dataset.delivery==='cancel' && !window.confirm('结束本次任务？已交付文件与记录会保留，之后可输入新目标。'))return;
      const result=await ipcRenderer.invoke('delivery:'+b.dataset.delivery,{meetingId:id});if(!result.ok)throw new Error(result.error || '工作流操作失败');
      states.delete(id);onRefresh(id);
    }catch(e){onError(e.message);}finally{b.disabled=false;}
  }));
}
async function submit(meeting,text) {
  const s=await ipcRenderer.invoke('delivery:status',{meetingId:meeting.id});if(!s.ok)throw new Error(s.error);
  if(s.runId && !s.finished){
    if(!/^(继续|继续执行|接着做)[。！!\s]*$/.test(text.trim()))throw new Error('当前任务尚未交付；请在成员会话补充要求，或用“继续”接续，避免覆盖正在执行的任务');
    const r=await ipcRenderer.invoke('delivery:continue',{meetingId:meeting.id,userInput:text});if(!r.ok)throw new Error(r.error);return r;
  }
  const r=await ipcRenderer.invoke('delivery:start',{meetingId:meeting.id,userInput:text});if(!r.ok)throw new Error(r.error);return r;
}
module.exports={render,submit,clear:id=>{versions.set(id,(versions.get(id)||0)+1);states.delete(id);}};
