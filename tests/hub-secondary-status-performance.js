'use strict';
// Actual isolated Hub panes and mouse gestures; controlled provider protocol.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const server=net.createServer(); server.listen(0,'127.0.0.1',()=>{ const p=server.address().port; server.close(()=>resolve(p)); }); });
async function until(read) { const end=Date.now()+30000; while(Date.now()<end) { if(await read())return; await delay(100); } throw Error('UI readiness timeout'); }
async function click(c, selector) {
  const point=await c.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();if(!r.width||!r.height)throw Error('Hidden target');const x=r.x+r.width/2,y=r.y+r.height/2;if(!e.contains(document.elementFromPoint(x,y)))throw Error('Obscured target');return{x,y}})()`);
  await c.send('Input.dispatchMouseEvent',{type:'mousePressed',...point,button:'left',clickCount:1});
  await c.send('Input.dispatchMouseEvent',{type:'mouseReleased',...point,button:'left',clickCount:1});
}
(async()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'hub-secondary-status-'));
  let hub,c;
  try {
    hub=await launchIsolatedHub({dataDir:path.join(root,'data'),port:await port(),label:'secondary-status-performance',extraEnv:{
      CLAUDE_HUB_E2E:'1',CODEX_HOME:path.join(root,'codex'),CLAUDE_CONFIG_DIR:path.join(root,'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE:path.resolve('tests/fixtures/codex-app-server.js'),
      CLAUDE_HUB_CLAUDE_STREAM_FIXTURE:path.resolve('tests/fixtures/claude-stream.js'),
      CLAUDE_HUB_FIXTURE_CONFIG_DIR:path.join(root,'launch-config'),CLAUDE_HUB_NATIVE_FIXTURE_STORE:path.join(root,'threads.json'),
    }});
    c=await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1680,height:1000,deviceScaleFactor:1,mobile:false});
    await until(()=>c.eval('typeof sessionSplit!=="undefined" && !!sessionSplit'));
    const ids=[];
    for(const kind of ['codex','claude']) {
      const cwd=path.join(root,kind);fs.mkdirSync(cwd);
      const session=await c.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind,opts:{cwd,mcpProfile:'none'}})})`);
      ids.push(session.id);
      await until(()=>c.eval(`sessions.get(${JSON.stringify(session.id)})?.nativeRuntime?.connection==='connected'`));
    }
    await click(c,`.session-item[data-session-id="${ids[0]}"]`);
    await until(()=>c.eval(`activeSessionId===${JSON.stringify(ids[0])}`));
    await click(c,'[data-session-layout="two"]');
    await click(c,`.session-item[data-session-id="${ids[1]}"]`);
    await until(()=>c.eval(`sessionSplit.secondary()?.sessionId===${JSON.stringify(ids[1])} && !!document.querySelector('.split-secondary .floating-input-bar')`));
    await delay(1000);
    const result=await c.eval(`(async()=>{
      const sid=${JSON.stringify(ids[1])}, view=sessionSplit.secondary();
      const bar=document.querySelector('.split-secondary .floating-input-bar');
      const oldInvoke=ipcRenderer.invoke, oldFull=bar._paintComposer, oldClock=bar._paintComposerClock;
      let parseCalls=0, fullPaints=0, clockPaints=0, failNextRead=false;
      ipcRenderer.invoke=function(channel,args,...rest){if(channel==='parse-session-transcript' && args?.hubSessionId===sid){parseCalls++;if(failNextRead){failNextRead=false;return Promise.reject(Error('controlled history read failure'))}}return oldInvoke.call(this,channel,args,...rest)};
      bar._paintComposer=function(...args){fullPaints++;return oldFull.apply(this,args)};
      bar._paintComposerClock=function(...args){clockPaints++;return oldClock.apply(this,args)};
      try {
        const started=performance.now();
        for(let i=0;i<30;i++) {
          ipcRenderer.emit('status-event',{}, {sessionId:sid,contextPct:i,contextUsed:i*100,contextMax:100000});
          ipcRenderer.emit('session-usage-updated',{}, {sessionId:sid,usage:{total:i*100,observedAt:Date.now()}});
          await new Promise(r=>setTimeout(r,250));
        }
        await new Promise(r=>setTimeout(r,300));
        const metadata={events:60,historyReads:parseCalls,fullPaints,clockPaints,elapsedMs:performance.now()-started,contextPct:sessions.get(sid).contextPct,contextLabel:bar.querySelector('.fi-ctx-ring')?.title || bar.textContent};
        fullPaints=0;clockPaints=0;
        for(let i=0;i<50;i++)view.updateStatus({clockOnly:true,now:Date.now()+i*1000});
        const clock={ticks:50,fullPaints,clockPaints};
        parseCalls=0;
        ipcRenderer.emit('native-agent-item',{}, {sessionId:sid,type:'item.completed'});
        await new Promise(r=>setTimeout(r,350));
        const contentHistoryReads=parseCalls;
        parseCalls=0;fullPaints=0;view.setVisible(false);
        ipcRenderer.emit('native-agent-item',{}, {sessionId:sid,type:'item.completed'});
        view.updateStatus({clockOnly:true,now:Date.now()});
        await new Promise(r=>setTimeout(r,350));
        const hidden={historyReads:parseCalls,fullPaints};
        view.setVisible(true);
        await new Promise(r=>setTimeout(r,350));
        const restoredHistoryReads=parseCalls;
        failNextRead=true;view.schedule();
        await new Promise(r=>setTimeout(r,350));
        const errorShown=!document.querySelector('.split-secondary .split-history-status').hidden;
        parseCalls=0;
        ipcRenderer.emit('status-event',{}, {sessionId:sid,contextPct:29});
        await new Promise(r=>setTimeout(r,350));
        const recovery={errorShown,retryReads:parseCalls,errorCleared:document.querySelector('.split-secondary .split-history-status').hidden};
        return {metadata,clock,contentHistoryReads,hidden,restoredHistoryReads,recovery};
      } finally {ipcRenderer.invoke=oldInvoke;bar._paintComposer=oldFull;bar._paintComposerClock=oldClock;}
    })()`);
    assert.equal(result.metadata.contextPct,29);
    assert.match(result.metadata.contextLabel,/71%/,'context indicator must still paint new values');
    assert.ok(result.contentHistoryReads>0,'content events must still refresh history');
    if(process.argv.includes('--verify')) {
      assert.equal(result.metadata.historyReads,0,'metadata must not reread conversation');
      assert.equal(result.clock.fullPaints,0,'clocks must not rebuild all composer controls');
      assert.equal(result.clock.clockPaints,50);
      assert.deepEqual(result.hidden,{historyReads:0,fullPaints:0});
      assert.ok(result.restoredHistoryReads>0,'hidden content must reconcile when shown');
      assert.equal(result.recovery.errorShown,true);
      assert.ok(result.recovery.retryReads>0,'status updates must retry a failed history read');
      assert.equal(result.recovery.errorCleared,true);
    }
    const output=path.resolve(process.argv[2] || 'artifacts/20261004-hub-secondary-status-codex1.json');
    fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2),'utf8');
    console.log(JSON.stringify(result));
  } finally {await c?.close();if(hub)await gracefulQuit(hub);}
})().catch(error=>{console.error(error);process.exitCode=1});
