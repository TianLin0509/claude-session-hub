'use strict';
// Real Codex + isolated Hub: small viewport, running tool, actual CDP wheel.
// Verify numbered transcript lines, not the changing Working timer.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { resolveWindowsCodex } = require('../main/codex-windows-command');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const j = JSON.stringify;
async function port() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const value = server.address().port; server.close(() => resolve(value)); });
  });
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-'));
  const home = path.join(root, 'h'), cwd = path.join(root, 'w'), bin = path.join(root, 'b');
  for (const dir of [home, cwd, bin]) fs.mkdirSync(dir);
  const out = path.resolve('artifacts', 'phone-A-real-codex-speed-' + (process.env.AUDIT_LABEL || 'candidate') + '-' + Date.now());
  fs.mkdirSync(out, { recursive: true });
  const report = { root, out, checks: [], passed: false, samples: [] };
  let hub, client, sid;
  const until = async (fn, label, timeout = 60000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(150); }
    throw new Error('timeout: ' + label);
  };
  const capture = async name => {
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const state = async () => client.eval(`(() => {
    const s=sessions.get(${j(sid)}),c=terminalCache.get(${j(sid)}),t=c?.terminal,b=t?.buffer.active;
    if(!b)return null;
    const lines=Array.from({length:b.length},(_,i)=>b.getLine(i)?.translateToString(true)||'');
    const working=[];
    for(let i=b.baseY;i<b.length;i++)if(/^\\s*(?:[^\\w\\s]\\s*)?(?:Working|Thinking|Waiting)\\b/.test(lines[i])){
      const l=b.getLine(i);working.push({text:lines[i],cells:Array.from({length:l.length},(_,x)=>{const a=l.getCell(x);return[a.getChars(),a.getFgColor(),a.getBgColor(),a.isBold(),a.isDim()]})});
    }
    return {model:s.currentModel,truth:getSessionRuntimeTruth(s),status:s.status,sid:s.codexSid,path:s.transcriptPath,
      hydrated:c._hydrated,text:lines.join('\\n'),working,rows:t.rows,cols:t.cols,baseY:b.baseY,viewportY:b.viewportY,buffer:b.type,modes:t.modes,
      style:{fontSize:t.options.fontSize,fontFamily:t.options.fontFamily,lineHeight:t.options.lineHeight,theme:t.options.theme},
      sidebar:document.querySelector('.session-item[data-session-id="'+s.id+'"]')?.dataset.runtimeState,
      composer:document.querySelector('.floating-input-bar[data-session-id="'+s.id+'"]')?.innerText};
  })()`);
  const send = async text => client.eval(`(() => {
    const bar=document.querySelector('.floating-input-bar[data-session-id="${sid}"]'),i=bar.querySelector('.floating-input-box');
    i.textContent=${j(text)};i.dispatchEvent(new Event('input',{bubbles:true}));bar.querySelector('.floating-input-send').click();
  })()`);
  const response = async marker => {
    const result = await client.eval(`ipcRenderer.invoke('parse-session-transcript',{hubSessionId:${j(sid)},opts:{limit:8,fromTail:true}})`);
    return (result.turns || []).some(t => t.role === 'assistant' && String(t.text).includes(marker));
  };
  const escape = async () => {
    await client.eval(`terminalCache.get(${j(sid)}).terminal.focus()`);
    await client.send('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
    await client.send('Input.dispatchKeyEvent', { type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27 });
  };
  try {
    // Match a desktop Hub launch, not the coding agent's non-interactive console.
    for(const key of ['NO_COLOR','FORCE_COLOR','TERM','COLORTERM','WT_SESSION','TERM_PROGRAM'])delete process.env[key];
    const authHome = process.env.REAL_CODEX_AUTH_SOURCE || path.join(os.homedir(), '.codex');
    for (const file of ['auth.json', 'models_cache.json']) fs.copyFileSync(path.join(authHome, file), path.join(home, file));
    fs.writeFileSync(path.join(home, 'config.toml'), 'model="gpt-6-astra"\nmodel_reasoning_effort="low"\ncheck_for_update_on_startup=false\n[tui]\nstatus_line=["model-with-reasoning","context-remaining","current-dir"]\n[tui.model_availability_nux]\n"gpt-6-astra"=4\n');
    const binary = process.env.PARITY_CODEX_EXE || resolveWindowsCodex().command;
    report.binary = binary;
    fs.writeFileSync(path.join(bin, 'codex.cmd'), '@echo off\r\n"' + binary + '"' + (process.env.PARITY_LEGACY ? '' : ' --no-daemon') + ' %*\r\n');
    const key = Object.keys(process.env).find(k => k.toLowerCase() === 'path');
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'd'), port: await port(), extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'c'), [key]: bin + path.delimiter + process.env[key],
    } });
    client = await connectFirstPage(hub);
    await until(() => client.eval('typeof sessions!=="undefined"'), 'renderer');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1180, height: 620, deviceScaleFactor: await client.eval('devicePixelRatio'), mobile: false });
    await client.eval(`window.__parityRaw=[];window.__parityHooks=[];ipcRenderer.on('terminal-data',(_e,p)=>__parityRaw.push(p.data));ipcRenderer.on('hook-event',(_e,p)=>__parityHooks.push({event:p.event,provider:p.provider,sid:p.sessionId,at:Date.now()}));`);
    const session = await client.eval(`ipcRenderer.invoke('create-session',{kind:'codex',opts:{cwd:${j(cwd)},model:'gpt-6-astra',effort:'low',mcpProfile:'none',codexSpeedTier:'standard'}})`);
    assert(session.id, j(session)); sid = session.id; report.id = sid;
    await until(() => client.eval(`!!document.querySelector('.session-item[data-session-id="${sid}"]')`), 'row');
    await client.eval(`document.querySelector('.session-item[data-session-id="${sid}"]').click()`);
    await until(async () => { const s = await state(); return s?.hydrated && /for shortcuts|Ask Codex to do anything/.test(s.text) && !/model:\s+loading/.test(s.text); }, 'ready');
    report.ready = await state(); await capture('ready');

    const click = async selector => {
      const pos=await client.eval(`(()=>{const e=document.querySelector(${j(selector)}),r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await client.send('Input.dispatchMouseEvent',{type:'mousePressed',...pos,button:'left',clickCount:1});
      await client.send('Input.dispatchMouseEvent',{type:'mouseReleased',...pos,button:'left',clickCount:1});
    };
    for(const tier of ['standard','fast','standard']) {
      await client.eval('__parityRaw=[]');
      await click('.composer-speed');
      await until(()=>client.eval(`!!document.querySelector('.speed-picker-menu [data-speed="${tier}"]:not(:disabled)')`),'speed ready');
      await click(`.speed-picker-menu [data-speed="${tier}"]`);
      await until(()=>client.eval(`sessions.get(${j(sid)}).codexSpeedTier===${j(tier)} && !sessions.get(${j(sid)})._modelSwitchPending`),'confirmed '+tier,22000);
      await sleep(800);
      report.samples.push({tier,screen:(await state()).text,raw:await client.eval('__parityRaw.join("")'),config:fs.readFileSync(path.join(home,'config.toml'),'utf8')});
      assert(!report.samples.at(-1).config.includes('service_tier'),'global service tier unchanged');
      assert.equal((await state()).model.id,'gpt-6-astra');
      await capture(tier+'-'+report.samples.length);
    }
    await click('[data-display-mode="phone"]');
    await client.send('Emulation.setDeviceMetricsOverride',{width:960,height:540,deviceScaleFactor:1,mobile:false});
    await sleep(800);
    report.phone=await state();
    assert.equal(report.phone.style.fontSize,18,'phone preset changes real terminal cell font');
    assert(report.phone.rows>=5&&report.phone.cols>=40,'small viewport retains a usable real CLI');
    await capture('phone-A-real-cli');
    await send('Reply exactly SPEED_OK. No tools.');
    await until(()=>response('SPEED_OK'),'real standard response',120000);
    await until(async()=>['completed','idle'].includes((await state()).truth.state),'idle');
    const final=await state();report.final=final;
    assert.equal(final.model.id,'gpt-6-astra');
    assert(!/GPT-6-Astra low fast/.test(final.text),'real next turn retains standard tier');
    assert(final.sid,'real CLI thread is bound');
    assert(!(await client.eval('__parityHooks.some(h=>h.event==="tool-start")')),'speed controls do not create tool work');
    await capture('phone-A-real-answer');
    report.passed=true;
  } catch (error) {
    report.error = error.stack;
    if (client && sid) { report.failure = await state().catch(() => null); await capture('failure').catch(() => {}); }
  } finally {
    try {
      try { if (client) await client.close(); }
      finally { if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); } }
    } catch (error) {
      report.cleanupError=error.stack;report.passed=false;
    } finally {
      fs.rmSync(path.join(home, 'auth.json'), { force: true });
      fs.writeFileSync(path.join(out, 'result.json'), j(report));
      console.log('REPORT', out, report.passed ? 'PASS' : report.error || report.cleanupError || 'FAIL');
      if (!report.passed) process.exitCode = 1;
    }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
