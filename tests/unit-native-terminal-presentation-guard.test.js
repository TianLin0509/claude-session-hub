'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const renderer=fs.readFileSync(path.join(__dirname,'../renderer/renderer.js'),'utf8');
const {isCodexSessionKind:isCodexKind}=require('../core/ai-kinds');
const {isNativeSession}=require('../core/codex-native-runtime');
const begin=renderer.indexOf('const _A = '),end=renderer.indexOf('// Meeting-room used to switch',begin);
assert(begin>=0 && end>begin);
function fixture(session) {
  const writes=[],timers=[];
  const cached={terminal:{write:data=>writes.push(data)}};
  const context={sessions:new Map([['s',session]]),_cursorDebounce:new Map(),
    isCodexKind,isNativeSession,
    shouldAutoPinCodexTerminal:()=>true,scheduleCodexBottomPin:()=>{context.pins++;},pins:0,
    setTimeout:(fn,ms)=>{timers.push({fn,ms});return timers.length;},clearTimeout:()=>{}};
  vm.createContext(context);vm.runInContext(renderer.slice(begin,end),context);
  return {writes,timers,context,write:data=>context.writeTerminalChunk('s',cached,data)};
}
test('native Codex preserves literal command output and avoids TUI cursor timers',()=>{
  const f=fixture({kind:'codex',runtimeBackend:'codex-app-server'});
  const raw='tool returned:\r\nImprove documentation in @real-file.js\r\ncode sample 😀\r\n';
  for(let i=0;i<100;i++)f.write(raw);
  assert.equal(f.writes.length,100);assert(f.writes.every(data=>data===raw),'provider text must not be mistaken for a CLI placeholder');
  assert.equal(f.timers.length,0,'native output needs no cursor restoration timers');assert.equal(f.context.pins,100,'visible follow behavior stays intact');
});
test('actual legacy Codex CLI retains placeholder and cursor handling',()=>{
  for(const runtimeBackend of ['pty',undefined]) {
    const f=fixture({kind:'codex-resume',runtimeBackend});f.write('› Improve documentation in @filename\r\n');
    assert(!f.writes[0].includes('Improve documentation'));assert(f.writes[0].endsWith('\x1b[?25l'));assert.equal(f.timers.length,1);
  }
});
test('other native providers keep their existing literal output path',()=>{
  for(const [kind,runtimeBackend] of [['claude','claude-stream-json'],['deepseek','acp'],['qwen','acp'],['glm','acp']]) {
    const f=fixture({kind,runtimeBackend});const raw='Improve documentation in @example\r\n';f.write(raw);
    assert.deepEqual(f.writes,[raw]);assert.equal(f.timers.length,0);
  }
});

test('snapshot hydration preserves queued native text and its sequence barrier',async()=>{
  const raw='Improve documentation in @real-file.js\r\n';
  for(const runtimeBackend of ['codex-app-server','pty']) {
    const f=fixture({kind:'codex',runtimeBackend});
    const cached={terminal:{},_pendingOutput:[],_pendingOutputBytes:0};
    Object.assign(f.context,{
      terminalCache:new Map([['s',cached]]),activeSessionId:null,
      ipcRenderer:{invoke:async()=>{
        cached._pendingOutput.push({seq:8,data:'already in snapshot'},{seq:9,data:raw});
        return {seq:8,text:'snapshot\r\n'};
      }},
      replayTerminalSnapshot:async(_cached,snapshot)=>f.writes.push(snapshot.text),
      writeXtermAndWait:async(_terminal,data)=>f.writes.push(data),
      onTerminalOutput:()=>{},noteCardTerminalOutput:()=>{}
    });
    const start=renderer.indexOf('async function hydrateTerminalFromSnapshot(');
    const stop=renderer.indexOf('// Tool block folding',start);
    assert(start>=0 && stop>start);
    vm.runInContext(renderer.slice(start,stop),f.context);
    await f.context.hydrateTerminalFromSnapshot('s',cached);
    assert.equal(f.writes.length,2,'snapshot-covered output must not be replayed twice');
    assert.equal(f.writes[0],'snapshot\r\n');
    assert.equal(f.writes[1],runtimeBackend==='codex-app-server'?raw:'\r\n');
    assert.equal(cached._hydratedSeq,9);assert.equal(cached._hydrated,true);
    assert.equal(cached._hydrating,false);assert.equal(cached._pendingOutput.length,0);
  }
});
