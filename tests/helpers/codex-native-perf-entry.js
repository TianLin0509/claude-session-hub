'use strict';
// Opt-in observational entry point for identical baseline/candidate measurement.
// No runtime state is injected or changed by these handlers.
const fs=require('fs'),path=require('path'),{monitorEventLoopDelay}=require('perf_hooks');
const root=process.env.CLAUDE_HUB_NATIVE_PERF_ROOT;
if(!root || !process.env.CLAUDE_HUB_DATA_DIR)throw Error('isolated performance root required');
const {app,ipcMain}=require('electron');app.setAppPath(root);process.chdir(root);
let counters={broadcasts:0,writes:0,bytes:0},manager;
const histogram=monitorEventLoopDelay({resolution:10});histogram.enable();
const relevant=p=>typeof p==='string' && path.resolve(p).startsWith(path.resolve(process.env.CLAUDE_HUB_DATA_DIR)) && /\.json(?:\.|$)/i.test(p);
for(const obj of [fs,fs.promises])for(const method of ['writeFile','writeFileSync'])if(typeof obj[method]==='function'){
  const original=obj[method];obj[method]=function(file,data,...args){if(relevant(file)){counters.writes++;counters.bytes+=Buffer.byteLength(String(data));}return original.call(this,file,data,...args);};
}
app.on('web-contents-created',(_e,contents)=>{const original=contents.send;contents.send=function(channel,...args){if(/session-updated|turn-complete|agent-turn|terminal-data/.test(channel))counters.broadcasts++;return original.call(this,channel,...args);};});
const {SessionManager}=require(path.join(root,'core/session-manager.js'));
const originalCreate=SessionManager.prototype.createSession;
SessionManager.prototype.createSession=function(...args){manager=this;return originalCreate.apply(this,args);};
ipcMain.handle('native-perf:reset',()=>{counters={broadcasts:0,writes:0,bytes:0};histogram.reset();return {at:Date.now()};});
ipcMain.handle('native-perf:read',()=>({at:Date.now(),counters:{...counters},loopP95:histogram.percentile(95)/1e6,loopMax:histogram.max/1e6,
  sessions:manager?[...manager.sessions.values()].map(s=>({id:s.info.id,pid:s.pty.pid,kind:s.info.kind,native:s.info.nativeRuntime,completedAt:s.info.lastCompletedAt,codexSid:s.info.codexSid,screen:manager.getSessionBuffer(s.info.id)?.slice(-8000)})):[]}));
require(path.join(root,'main.js'));
