'use strict';
// Real isolated Electron + production IPC/rendering + controlled App Server stdio.
// Provider outputs are fixtures, not evidence that real model commands ran.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const json = JSON.stringify;
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer(); server.on('error', reject);
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
}
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-card-native-details-'));
  const out = path.resolve('artifacts/20260911-card-r1-r4-codex1/gui-' + Date.now());
  const home = path.join(root, 'codex'), cwd = path.join(root, 'workspace'), downloads = path.join(root, 'downloads');
  for (const dir of [out, home, cwd, downloads]) fs.mkdirSync(dir, { recursive: true });
  const trace = path.join(root, 'native-trace.jsonl');
  const picture = path.join(cwd, '示例图片.png'), missing = path.join(cwd, 'missing.png');
  fs.writeFileSync(picture, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64'));
  fs.writeFileSync(path.join(cwd, 'card-delivery.html'), '<!doctype html><meta charset="utf-8"><p>隔离验收产物</p>', 'utf8');
  fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  let hub, cdp;
  const evidence = { root, out, checks: [], passed: false };
  const until = async (expr, label) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(150); }
    throw new Error('timeout: ' + label);
  };
  const snap = async name => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
  };
  const click = async selector => {
    await cdp.eval(`document.querySelector(${json(selector)}).scrollIntoView({block:'center',behavior:'instant'})`);
    await sleep(80);
    const point = await cdp.eval(`(()=>{const e=document.querySelector(${json(selector)}),r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}})()`);
    assert(point.w > 0 && point.h > 0, 'button must be visible: ' + selector);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: point.x, y: point.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  };
  const starts = () => fs.readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse).filter(x => x.method === 'turn/start');
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(root, 'data'), port: await freePort(), windowMode: 'hidden', label: 'card-native-details', extraEnv: {
      CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'),
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
      CLAUDE_HUB_NATIVE_FIXTURE_STORE: path.join(root, 'native-store.json'), CLAUDE_HUB_NATIVE_FIXTURE_TRACE: trace,
    } });
    evidence.pid = hub.pid; evidence.port = hub.port; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1000, deviceScaleFactor: 1, mobile: false });
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await until('typeof sessions!=="undefined" && typeof ipcRenderer!=="undefined"', 'renderer ready');
    const opts = { cwd, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const session = await cdp.eval(`ipcRenderer.invoke('create-session',${json({ kind: 'codex', opts })})`);
    const sid = json(session.id); evidence.sid = session.id;
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='idle'`, 'native ready');
    await until(`document.querySelector('.session-item[data-session-id="${session.id}"]')`, 'sidebar');
    await click(`.session-item[data-session-id="${session.id}"]`);
    await click('[data-view="card"]');
    const prompt = 'fixture:card-details\n---\n1. 保留同一条多行输入\n- 检查卡片与交付';
    // Use the real shared IPC for explicit attachments; this does not exercise image paste capture.
    const sent = await cdp.eval(`ipcRenderer.invoke('session:send-prompt',${json({ sessionId: session.id, text: prompt, clientSubmissionId: 'card-details-first', attachments: [{ type: 'localImage', path: picture }, { type: 'localImage', path: missing }] })})`);
    assert.equal(sent.ok, true);
    const scope = '#msg-overlay ', final = scope + '.turn-card[data-phase="final_answer"]';
    const rail = scope + '.tc-cluster', delivery = final + ' .turn-delivery-summary';
    await until(`sessions.get(${sid})?.nativeRuntime?.state==='completed' && document.querySelector(${json(delivery)})`, 'completion plus associated delivery');
    assert.equal(await cdp.eval(`document.querySelectorAll('${scope}.turn-delivery-summary').length`), 1);
    assert.equal(await cdp.eval(`document.querySelector(${json(delivery)}).open`), false);
    assert.equal(await cdp.eval(`document.querySelector(${json(rail)}).open`), false);
    evidence.collapsed = await cdp.eval(`(${json([rail, delivery])}).map(s=>{const e=document.querySelector(s);return {text:e.innerText,height:e.getBoundingClientRect().height}})`);
    assert(evidence.collapsed.every(x => x.height <= 40), json(evidence.collapsed));
    assert.match(evidence.collapsed[0].text, /活动 30/);
    assert.match(evidence.collapsed[1].text, /2 个文件记录.*27 项验证.*1 个产物/);
    await cdp.eval(`document.querySelector(${json(rail)}).scrollIntoView({block:'end',behavior:'instant'})`);
    await snap('01-default-collapsed');
    evidence.checks.push('one final delivery; activity and delivery closed initially, each <=40 px; 30 tools, all 27 checks and early file records retained');
    await click(delivery + ' > summary');
    assert.equal(await cdp.eval(`document.querySelectorAll('${delivery} .turn-delivery-check.status-failed').length`), 1);
    assert.match(await cdp.eval(`document.querySelector(${json(delivery)}).innerText`), /命令成功.*exit 0/);
    assert.match(await cdp.eval(`document.querySelector('${delivery} .turn-delivery-file.status-failed').innerText`), /not-written\.js.*失败 · 变更未确认/s);
    await snap('02-delivery-expanded');
    await click(delivery + ' > summary');
    await click(rail + ' > summary');
    const longRow = '[data-activity-id^="long-"]', failedRow = '[data-activity-id^="failed-"]';
    assert.equal(await cdp.eval(`document.querySelector('${failedRow} [data-activity-status]').dataset.activityStatus`), 'failed');
    assert.match(await cdp.eval(`document.querySelector('${failedRow} .turn-activity-row-meta').innerText`), /1\.2s.*exit -1/s);
    await click(longRow + ' > summary');
    const full = '完整日志\n' + '验'.repeat(60001) + '\nEND-OF-FULL-OUTPUT';
    assert.equal(await cdp.eval(`document.querySelector('${longRow} pre').textContent.length`), 50000);
    assert.match(await cdp.eval(`document.querySelector('${longRow} .tc-result-meta').textContent`), /全文保留/);
    // Capture the clipboard boundary in the isolated renderer without overwriting the user's OS clipboard.
    await cdp.eval(`window.__cardCopied=[];navigator.clipboard.writeText=async text=>{window.__cardCopied.push(text)}`);
    await click(longRow + ' [data-action="tc-copy-result"]');
    await until('window.__cardCopied.length===1', 'copy complete');
    assert.equal(await cdp.eval('window.__cardCopied[0]'), full);
    await cdp.eval(`navigator.clipboard.writeText=()=>new Promise((resolve,reject)=>{window.__rejectCardCopy=reject});window.__oldCopy=document.querySelector('${longRow} [data-action="tc-copy-result"]')`);
    await click(longRow + ' [data-action="tc-copy-result"]');
    await until('typeof window.__rejectCardCopy==="function"', 'copy awaits clipboard');
    await click('[data-action="tc-show-all"]');
    await until(`document.querySelectorAll('${rail} .turn-activity-item').length===30`, 'all tools accessible');
    assert.equal(await cdp.eval('window.__oldCopy.isConnected'), false, 'in-place render replaced old button');
    assert.equal(await cdp.eval(`document.querySelector(${json(rail)}).open`), true);
    await cdp.eval(`window.__rejectCardCopy(new Error('controlled clipboard failure after rerender'))`);
    await until(`document.querySelector('${longRow} .card-detail-error')?.textContent.includes('controlled clipboard failure')`, 'copy failure visible');
    await cdp.eval(`navigator.clipboard.writeText=async text=>{window.__cardCopied.push(text)}`);
    await click(longRow + ' [data-action="tc-open-full-result"]');
    await until('document.querySelector("dialog[open] pre")', 'full source dialog');
    await click('dialog[open] .card-detail-dialog-tools button:nth-of-type(2)');
    assert.match(await cdp.eval('document.querySelector("dialog[open] pre").textContent'), /END-OF-FULL-OUTPUT$/);
    await snap('03-full-output-last-page');
    await click('dialog[open] .card-detail-dialog-tools button:nth-of-type(4)');
    const deadline = Date.now() + 10000;
    while (!fs.readdirSync(downloads).some(name => name.endsWith('.txt')) && Date.now() < deadline) await sleep(100);
    const downloaded = fs.readdirSync(downloads).find(name => name.endsWith('.txt'));
    assert(downloaded, 'download completed'); assert.equal(fs.readFileSync(path.join(downloads, downloaded), 'utf8'), full);
    await click('dialog[open] [aria-label="关闭详情"]');
    await click(rail + ' > summary');
    evidence.checks.push('full 60k+ source copies and downloads exactly; DOM bounded at 50k; pagination reaches tail; pending copy failure survives real rerender; negative exit and failed file remain explicit');
    const thumb = scope + '.conversation-image-thumb[data-image-index="0"]';
    await cdp.eval(`document.querySelector(${json(thumb)}).scrollIntoView({block:'center'})`);
    await until(`document.querySelector('${thumb} img')?.naturalWidth>0`, 'thumbnail loaded');
    await until(`document.querySelector('${scope}.conversation-image-thumb[data-image-index="1"] .conversation-image-error')?.hidden===false`, 'missing thumbnail error');
    evidence.thumbnail = await cdp.eval(`(()=>{const r=document.querySelector(${json(thumb)}).getBoundingClientRect();return {width:r.width,height:r.height}})()`);
    assert(evidence.thumbnail.width <= 114 && evidence.thumbnail.height <= 110);
    await snap('04-small-thumbnails');
    await click(thumb);
    await until('document.querySelector(".preview-image")?.naturalWidth>0', 'existing image preview');
    await snap('05-existing-image-preview');
    await click('#preview-close');
    evidence.checks.push('image IPC reference -> small thumbnail -> existing image preview; missing file retains named error; no image-paste or attachment-replay claim');
    assert.equal(await cdp.eval(`document.querySelectorAll('${scope}.turn-card[data-phase="commentary"] [data-action="regen"],${scope}.turn-card[data-phase="activity"] [data-action="regen"]').length`), 0);
    assert.equal(await cdp.eval(`document.querySelector('${final} .card-actions-menu').open`), false);
    await click(final + ' .card-actions-more');
    await snap('06-more-menu');
    await click(final + ' [data-action="multi-select"]');
    assert.equal(await cdp.eval('document.getElementById("msg-overlay").classList.contains("multi-select-active")'), true);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until('!document.getElementById("msg-overlay").classList.contains("multi-select-active")', 'multi-select Escape');
    await click(final + ' .card-actions-more');
    await click(final + ' [data-action="regen"]');
    await until('document.querySelector("dialog[open] textarea")', 'resend preview');
    assert.equal(await cdp.eval('document.querySelector("dialog[open] textarea").value'), prompt);
    assert.match(await cdp.eval('document.querySelector("dialog[open]").textContent'), new RegExp(session.id));
    await snap('07-resend-preview');
    const before = starts().length;
    await click('dialog[open] [aria-label="关闭详情"]'); await sleep(250);
    assert.equal(starts().length, before, 'cancel sends nothing');
    await click(final + ' .card-actions-more'); await click(final + ' [data-action="regen"]');
    await click('dialog[open] .card-resend-confirm');
    await until(`document.querySelectorAll('${scope}.turn-card[data-phase="final_answer"]').length===2`, 'confirmed resend completes');
    assert.equal(starts().length, before + 1);
    assert.equal(starts().at(-1).params.input[0].text, prompt);
    assert.equal(starts().at(-1).params.input.length, 1, 'preview accurately states text-only resend');
    assert.equal(starts().at(-1).params.threadId, starts()[0].params.threadId, 'card owner retained');
    evidence.checks.push('more menu physically clicked; no regenerate on progress/activity; preview matches exact sent text/owner; cancel sends nothing; confirm sends once');
    await cdp.send('Page.reload');
    await until(`typeof sessions!=='undefined' && sessions.has(${sid})`, 'renderer reload');
    await click(`.session-item[data-session-id="${session.id}"]`); await click('[data-view="card"]');
    await until(`document.querySelectorAll('${scope}.turn-delivery-summary').length===2`, 'history delivery restored');
    assert.equal(await cdp.eval(`[...document.querySelectorAll('${scope}.turn-delivery-summary,${scope}.tc-cluster')].every(e=>!e.open)`), true);
    const restored = await cdp.eval(`[...window._sessionTurns.values()].flatMap(t=>t.toolCalls||[]).filter(t=>t.id.startsWith('long-')).map(t=>({id:t.id,length:t.output.length,tail:t.output.slice(-18)}))`);
    assert.equal(restored.length, 2);
    assert(restored.every(t=>t.length===full.length && t.tail==='END-OF-FULL-OUTPUT'));
    evidence.checks.push('renderer reload restores one delivery per completed turn, source tail preserved, disclosures initially closed');
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; if (error.logTail) evidence.launchLog = error.logTail; throw error; }
  finally {
    if (cdp) {
      try { await snap('last'); evidence.ui = await cdp.eval('document.body.innerText.slice(-12000)'); }
      catch (error) { evidence.captureError = error.message; }
      await cdp.close();
    }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), json(evidence, null, 2));
    console.log(json({ out, passed: evidence.passed, checks: evidence.checks, error: evidence.error }, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
