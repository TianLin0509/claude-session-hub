'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert');
const {launchIsolatedHub,gracefulQuit}=require('./hub-launcher');
const {connectFirstPage}=require('./cdp-client');
const {seedUsageData,getFreePort,waitFor,click}=require('./usage-refresh-fixture');
const {waitForSidebarLayout}=require('./sidebar-quota-geometry');

// Keep the visible window limited to animation verification. The rest of the
// A workflow runs hidden, with its static transition override declared.
async function runSidebarAnimation(out,sha) {
  fs.mkdirSync(out,{recursive:true});
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-quota-animation-'));
  const fixture=seedUsageData(dataDir,'regression');
  const evidence={sha,dataDir,mode:'Visible isolated window, unmodified product transitions, real mouse toggles'};
  let hub,cdp;
  try {
    hub=await launchIsolatedHub({dataDir,port:await getFreePort(),label:'quota-real-animation',windowMode:'visible',
      extraEnv:{CLAUDE_HUB_E2E:'1',APPDATA:fixture.fakeAppData}});
    evidence.pid=hub.pid;evidence.port=hub.port;
    cdp=await connectFirstPage(hub,t=>/renderer[\\/]index\.html/.test(t.url));
    await cdp.send('Page.enable');await cdp.send('Runtime.enable');
    await waitFor(cdp,`document.querySelectorAll('.sidebar-quota-provider').length===4`);
    evidence.window=await cdp.eval(`ipcRenderer.invoke('debug:agent-league-background-state')`);
    assert.ok(evidence.window.windowVisible && evidence.window.pid===hub.pid);
    assert.ok(hub.log().some(line=>line.includes('hook server listening')));
    assert.ok(await cdp.eval(`!document.querySelector('#quota-test-static-layout')`));
    evidence.initial=await waitForSidebarLayout(cdp,280,1);
    assert.ok(evidence.initial.layout.transition.includes('0.18s'));
    await click(cdp,'#btn-expand-sidebar');
    evidence.collapsed=await waitForSidebarLayout(cdp,0,1);
    let shot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(out,'collapsed.png'),Buffer.from(shot.data,'base64'));
    await click(cdp,'#btn-expand-sidebar');
    evidence.expanded=await waitForSidebarLayout(cdp,280,1);
    assert.ok(evidence.expanded.providers.every(p=>p.buttons.every(b=>b.hit)));
    shot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true});
    fs.writeFileSync(path.join(out,'expanded.png'),Buffer.from(shot.data,'base64'));
    evidence.ok=true;
  } catch(error) {evidence.ok=false;evidence.error=error.stack;evidence.layoutEvidence=error.layoutEvidence;throw error;}
  finally {
    try {
      if(hub) fs.writeFileSync(path.join(out,'hub.log'),hub.log().join('\n'));
      if(cdp) await cdp.close();
      if(hub) evidence.teardown=await gracefulQuit(hub);
    } catch(error) {evidence.ok=false;evidence.teardownError=error.stack;throw error;}
    finally {fs.writeFileSync(path.join(out,'verification.json'),JSON.stringify(evidence,null,2));}
  }
  return evidence;
}
module.exports={runSidebarAnimation};
