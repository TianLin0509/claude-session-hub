'use strict';

// Real card clicks / Ctrl+V in an isolated Electron window. Fixture text needs no model call.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const native = process.argv.includes('--native');
const diagnose = process.argv.includes('--diagnose');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const j = JSON.stringify;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-copy-'));
const out = path.resolve('output', '20261001-card-copy-codex1', String(Date.now()));
fs.mkdirSync(out, { recursive: true });
const guard = path.join(__dirname, 'helpers', 'clipboard-guard.ps1');
const backupDir = path.join(root, 'clipboard-backup');
const text = '田哥，AI Hub 和 Codex 已确认。\n10月2日至5日带4岁孩子出行；路径 C:/AIWork/中文 文件.html；emoji 🧪🙂；公式 α + β = 2。';
const textFile = path.join(root, 'text.txt');
const sentinelFile = path.join(root, 'sentinel.txt');
fs.writeFileSync(textFile, text, 'utf8');
fs.writeFileSync(sentinelFile, 'HUB_CARD_COPY_SENTINEL', 'utf8');
const ps = (script, args) => execFileSync('powershell.exe', ['-NoProfile', '-STA', '-File', script, ...args], { windowsHide: true, encoding: 'utf8' }).trim();
const evidence = { native, diagnose, textLength: text.length, rounds: [], passed: false };
let hub, c, backedUp = false;
let expected = text;
async function until(expr) {
  for (let n = 0; n < 120; n++) { if (await c.eval(expr)) return; await sleep(100); }
  throw new Error('timeout: ' + expr);
}
async function click(selector) {
  const point = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
}
async function paste() {
  await c.eval(`(()=>{const e=document.getElementById('card-copy-paste-target');e.value='';e.focus()})()`);
  for (const type of ['keyDown', 'keyUp']) await c.send('Input.dispatchKeyEvent', { type, key: 'v', code: 'KeyV', windowsVirtualKeyCode: 86, modifiers: 2 });
  await sleep(80);
  return c.eval("document.getElementById('card-copy-paste-target').value");
}
async function main() {
  try {
    if (native) { evidence.backup = ps(guard, ['backup', backupDir]); backedUp = true; }
    const port = await new Promise(r => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => r(p)); }); });
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, label: 'card-copy', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_E2E: '1', CODEX_HOME: path.join(root, 'codex'), CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      ...(native ? { CLAUDE_HUB_E2E_REAL_CLIPBOARD: '1' } : {}),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('!!window.__hubE2E');
    await c.eval(`(()=>{
      window.__hubE2E.cardQuestionNavigator.mountFixture({sessionId:'card-copy-fixture',count:1,clear:true});
      const card=document.querySelector('#msg-overlay .turn-card.user');
      card.querySelector('.turn-body').textContent=${j(text)};
      window._sessionTurns.get(card.dataset.turnId).text=${j(text)};
      const input=document.createElement('textarea');input.id='card-copy-paste-target';
      input.style.cssText='position:fixed;bottom:0;right:0;width:500px;height:90px;z-index:999999';document.body.append(input);
      window.__copyProbe={writes:0,browserWrites:0};
      const clip=require('electron').clipboard, original=clip.writeText;
      clip.writeText=(...args)=>{window.__copyProbe.writes++;return original.apply(clip,args)};
      const browserOriginal=navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText=(...args)=>{window.__copyProbe.browserWrites++;return browserOriginal(...args)};
    })()`);
    expected = await c.eval("extractVisibleCardText(document.querySelector('#msg-overlay .turn-card.user .turn-body'))");
    fs.writeFileSync(textFile, expected, 'utf8');
    evidence.expectedText = expected;
    for (let n = 0; n < (native ? 20 : 1); n++) {
      await c.eval("require('electron').clipboard.writeText('HUB_CARD_COPY_SENTINEL')");
      const before = await c.eval('({...window.__copyProbe})');
      await click('#msg-overlay .turn-card.user .ta-btn[data-action=copy]');
      await sleep(160);
      const read = await c.eval("require('electron').clipboard.readText()");
      const browserRead = await c.eval('navigator.clipboard.readText()');
      const pasted = native ? await paste() : null;
      const after = await c.eval('({...window.__copyProbe})');
      const result = { round: n, readMatches: read === expected, browserReadMatches: browserRead === expected, pasteMatches: native ? pasted === expected : null,
        nativeWrites: after.writes - before.writes, browserWrites: after.browserWrites - before.browserWrites };
      if (native && n === 0) result.formats = JSON.parse(ps(path.join(__dirname, 'helpers', 'windows-clipboard-inspect.ps1'), ['-ExpectedFile', textFile]));
      evidence.rounds.push(result);
      if (n === 0) result.actualText = read;
      if (!diagnose) assert.equal(read, expected);
      if (!diagnose && native) assert.equal(pasted, expected);
    }
    if (!native && !diagnose) {
      // Lose the first OS write without throwing: reproduce the missing verification/retry.
      await c.eval(`(()=>{const clip=require('electron').clipboard;clip.writeText('HUB_CARD_COPY_SENTINEL');const original=clip.writeText;let lost=true;
        clip.writeText=(...args)=>{if(lost){lost=false;return;}return original.apply(clip,args)};
        navigator.clipboard.writeText=async()=>{};
      })()`);
      await click('#msg-overlay .turn-card.user .ta-btn[data-action=copy]');
      await sleep(500);
      assert.equal(await c.eval("require('electron').clipboard.readText()"), expected, 'card copy must repair a lost clipboard write before showing success');
      evidence.retryRecovered = true;
      await c.eval("require('electron').clipboard.writeText=()=>{};require('electron').clipboard.clear()");
      await click('#msg-overlay .turn-card.user .ta-btn[data-action=copy]');
      await sleep(650);
      assert.match(await c.eval("document.querySelector('#msg-overlay .turn-card.user .ta-btn[data-action=copy]').textContent"), /失败/);
      evidence.permanentFailureShown = true;
    }
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; process.exitCode = 1; }
  finally {
    if (backedUp) {
      try { evidence.restore = ps(guard, ['restore', backupDir, '-TextFile', textFile + ';' + sentinelFile]); }
      catch (error) { evidence.restoreError = String(error); process.exitCode = 1; }
    }
    if (c) await c.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(error => { evidence.quitError = String(error); });
    fs.writeFileSync(path.join(out, '20261001-card-copy-evidence-codex1.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  }
}
main();
