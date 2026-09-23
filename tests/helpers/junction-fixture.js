'use strict';
const fs=require('node:fs');
// Retry only fixture creation, never the test body or its assertions.
async function createJunctionFixture(source,target,{symlink=fs.promises.symlink,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}){
  for(let attempt=0;;attempt++){
    try{await symlink(source,target,'junction');return;}
    catch(error){
      if(!['EBUSY','EPERM'].includes(error.code)||attempt>=5)throw error;
      // Do not overwrite or remove an entry created by another operation.
      try{await fs.promises.lstat(target);throw error;}catch(check){if(check.code!=='ENOENT')throw check;}
      await wait(Math.min(1600,200*2**attempt));
    }
  }
}
function createJunctionFixtureSync(source,target,{symlink=fs.symlinkSync,wait=ms=>Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms)}={}){
  for(let attempt=0;;attempt++){
    try{symlink(source,target,'junction');return;}
    catch(error){
      if(!['EBUSY','EPERM'].includes(error.code)||attempt>=5)throw error;
      try{fs.lstatSync(target);throw error;}catch(check){if(check.code!=='ENOENT')throw check;}
      wait(Math.min(1600,200*2**attempt));
    }
  }
}
module.exports={createJunctionFixture,createJunctionFixtureSync};
