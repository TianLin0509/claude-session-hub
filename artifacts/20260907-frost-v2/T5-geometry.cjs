'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const assert = require('assert');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('../../tests/helpers/hub-launcher');
const { connectFirstPage } = require('../../tests/helpers/cdp-client');
async function geometry(c) {
  const s = await c.eval(`ipcRenderer.invoke('create-session', {kind:'powershell', cwd:${JSON.stringify(path.resolve(__dirname, '../..'))}})`);
  assert.ok(s.id, JSON.stringify(s));
  await _waitMs(1200);
  await c.eval(`showTerminal(${JSON.stringify(s.id)}, {focus:false})`);
  await _waitMs(800);
  return c.eval(`(() => {
    const rect = s => { const r=document.querySelector(s).getBoundingClientRect(); return {x:r.x,y:r.y,width:r.width,height:r.height}; };
    return {viewport:[innerWidth,innerHeight],dpr:devicePixelRatio,ticker:rect('#quota-ticker'),panel:rect('#terminal-panel'),terminal:rect('.terminal-container'),display:getComputedStyle(document.querySelector('#quota-ticker')).display};
  })()`);
}
async function run() {
  const label=process.argv[2] || 'baseline';
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'hub-t5-geometry-'));
  fs.writeFileSync(path.join(dir,'usage-cache.json'),JSON.stringify({claude:{usage5h:{pct:12},usage7d:{pct:24},ts:Date.now()}}));
  const port=await new Promise(resolve=>{const s=net.createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});
  let hub,c;
  try {
    hub=await launchIsolatedHub({dataDir:dir,port,label:'T5-geometry-'+label});
    c=await connectFirstPage(hub);
    for(let i=0;i<100;i++){if(await c.eval(`typeof ipcRenderer !== 'undefined' && typeof showTerminal === 'function' && document.querySelector('#quota-ticker') !== null`))break;await _waitMs(200);}
    await c.send('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    assert.deepStrictEqual(await c.eval(`ipcRenderer.invoke('get-meetings')`),[]);
    if(label==='mock' || label==='report') {
      const mockPath=process.argv[3];
      assert.ok(mockPath && fs.existsSync(mockPath), 'provide the verified local design mock path');
      await c.send('Page.navigate',{url:require('url').pathToFileURL(mockPath).href});
      const ready = label==='mock' ? `!!document.querySelector('#v2 .ring')` : `document.title.includes('T5') && Array.from(document.images).every(i=>i.complete && i.naturalWidth>0)`;
      for(let i=0;i<100;i++){if(await c.eval(ready))break;await _waitMs(100);}
      assert.strictEqual(await c.eval(ready),true);
      if(label==='mock') await c.eval(`document.querySelector('#v2').scrollIntoView({block:'start'})`);
      const shot=await c.send('Page.captureScreenshot',{format:'png'});
      fs.writeFileSync(path.join(__dirname,label==='mock'?'T5-design-mock.png':'T5-report-preview.png'),Buffer.from(shot.data,'base64'));
      console.log(label+' opened in isolated Chromium:',mockPath);
      return;
    }
    const result=await geometry(c);
    fs.writeFileSync(path.join(__dirname,'T5-geometry-'+label+'.json'),JSON.stringify(result,null,2));
    if(label==='after') {
      const before=JSON.parse(fs.readFileSync(path.join(__dirname,'T5-geometry-baseline.json')));
      assert.deepStrictEqual(result.viewport,before.viewport);
      assert.ok(Math.abs(result.terminal.height-before.terminal.height-30)<=1,JSON.stringify({before,result}));
    }
    console.log(JSON.stringify(result));
  } finally {if(c)await c.close();if(hub)await gracefulQuit(hub);}
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1;});
module.exports={geometry};
