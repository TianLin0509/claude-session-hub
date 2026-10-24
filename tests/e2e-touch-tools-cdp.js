'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const run = `20261024-touch-tools-codex-${Date.now()}`;
const out = path.resolve(__dirname, '../artifacts', run);
async function main() {
  fs.mkdirSync(out, {recursive:true});
  const server = net.createServer(); await new Promise(r => server.listen(0,'127.0.0.1',r));
  const port = server.address().port; await new Promise(r => server.close(r));
  let hub, c;
  const result = { scope:'Real isolated Electron; screenshot uses real screen capture and isolated in-memory clipboard', checks:[] };
  try {
    hub = await launchIsolatedHub({dataDir:path.join(require('os').tmpdir(),run,'hub'),port,extraEnv:{CLAUDE_HUB_E2E:'1'}});
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});
    const wait = async expr => { for(let i=0;i<150;i++){if(await c.eval(`Boolean(${expr})`)) return; await _waitMs(100);}throw new Error('timeout '+expr); };
    await wait('window.__hubE2E?.clipboard');
    const touch = async selector => {
      const p=await c.eval(`(() => {const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await c.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[p]});
      await c.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]}); await _waitMs(100);
    };
    await touch('#btn-touch-tools'); await wait('!document.getElementById("touch-tools-panel").hidden');
    assert.equal(await c.eval('getComputedStyle(document.getElementById("touch-tools")).webkitAppRegion'),'no-drag');
    const shot=await c.send('Page.captureScreenshot',{format:'png'});
    fs.writeFileSync(path.join(out,run+'.png'),Buffer.from(shot.data,'base64'));
    result.checks.push('touch opens menu; no-drag hit area; 1440px screenshot');
    await touch('[data-touch-action="copy"]'); await wait('document.querySelector("#touch-tools-panel small").textContent.includes("请先选中")');
    result.checks.push('empty selection gives actionable feedback');
    await touch('[data-touch-action="screenshot"]');
    await wait('document.querySelector("#touch-tools-panel small").textContent.includes("全屏截图已复制")');
    result.image = await c.eval('require("electron").clipboard.readImage().getSize()');
    assert.ok(result.image.width>100 && result.image.height>100);
    result.checks.push('real full-screen capture verified in isolated clipboard; no desktop image saved');
    await c.eval('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');
    const p=await c.eval('(() => {const r=document.getElementById("btn-touch-tools").getBoundingClientRect();return {x:r.x+10,y:r.y+10};})()');
    await c.send('Input.dispatchMouseEvent',{type:'mouseMoved',...p});
    await wait('!document.getElementById("touch-tools-panel").hidden');
    result.checks.push('mouse hover opens menu');
    await c.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      const input=document.createElement('textarea');input.id='touch-selection-probe';input.value='触摸全选测试';
      input.style='position:fixed;left:500px;top:300px;width:300px;height:80px';document.body.appendChild(input);input.focus();input.setSelectionRange(1,3); })()`);
    await touch('#btn-touch-tools'); await touch('[data-touch-action="select-all"]'); await touch('[data-touch-action="copy"]');
    await wait('require("electron").clipboard.readText()==="触摸全选测试"');
    result.checks.push('touch select-all then copy preserves textarea selection');
    await c.eval(`(() => { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
      const input=document.getElementById('touch-selection-probe');input.focus();input.setSelectionRange(0,2);document.getElementById('btn-touch-tools').focus(); })()`);
    await c.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',text:'\r',windowsVirtualKeyCode:13});
    await c.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await wait('!document.getElementById("touch-tools-panel").hidden');
    await touch('[data-touch-action="copy"]');
    await wait('require("electron").clipboard.readText()==="触摸"');
    result.checks.push('keyboard focus transfer preserves textarea selection');
    result.passed=true;
  } catch(error) { result.error=error.stack;process.exitCode=1; }
  finally { if(c)await c.close();if(hub)await gracefulQuit(hub);fs.writeFileSync(path.join(out,run+'.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({...result,out},null,2)); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
