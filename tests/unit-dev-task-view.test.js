'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const T=require('../core/dev-task-view');
const {createTaskReader}=require('../main/groupchat/dev-task-reader');
const {createDevWorkbench}=require('../main/groupchat/dev-workbench');
const base={schema:'hub.task-view.v1',taskId:'one',revision:1,phase:'implementing',summary:'已定位根因，正在验证',decision:null};
const md=d=>'# 任务记录\n```hub-task-view\n'+JSON.stringify(d)+'\n```\n';
async function main(){
  assert.equal(T.parseRecord('已完成并合并','one'),null);
  assert.throws(()=>T.parseRecord(md({...base,taskId:'old'}),'one'));
  assert.throws(()=>T.parseRecord(md(base)+md(base),'one'));
  assert.throws(()=>T.parseRecord(md({...base,phase:'PASS'}),'one'));
  assert.throws(()=>T.parseRecord(md({...base,revision:0}),'one'));
  assert.throws(()=>T.parseRecord(md({...base,decision:{text:'拍板'}}),'one'));
  const protocol=require('../core/dev-file-workflow');
  const version=JSON.parse(protocol.protocolKey({id:'one',serialWorkflow:{}},[]))[0];
  assert(version>1,'New record contract invalidates old delivered protocol receipts');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'hub-task-view-'));
  const m={id:'one',title:'任务',groupChat:true,scene:'dev',workspace:dir,serialWorkflow:{fileFlowVersion:2,soloDevelopment:true}};
  const td=path.join(dir,'task-docs','one');await fs.mkdir(td,{recursive:true});
  const file=path.join(td,'任务记录.md');
  const runtime={state:'completed',label:'已回复'};
  try{
    let value=await T.readTask(dir,m),row=T.projectFileRow(m,{value},runtime,{});
    assert.equal(row.phase,'unknown');assert.equal(row.scope,'current');
    await fs.writeFile(file,md({...base,phase:'discussion'}));value=await T.readTask(dir,m);row=T.projectFileRow(m,{value},runtime,{});assert.equal(row.scope,'discuss','Record creation is not implementation');
    await fs.writeFile(file,md(base));value=await T.readTask(dir,m);row=T.projectFileRow(m,{value},runtime,{});assert.equal(row.phase,'implementing','Turn completion never completes task');
    const decision={id:'d1',text:'需要确认范围',recipient:'user',resolved:false};
    await fs.writeFile(file,md({...base,decision}));value=await T.readTask(dir,m);row=T.projectFileRow(m,{value},runtime,{});assert.equal(row.attention.kind,'user-decision');
    assert.equal(T.projectFileRow(m,{value,error:'partial write'},runtime,{}).quality,'stale');
    let snapshot=value;const reader=createTaskReader({getMeetings:()=>[m],getHubDataDir:()=>dir,onChanged(){},read:async()=>snapshot,interval:60000});
    const settle=async()=>{for(let i=0;i<30;i++){await new Promise(r=>setTimeout(r,5));if(reader._test.cache.size)return;}throw Error('reader timeout');};
    reader.get(m);await settle();snapshot={...value,record:{...value.record,revision:0}};reader.enqueue(m);await new Promise(r=>setTimeout(r,20));assert.match(reader.get(m).error,/回退/);assert.equal(reader.get(m).value.record.revision,1);reader.dispose();
    const resumed=createTaskReader({getMeetings:()=>[m],getHubDataDir:()=>dir,onChanged(){},read:async()=>snapshot,interval:60000});
    resumed.get(m);for(let i=0;i<50&&!resumed._test.cache.size;i++)await new Promise(r=>setTimeout(r,5));
    assert.match(resumed.get(m).error,/回退/,'Revision high-water mark survives reader restart');resumed.dispose();
    let runtimeState='running',events=0;
    const expiry=createTaskReader({getMeetings:()=>[m],getHubDataDir:()=>dir,getRuntime:()=>runtimeState,onChanged(){events++;},read:async()=>value,interval:60000});
    expiry.reconcile();await new Promise(r=>setTimeout(r,25));events=0;runtimeState='unknown';expiry.reconcile();assert(events>0,'Runtime expiry emits without file change');expiry.dispose();
    const m2={...m,id:'cache-failure'},mkdir=fs.mkdir,rename=fs.rename;let writes=0;
    const storage=createTaskReader({getMeetings:()=>[m2],getHubDataDir:()=>dir,onChanged(){},read:async()=>({...value,record:{...value.record,taskId:m2.id}}),interval:60000});
    try{
      fs.mkdir=async(...args)=>{if(String(args[0]).endsWith('workbench-cache')){writes++;throw Error('EACCES fixture');}return mkdir(...args);};
      storage.get(m2);for(let i=0;i<50&&!storage._test.cache.size;i++)await new Promise(r=>setTimeout(r,5));
      assert.match(storage.get(m2).error,/缓存保存失败/);storage.enqueue(m2);await new Promise(r=>setTimeout(r,30));
      assert(writes>=2,'Unchanged source retries failed cache persistence');assert.match(storage.get(m2).error,/缓存保存失败/);
      fs.mkdir=mkdir;
      // Slow disk completion must not race a fixed 30 ms assertion.
      fs.rename=async(...args)=>{if(String(args[1]).endsWith('cache-failure.json'))await new Promise(r=>setTimeout(r,80));return rename(...args);};
      storage.enqueue(m2);
      const deadline=Date.now()+5000;
      while(storage.get(m2)?.error!=='' && Date.now()<deadline)await new Promise(r=>setTimeout(r,10));
      assert.equal(storage.get(m2).error,'');
      assert.equal(JSON.parse(await fs.readFile(path.join(dir,'workbench-cache','cache-failure.json'),'utf8')).value.record.taskId,m2.id);
    }finally{fs.mkdir=mkdir;fs.rename=rename;storage.dispose();}
    await fs.writeFile(file,'\ufffd');await T.readTask(dir,m); // valid UTF-8 without structured status is unknown
    await fs.writeFile(file,Buffer.from([0xff]));await assert.rejects(()=>T.readTask(dir,m));
    // Real Git topology: a report alone is insufficient; both ancestry links must hold.
    const {execFileSync}=require('node:child_process');
    const runGit=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8',windowsHide:true}).trim();
    runGit('init','--quiet','--initial-branch=master');
    const commit=()=>runGit('-c','user.name=Fixture','-c','user.email=fixture@example.invalid','-c','commit.gpgsign=false','-c','core.hooksPath=/dev/null','commit','--allow-empty','--quiet','-m','fixture');
    commit();const candidate=runGit('rev-parse','HEAD');commit();const merged=runGit('rev-parse','HEAD');
    await fs.writeFile(file,md({...base,phase:'completed',merge:{candidate,commit:merged,target:'refs/heads/master'}}));
    value=await T.readTask(dir,m);assert.equal(value.mergeVerified,true,'Candidate and commit are reachable in target');
    runGit('branch','older',candidate);
    await fs.writeFile(file,md({...base,phase:'completed',merge:{candidate,commit:merged,target:'refs/heads/older'}}));
    value=await T.readTask(dir,m);assert.equal(value.mergeVerified,false,'Target that lacks merge commit is not merged');assert(value.mergeError);
    const double={...m,serialWorkflow:{fileFlowVersion:2}};
    await fs.writeFile(path.join(td,'已完成-开题报告.md'),'');await fs.writeFile(path.join(td,'已完成-实现手册-轮次1.md'),'');await fs.writeFile(path.join(td,'已完成-合并手册-轮次1.md'),'');
    value=await T.readTask(dir,double);row=T.projectFileRow(double,{value},runtime,{});assert.equal(row.scope,'history');assert.equal(row.stage.tone,'ok');assert.equal(row.mergeVerified,false);
    await fs.writeFile(path.join(td,'合并手册-轮次1.md'),'');await assert.rejects(()=>T.readTask(dir,double),/同一阶段/);
    const handlers={};const board=createDevWorkbench({meetingManager:{getMeeting:()=>m,getAllMeetings:()=>[m]},getHubDataDir:()=>dir,sendToRenderer(){},readSummary:async()=>({missing:true})});
    board.registerIpc({handle:(n,f)=>handlers[n]=f});assert.equal((await handlers['dev-workbench:action'](null,{meetingId:'one',action:'pin'})).ok,false,'Mutation IPC rejected');assert.equal((await handlers['dev-workbench:read-source'](null,{meetingId:'../escape'})).ok,false);board.dispose();
    console.log('task-view parser, lifecycle, stale revision, file chain, encoding and read-only IPC: PASS');
  }finally{await fs.rm(dir,{recursive:true,force:true});}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
