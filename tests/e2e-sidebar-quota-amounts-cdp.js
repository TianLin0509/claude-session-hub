'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, seedUsageData, waitFor, click } = require('./helpers/usage-refresh-fixture');
const { measureQuota } = require('./helpers/sidebar-quota-geometry');
const ROOT = path.resolve(__dirname, '..');
const OUT = path.resolve(process.env.HUB_QUOTA_EVIDENCE_DIR || path.join(ROOT, 'artifacts/20260910-sidebar-quota-a-r2/amounts'));
const samples = [
  { name:'usd', balance:1234.56, currency:'USD', text:'USD 1234.56' },
  { name:'cny', balance:60.6, currency:'CNY', text:'¥60.60' },
  { name:'long-cny', balance:12345678.9, currency:'CNY', text:'¥12345678.90' },
  { name:'zero', balance:0, currency:'CNY', text:'¥0.00' },
  { name:'missing', balance:null, currency:'CNY', text:'—' },
];
async function run() {
  fs.mkdirSync(OUT, {recursive:true});
  const evidence = { root:ROOT, sha:require('child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:ROOT,encoding:'utf8',windowsHide:true}).trim(),
    fixture:'Amounts loaded from isolated usage-cache.json; real Hub, no DOM data injection. Controlled Codex app-server.', cases:[] };
  try {
    for (const sample of samples) {
      const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-quota-amount-'));
      const fixture = seedUsageData(dataDir, 'regression');
      const configPath = path.join(dataDir, 'config.json');
      const config = JSON.parse(fs.readFileSync(configPath,'utf8'));
      config.proxy = {http:false}; fs.writeFileSync(configPath, JSON.stringify(config));
      const cachePath = path.join(dataDir, 'usage-cache.json');
      const cache = JSON.parse(fs.readFileSync(cachePath,'utf8'));
      cache.deepseek = {totalBalance:sample.balance,currency:sample.currency,observedAt:Date.now()-600000};
      fs.writeFileSync(cachePath,JSON.stringify(cache));
      // Stress the longest quota reading as well as monetary values.
      const fakeServer = path.join(fixture.fakeAppData,'npm/fake-codex-app-server.js');
      fs.writeFileSync(fakeServer, fs.readFileSync(fakeServer,'utf8').replaceAll('usedPercent: 7,','usedPercent: 0,'));
      const result = {sample, dataDir, geometry:[]}; evidence.cases.push(result);
      let hub, cdp;
      try {
        hub = await launchIsolatedHub({dataDir,port:await getFreePort(),label:'quota-amount-'+sample.name,windowMode:'hidden',
          extraEnv:{APPDATA:fixture.fakeAppData,CLAUDE_PROXY:'',CLAUDE_HUB_EGRESS_FIXTURE:JSON.stringify({foreign:{ok:false,error:'no proxy'},domestic:{ok:true,countryCode:'CN',country:'China',city:'Beijing',ip:'192.0.2.1'}})}});
        result.pid=hub.pid; result.port=hub.port;
        cdp=await connectFirstPage(hub,t=>/renderer[\\/]index\.html/.test(t.url));
        await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
        await cdp.send('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
        await waitFor(cdp, `document.querySelectorAll('.sidebar-quota-value').length===4 && accountUsageController.getSnapshot().codex?.source==='app-server'`);
        result.values=await cdp.eval(`Array.from(document.querySelectorAll('.sidebar-quota-value'),e=>e.textContent)`);
        assert.deepStrictEqual(result.values,['0%','86%','100%',sample.text]);
        assert.ok(hub.log().some(line=>line.includes('hook server listening')));
        for (const zoom of [1,1.25]) for (const width of [280,340,380,440]) {
          await cdp.eval(`require('electron').webFrame.setZoomFactor(${zoom});document.querySelector('#session-sidebar').style.width='${width}px';document.querySelector('#session-sidebar').style.minWidth='${width}px'`);
          await _waitMs(230);
          const geometry=await measureQuota(cdp);
          result.geometry.push({width,zoom,...geometry});
          if(width===280) {
            const clip=await cdp.eval(`(()=>{const r=document.querySelector('#rail-usage').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,scale:3}})()`);
            const shot=await cdp.send('Page.captureScreenshot',{format:'png',fromSurface:true,clip});
            fs.writeFileSync(path.join(OUT,`${sample.name}-${zoom}.png`),Buffer.from(shot.data,'base64'));
          }
          assert.deepStrictEqual(geometry.overlaps,[],`adjacent overlap: ${sample.name}/${width}/${zoom}`);
          assert.deepStrictEqual(geometry.overflow,[],`provider overflow: ${sample.name}/${width}/${zoom}`);
          assert.strictEqual(geometry.providers[1].box.y,geometry.providers[2].box.y);
          assert.ok(geometry.providers.every(p=>p.buttons.length===1 && p.buttons.every(b=>b.width>=18 && b.height>=26 && b.hit)), 'refresh buttons visible and hit-testable');
        }
        // Actual pointer interaction at the narrowest width retains full amount
        // when the real DeepSeek refresh reports the isolated missing API key.
        await cdp.eval(`require('electron').webFrame.setZoomFactor(1);document.querySelector('#session-sidebar').style.width='280px';document.querySelector('#session-sidebar').style.minWidth='280px'`);
        await _waitMs(230);
        await click(cdp,'.sidebar-quota-provider[data-provider="deepseek"] button');
        await waitFor(cdp,`!!accountUsageController.getSnapshot().refresh.providers.deepseek.error`);
        assert.strictEqual(await cdp.eval(`document.querySelector('[data-provider="deepseek"] .sidebar-quota-value').textContent`),sample.text);
        result.refreshError=await cdp.eval(`accountUsageController.getSnapshot().refresh.providers.deepseek.error`);
        result.ok=true;
      } finally {
        if(hub) fs.writeFileSync(path.join(OUT,sample.name+'-hub.log'),hub.log().join('\n'));
        try { if(cdp) await cdp.close(); }
        finally { if(hub) result.teardown=await gracefulQuit(hub); }
      }
      console.log('PASS',sample.name,'8 geometries and real refresh');
    }
    evidence.ok=true;
  } catch(error) { evidence.ok=false; evidence.error=error.stack; throw error; }
  finally { fs.writeFileSync(path.join(OUT,'verification.json'),JSON.stringify(evidence,null,2)); }
  console.log('PASS amount matrix:',OUT);
}
if(require.main===module) run().catch(error=>{console.error(error);process.exitCode=1;});
module.exports={run};
