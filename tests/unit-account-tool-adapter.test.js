'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('fs'),os=require('os'),path=require('path'),{spawnSync}=require('node:child_process');
for(const withGroup of [true,false])test('image discovery reads '+(withGroup?'explicit groups':'legacy queue')+' without modifying the queue',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-image-discovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.writeFileSync(path.join(root,'image_pool.py'),'from pathlib import Path\ndef pool_root(): return Path(__file__).parent\n');
 const seed=`import sqlite3,sys\nfrom pathlib import Path\nc=sqlite3.connect(Path(sys.argv[1])/'queue.sqlite3')\nc.executescript("CREATE TABLE accounts(id,enabled,ready,state,heartbeat,updated${withGroup?',login_group':''}); CREATE TABLE controls(account_id,action,status,result,created,updated);")\nc.execute("INSERT INTO accounts VALUES('primary-2',1,1,'authenticated',0,0${withGroup?",'primary'":''})")\nc.commit()\nc.close()`;
 const run=args=>{const r=spawnSync('python',args,{encoding:'utf8',windowsHide:true});assert.equal(r.status,0,r.error?.message||r.stderr||r.stdout);return r.stdout;};
 run(['-c',seed,root]);const file=path.join(root,'queue.sqlite3'),before=fs.readFileSync(file);
 const result=JSON.parse(run([path.resolve(__dirname,'../scripts/account-tool-adapter.py'),'images','status',root]));
 assert.equal(result.accounts.length,1);assert.equal(result.accounts[0].login_group,withGroup?'primary':'');
 assert.deepEqual(fs.readFileSync(file),before);assert.ok(!JSON.stringify(result).includes(root));
});
