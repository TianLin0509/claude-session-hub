'use strict';
const fs=require('node:fs'),path=require('node:path');
class PhoneJournal{
 constructor(dir,safeStorage){this.dir=dir;this.file=path.join(dir,'channel.bin');this.safe=safeStorage;fs.mkdirSync(dir,{recursive:true});this.state=fs.existsSync(this.file)?JSON.parse(safeStorage.decryptString(fs.readFileSync(this.file))):{enabled:false,cursor:0,inbox:[],outbox:[],notices:[]};for(const r of this.state.inbox)if(r.state==='dispatching'){r.state='unknown';r.issue='上次提交被中断，先核对，不自动重发';}this.save();}
 save(){fs.writeFileSync(this.file+'.tmp',this.safe.encryptString(JSON.stringify(this.state)));fs.renameSync(this.file+'.tmp',this.file);}
 change(fn){fn(this.state);this.save();}
}
module.exports={PhoneJournal};
