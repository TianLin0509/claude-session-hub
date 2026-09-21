'use strict';
const store=require('./store'),jobs=require('./jobs');
async function main(){const id=store.id(process.argv[2]),mode=process.argv[3];const release=store.acquire('worker-'+id);if(!release)return;
  const job=store.read(id);
  const save=patch=>{Object.assign(job,patch,{updatedAt:new Date().toISOString()});store.write(id,job);};
  try{if(job.state==='succeeded')return;if(job.kind==='web'&&job.submissionAttempted&&mode!=='collect'){save({state:'needs_attention',error:'A previous worker attempted submission. Use web_collect; no automatic resend.'});return;}
    save({pid:process.pid,state:'running'});
    if(job.kind==='web')await jobs.runWeb(job,save,mode);else if(job.kind==='roundtable')await require('./roundtable').run(job,save);else throw Error('Unknown job kind');
  }catch(e){save({state:'failed',error:e.stack||e.message});if(job.kind==='roundtable')save({reportPath:require('./report').exportReport(job)});}
  finally{release();}
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;});
