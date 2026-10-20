'use strict';
// Real isolated Hub; native model replies are deterministic fixtures.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const json = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-image-links-'));
  const out = path.resolve('artifacts/20261020-card-image-links-codex1/gui-' + Date.now());
  const cwd = path.join(root, 'workspace'), home = path.join(root, 'codex');
  for (const dir of [out, cwd, home]) fs.mkdirSync(dir, { recursive: true });
  const picture = path.join(cwd, '示例图片.png');
  fs.writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => { const p = server.address().port; server.close(() => resolve(p)); });
  });
  let hub, cdp;
  const evidence = { out, checks: [], passed: false };
  const until = async (expr, label) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) { if (await cdp.eval(expr)) return; await sleep(100); }
    throw new Error('timeout: ' + label);
  };
  const click = async selector => {
    await cdp.eval(`document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    const p = await cdp.eval(`(()=>{const r=document.querySelector(${json(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,width:r.width,height:r.height}})()`);
    assert(p.width > 0 && p.height > 0, selector);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await cdp.send('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    }
  };
  const snap = async name => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port, extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'store.json'),
    } });
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"', 'renderer');
    const session = await cdp.eval(`ipcRenderer.invoke('create-session',${json({kind:'codex',opts:{cwd,model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'standard'}})})`);
    const sid = json(session.id);
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`, 'native fixture ready');
    await until(`document.querySelector('.session-item[data-session-id="${session.id}"]')`, 'session row');
    await click(`.session-item[data-session-id="${session.id}"]`);
    const sent = await cdp.eval(`ipcRenderer.invoke('session:send-prompt',${json({sessionId:session.id,text:'fixture:card-images',attachments:[{type:'localImage',path:picture}],clientSubmissionId:'image-links'})})`);
    assert.equal(sent.ok, true);
    const card = '#msg-overlay .turn-card.assistant[data-phase="final_answer"]';
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='completed' && document.querySelector('${card} .turn-body a.rt-file-link')`, 'answer image links');
    assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-body img,#msg-overlay .conversation-attachments img").length'), 0);
    assert(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-avatar img").length > 0'));
    assert.equal(await cdp.eval(`document.querySelectorAll('${card} .turn-body a.rt-file-link').length`), 3);
    evidence.checks.push('native answer: Markdown images + ordinary PNG path become 3 clickable links; body and attachments contain no images; avatars remain');
    await snap('01-paths-only');
    await click(card + ' .turn-body a.rt-file-link');
    await until('document.querySelector(".preview-image")?.naturalWidth>0', 'Markdown image path preview');
    await snap('02-click-preview');
    await click('#preview-close');
    const attachment = '#msg-overlay .conversation-attachments [data-action="card-open-image"]';
    assert.equal(await cdp.eval(`document.querySelector('${attachment} .conversation-image-name').textContent`), picture);
    evidence.attachmentHeight = await cdp.eval(`document.querySelector('${attachment}').getBoundingClientRect().height`);
    assert(evidence.attachmentHeight < 40);
    await click(attachment);
    await until('document.querySelector(".preview-image")?.naturalWidth>0', 'attachment path preview');
    await click('#preview-close');
    evidence.checks.push('real mouse clicks on Markdown image path and attachment path open the existing image preview; attachment height <40 px');
    // Native transcript trimming intentionally drops inline image payloads.
    // Exercise this renderer fallback separately without changing that policy.
    const embeddedText = '![内嵌图片](data:image/png;base64,' + fs.readFileSync(picture).toString('base64') + ')';
    await cdp.eval(`(()=>{const host=document.createElement('div');host.id='card-image-links-embedded-probe';host.innerHTML=renderTurnCard(${json({id:'embedded-probe',role:'assistant',text:embeddedText})});document.querySelector('#msg-overlay').appendChild(host)})()`);
    await click('#card-image-links-embedded-probe [data-image-src]');
    await until('document.querySelector("dialog[open] .card-detail-image")?.naturalWidth>0', 'embedded image preview');
    await click('dialog[open] [aria-label="关闭详情"]');
    await cdp.eval('document.querySelector("#card-image-links-embedded-probe").remove()');
    evidence.checks.push('renderer probe: embedded data image remains a compact button and opens its original image on click');
    await until('typeof window.__mrRenderMarkdown==="function"', 'group renderer');
    const groupHtml = await cdp.eval(`window.__mrRenderMarkdown(${json('![结果图](./示例图片.png)')},${json(cwd)})`);
    assert(!groupHtml.includes('<img'), groupHtml);
    assert(groupHtml.includes('rt-file-link'), groupHtml);
    await cdp.eval(`(()=>{const host=document.createElement('div');host.id='card-image-links-group-probe';host.innerHTML=${json(groupHtml)};document.querySelector('#meeting-room-panel').appendChild(host)})()`);
    // The group panel is not open in this single-session fixture; use its real
    // delegated handler and check the resulting real preview separately.
    await cdp.eval('document.querySelector("#card-image-links-group-probe a").click()');
    await until('document.querySelector(".preview-image")?.naturalWidth>0', 'group image path preview');
    await click('#preview-close');
    evidence.checks.push('group Markdown renderer produces a file link; its delegated click opens the real preview (fixture probe, not full group conversation)');
    await cdp.eval('location.reload()');
    await until(`document.querySelector('.session-item[data-session-id="${session.id}"]')`, 'restored session row');
    await click(`.session-item[data-session-id="${session.id}"]`);
    await until(`document.querySelector('${card} .turn-body a.rt-file-link')`, 'restored image links');
    assert.equal(await cdp.eval('document.querySelectorAll("#msg-overlay .turn-body img,#msg-overlay .conversation-attachments img").length'), 0);
    evidence.checks.push('renderer reload restores clickable paths without inline images');
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) { try { await snap('03-final'); } catch {} await cdp.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), json(evidence, null, 2));
    console.log(json(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
