'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{scryptSync}=require('node:crypto');
const {TeamAccess}=require('../core/team-workspace/access');
const {registerTeamWorkspaceIpc}=require('../main/ipc/team-workspace-handlers');
const password='fixture-private-password',verifier={salt:'test-salt',digest:scryptSync(password,'test-salt',32).toString('hex')};
test('private access requires separate password; restart relocks and attempts are throttled',()=>{
 let now=1000;const a=new TeamAccess({verifier,now:()=>now});
 assert.throws(()=>a.assert(),/未解锁/);
 for(let i=0;i<5;i++)assert.throws(()=>a.unlock('wrong'),/不正确/);
 assert.throws(()=>a.unlock(password),/过多/);now+=60001;
 assert.equal(a.unlock(password).unlocked,true);a.assert();
 assert.equal(new TeamAccess({verifier}).status().unlocked,false);
 a.lock();assert.throws(()=>a.assert(),/未解锁/);
});
test('locked main-window IPC cannot read data, start work or load websites; foreign frames cannot unlock',async()=>{
 const handlers={},access=new TeamAccess({verifier}),wc={mainFrame:{}},win={webContents:wc,isDestroyed:()=>false};let work=0,start=0,stop=0;
 registerTeamWorkspaceIpc({handle:(k,v)=>handlers[k]=v},{access,getWindow:()=>win,onUnlock:()=>start++,onLock:()=>stop++,workspace:{state:()=>{work++;return {value:1};},execute:()=>work++},web:{open:()=>work++,bounds:()=>work++,close:()=>work++}});
 const event={sender:wc,senderFrame:wc.mainFrame};
 assert.equal((await handlers['team:unlock']({sender:{},senderFrame:{}},{password})).ok,false);
 for(const channel of ['team:state','team:call','team:web-open','team:web-bounds'])assert.equal((await handlers[channel](event,{})).ok,false);
 assert.equal(work,0);assert.equal(start,0);
 assert.equal((await handlers['team:unlock'](event,{password:'wrong'})).ok,false);assert.equal(start,0);
 assert.equal((await handlers['team:unlock'](event,{password})).unlocked,true);assert.equal(start,1);
 assert.equal((await handlers['team:state'](event)).value,1);
 assert.equal((await handlers['team:lock'](event)).unlocked,false);assert.equal(stop,1);
 assert.equal((await handlers['team:web-open'](event,{})).ok,false);
});
test('main wiring does not start the team timer before unlock; initial HTML is hidden',()=>{
 const fs=require('node:fs'),path=require('node:path'),root=path.join(__dirname,'..');
 const source=fs.readFileSync(path.join(root,'main.js'),'utf8');
 const block=source.slice(source.indexOf('let teamWorkspace ='),source.indexOf("} catch (error) { console.error('[team-workspace]"));
 assert.equal((block.match(/teamWorkspace\.start\(\)/g)||[]).length,1);
 assert.match(block,/const startTeam = \(\) =>[\s\S]+teamWorkspace\.start\(\);\s*};/);
 assert.match(block,/access: teamAccess, onUnlock: startTeam/);
 assert.match(fs.readFileSync(path.join(root,'renderer/index.html'),'utf8'),/id="btn-team" hidden style="display:none"/);
});
