'use strict';
const Task = require('../../core/dev-task-view');
const F = require('../../core/dev-file-workflow');
const fs = require('node:fs/promises');
const path = require('node:path');
function createTaskReader({ getMeetings, getMeeting, getRuntime = () => null, getHubDataDir, onChanged, read = Task.readTask, interval = 2000 }) {
  const cache = new Map(), pending = new Set(), queue = new Map(), runtimes = new Map();
  const currentMeeting = id => getMeeting ? getMeeting(id) : getMeetings().find(x=>x.id===id);
  let active = 0, disposed = false;
  const signature = m => JSON.stringify([m.id, m.workspace, m.serialWorkflow?.taskViewId, F.isSolo(m)]);
  function enqueue(m) {
    if (!F.enabled(m) || disposed || pending.has(m.id)) return;
    queue.set(m.id, m); pump();
  }
  function pump() {
    while (!disposed && active < 4 && queue.size) {
      const [id, m] = queue.entries().next().value;
      queue.delete(id); pending.add(id); active++;
      const identity = signature(m);let old = cache.get(id);
      const cacheFile=path.join(getHubDataDir(),'workbench-cache',id+'.json');
      Promise.resolve().then(async () => {
        if(!old){
          try{
            const raw=await Task.readText(path.dirname(cacheFile),cacheFile),saved=JSON.parse(raw.text);
            if(saved.identity===identity&&saved.value?.record){
              Task.parseRecord('```hub-task-view\n'+JSON.stringify(saved.value.record)+'\n```',m.serialWorkflow?.taskViewId || m.id);
              old={...saved,error:'正在重新核对缓存'};
            }
          }catch(error){if(error.code!=='ENOENT')old={identity,error:'缓存不可用：'+error.message};}
        }
        return read(getHubDataDir(), m);
      }).then(async value => {
        if (disposed) return;
        const current = currentMeeting(id);
        if (!current || signature(current) !== identity) return;
        const prior = old?.identity === identity ? old.value : null;
        if (prior?.record && value.name === prior.name) {
          if (!value.record) throw new Error('任务摘要缺失，保留最后有效记录');
          if (value.record.revision < prior.record.revision || value.record.revision === prior.record.revision && JSON.stringify(value.record) !== JSON.stringify(prior.record)) throw new Error('任务摘要修订号回退或同版本内容冲突');
        }
        const next = { identity, value, error: '', cacheDirty:false };
        if(value.record && (old?.identity!==identity || old?.value?.hash!==value.hash || old?.cacheDirty)){
          try{await fs.mkdir(path.dirname(cacheFile),{recursive:true});const temp=cacheFile+'.tmp';await fs.writeFile(temp,JSON.stringify(next),'utf8');await fs.rename(temp,cacheFile);}
          catch(error){next.cacheDirty=true;next.error='缓存保存失败，重启前的修订保护不可用：'+error.message;}
        }
        if(disposed)return;
        cache.set(id, next);
        if (old?.identity !== identity || old?.error || JSON.stringify({ ...prior, checkedAt:0 }) !== JSON.stringify({ ...value, checkedAt:0 })) onChanged(id);
      }).catch(error => {
        if (disposed) return;
        const current = currentMeeting(id);
        if (!current || signature(current)!==identity) return;
        const next = { identity, value:old?.identity===identity ? old.value:null, cacheDirty:old?.identity===identity && !!old.cacheDirty, error:String(error.message||error) };
        cache.set(id, next);
        if (old?.error !== next.error) onChanged(id);
      }).finally(() => { active--; pending.delete(id); pump(); });
    }
  }
  function reconcile() {
    const meetings = getMeetings().filter(F.enabled), ids = new Set(meetings.map(m=>m.id));
    for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
    for (const id of queue.keys()) if (!ids.has(id)) queue.delete(id);
    for (const id of runtimes.keys()) if (!ids.has(id)) runtimes.delete(id);
    for (const m of meetings) {
      const next=JSON.stringify(getRuntime(m));
      if(runtimes.get(m.id)!==next){runtimes.set(m.id,next);onChanged(m.id);}
      enqueue(m);
    }
  }
  const timer = setInterval(reconcile, interval); timer.unref?.();
  return { get(m) { const saved=cache.get(m.id); if (!saved) enqueue(m); return saved?.identity===signature(m)?saved:null; }, enqueue, reconcile,
    dispose() { disposed=true;clearInterval(timer);queue.clear();cache.clear();runtimes.clear(); }, _test:{cache} };
}
module.exports = { createTaskReader };
