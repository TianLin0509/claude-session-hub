'use strict';
// Real isolated Hub GUI: the account page shows a site paused by a challenge and a person's
// handoff (core/web-risk-guard.js), and 去验证 goes through the handoff entry. The website open
// itself uses the existing recordOpens fixture; no real website is contacted.
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const guard = require('../core/web-risk-guard');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-risk-gui-')), data = path.join(root, 'data'), home = path.join(root, 'home');
  for (const p of [data, home, path.join(root, 'empty')]) fs.mkdirSync(p, { recursive: true });
  write(path.join(data, 'config.json'), { proxy: '' });
  const chromeRoot = path.join(data, 'hub-chrome');
  write(path.join(chromeRoot, 'last-check.json'), { identities: { main: { account: 'main@example.com', sites: {} }, alt: { account: 'alt@example.com', sites: {} } } });
  // The observed incident: the secondary ChatGPT login challenged automation twice, and a
  // person currently has the browser to complete the check.
  guard.recordChallenge(chromeRoot, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare' });
  guard.releaseSite(chromeRoot, 'alt', 'chatgpt');  // a person cleared it, then automation met it again
  guard.recordChallenge(chromeRoot, { identity: 'alt', site: 'chatgpt', kind: 'cloudflare' });
  const lease = guard.startHandoff(chromeRoot, { identity: 'alt', site: 'chatgpt', by: 'e2e' });
  // The company bridge's last steps as hub-browser-tool.js records them: blocked by a check on
  // the main login 12 minutes ago, fine on the secondary one 5 minutes ago.
  const at = Date.now();
  write(path.join(chromeRoot, 'account-activity', 'main-chatgpt-bridge.json'), { identity: 'main', site: 'chatgpt', source: 'bridge', outcome: 'verification_required', at: at - 12 * 60000, lastSuccessAt: at - 3600000 });
  write(path.join(chromeRoot, 'account-activity', 'alt-chatgpt-bridge.json'), { identity: 'alt', site: 'chatgpt', source: 'bridge', outcome: 'success', at: at - 5 * 60000, lastSuccessAt: at - 5 * 60000 });
  const fixture = path.join(root, 'accounts-fixture.json');
  write(fixture, { recordOpens: true });
  const out = path.resolve('artifacts/web-risk-account-page'); fs.mkdirSync(out, { recursive: true });
  const result = { passed: false, boundary: '真实隔离 Hub GUI、鼠标、DOM、IPC、磁盘记录；打开网站走 recordOpens 夹具，未访问真实网站', checks: [] };
  let hub, cdp;
  const until = async (expr, label, ms = 35000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cdp.eval('Boolean(' + expr + ')')) { console.log('PASS ' + label); return; } await sleep(150); } throw Error('timeout: ' + label); };
  const snap = async name => { const v = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(v.data, 'base64')); };
  const text = sel => cdp.eval(`document.querySelector(${JSON.stringify(sel)})?.innerText||''`);
  const click = async selector => {
    await until('!!document.querySelector(' + JSON.stringify(selector) + ')', 'present ' + selector);
    const box = await cdp.eval(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: 1 });
  };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), windowMode: 'background', label: 'web-risk-accounts', extraEnv: { CLAUDE_HUB_HOME_DIR: home, HUB_ACCOUNTS_FIXTURE: fixture, DEEPSEEK_API_KEY: '',
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty') } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof accountCenterPanel!=="undefined"', 'renderer initialized');
    // Session-first B keeps the directory behind the left hover strip.
    await cdp.send('Input.dispatchMouseEvent', { type:'mouseMoved',x:6,y:240 });
    await sleep(350);
    await click('#btn-rail-accounts');
    await until('document.querySelector(".ac-handoff")', 'handoff banner');
    assert.equal(await cdp.eval('!!document.querySelector(".ac-network")'), false, 'a working network route needs no banner');
    assert.match(await text('.ac-handoff'), /网页工具已暂停并断开/);
    const alt = '.ac-company[data-site="chatgpt"] .ac-account[data-identity="alt"]';
    await until(`document.querySelector('${alt} .ac-usage')?.textContent.includes('自动化暂停到')`, 'paused row');
    assert.match(await text(alt), /正常 · [56] 分钟前同步\s+网页工具遇到网站验证，自动化暂停到 \d\d:\d\d；你自己使用不受影响/);
    assert.match(await text(alt + ' .ac-open'), /打开/);
    const main = '.ac-company[data-site="chatgpt"] .ac-account[data-identity="main"]';
    assert.match(await text(main + ' .ac-usage'), /^正常 · 1 小时前同步\s+1[23] 分钟前 中转遇到网站验证；你自己使用不受影响$/);
    assert.match(await text(main + ' .ac-open'), /打开/);
    assert.equal(await cdp.eval('document.querySelector("#accounts-attention").hidden'), true, 'a verification wall the tools met is no lost login: no badge');
    await snap('01-paused-and-handoff');
    result.checks.push('账号页显示接管横幅；副号 ChatGPT 显示「正常」并注明网页工具暂停、你自己使用不受影响');
    result.checks.push('主号写明「12 分钟前 中转遇到网站验证；你自己使用不受影响」；验证拦截不计红色角标');
    result.checks.push('网络路由正常时不再显示代理横幅');

    guard.endHandoff(chromeRoot, lease.id);
    await until('!document.querySelector(".ac-handoff")', 'banner gone after handoff ends', 20000);
    result.checks.push('接管结束后横幅自动消失（页面 5 秒轮询）');

    await click(alt + ' .ac-open');
    await until('document.querySelector("#account-page")', 'still on account page');
    for (const end = Date.now() + 15000; Date.now() < end && !fs.existsSync(path.join(home, 'accounts-open.jsonl'));) await sleep(200);
    const opened = fs.readFileSync(path.join(home, 'accounts-open.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(opened[0], { identity: 'alt', site: 'chatgpt', url: 'https://chatgpt.com/', browser: 'personal' });
    await snap('02-after-verify-click');
    result.checks.push('点「打开」走打开网站入口（站点暂停中时即人工接管），参数为副号 ChatGPT');
    result.passed = true;
  } finally {
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2));
    try { cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {}
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
