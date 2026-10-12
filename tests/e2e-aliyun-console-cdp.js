'use strict';
// 隔离 Hub 真机：账号页「阿里云控制台」→ 点登录打开专用浏览器（隔离数据目录、屏幕外不抢焦点）→
// 不登录，检查登录显示未登录 → 命令行 open / text / screenshot 读到阿里云页面。访问真实阿里云网站。
// 运行：node tests/e2e-aliyun-console-cdp.js [截图目录]
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { AliyunConsole } = require('../core/aliyun-console');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  const out = path.resolve(process.argv[2] || path.join('artifacts', 'aliyun-console-cdp'));
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-aliyun-')), data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ proxy: '' }));
  const browser = new AliyunConsole({ dataDir: data, env: { CLAUDE_HUB_DATA_DIR: data } });
  const result = { root, out, checks: [] };
  let hub, cdp, browserPid;
  const until = async (expr, label, ms = 40000) => { for (const end = Date.now() + ms; Date.now() < end;) { if (await cdp.eval('Boolean(' + expr + ')')) { console.log('PASS ' + label); return; } await sleep(200); } throw Error('timeout: ' + label); };
  const click = async selector => {
    await until('!!document.querySelector(' + JSON.stringify(selector) + ') && !document.querySelector(' + JSON.stringify(selector) + ').disabled', 'enabled ' + selector);
    const box = await cdp.eval(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...box });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...box });
  };
  const snap = async name => { const v = await cdp.send('Page.captureScreenshot', { format: 'png' }); const f = path.join(out, name + '.png'); fs.writeFileSync(f, Buffer.from(v.data, 'base64')); return f; };
  const card = '[data-account-service="aliyunConsole"]';
  const cli = (...args) => execFileSync(process.execPath, [path.resolve(__dirname, '../scripts/aliyun-console.js'), ...args, '--data-dir', data], { encoding: 'utf8', windowsHide: true, timeout: 90000 });
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'background', label: 'aliyun-console', extraEnv: { CLAUDE_HUB_AGENT_RUNTIME: 'native', DEEPSEEK_API_KEY: '' } });
    result.hubPid = hub.pid;
    cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 960, deviceScaleFactor: 1, mobile: false });
    await until('typeof accountCenterPanel!=="undefined"', 'renderer initialized');
    await click('#btn-rail-accounts');
    await click('[data-tab="api"]');
    await until(`document.querySelector('${card}')`, 'aliyun console entry listed');
    const text = await cdp.eval(`document.querySelector('${card}').innerText`);
    assert.match(text, /阿里云控制台/); assert.match(text, /阿里云 \/ 百炼控制台（AI 可查看）/); assert.match(text, /还没检查登录/);
    result.checks.push('账号页「API 与服务」里有阿里云控制台，显示用途和「还没检查登录」');
    result.shots = [await snap('01-entry')];
    assert.equal(await browser.endpoint(), null, 'browser not started before the click');

    await click(`${card} [data-operation="open"]`);
    await until('document.querySelector(".ac-status").textContent.includes("支付宝扫码")', 'login hint shown after click', 60000);
    const ep = await browser.endpoint();
    assert.ok(ep, 'dedicated browser exposes a debugging port in the isolated profile');
    let pages = [];
    for (const end = Date.now() + 30000; Date.now() < end; await sleep(500)) { pages = await browser.pages(ep); if (pages.some(p => /aliyun\.com/.test(p.url))) break; }
    assert.ok(pages.some(p => /aliyun\.com/.test(p.url)), 'dedicated browser opened the aliyun console: ' + JSON.stringify(pages.map(p => p.url)));
    browserPid = browser.readState().pid;
    result.browserPid = browserPid; result.profile = browser.profile;
    result.checks.push('点「登录 ↗」用隔离数据目录的专用资料目录启动浏览器，打开 ' + pages.map(p => p.url).join(' '));
    result.shots.push(await snap('02-login-clicked'));

    await click(`${card} [data-operation="check"]`);
    await until(`document.querySelector('${card}').innerText.includes('未登录')`, 'status shows not signed in', 30000);
    assert.match(await cdp.eval('document.querySelector(".ac-status").textContent'), /阿里云控制台：/);
    result.checks.push('不登录时点「检查登录」，状态显示未登录');
    result.shots.push(await snap('03-checked-signed-out'));
    const stored = JSON.parse(fs.readFileSync(path.join(data, 'hub-chrome', 'external-accounts.json'), 'utf8'));
    assert.equal(stored.aliyunConsole.state, 'signed_out');
    assert.ok(!/ticket|cookie.*=/i.test(JSON.stringify(stored)));

    const opened = cli('open', 'https://bailian.console.aliyun.com/cn-beijing/subscription/token-plan/personal');
    assert.match(opened, /注意：专用浏览器还没登录阿里云/); assert.match(opened, /百炼/);
    const read = cli('text', '--max', '3000');
    assert.match(read, /标题：.*百炼/); assert.match(read, /登录/);
    const shot = path.join(out, '04-cli-token-plan.png');
    const shotOut = cli('screenshot', shot);
    assert.match(shotOut, /截图已保存/); assert.ok(fs.statSync(shot).size > 20000);
    const listed = cli('list');
    assert.match(listed, /\[AI\]/);
    result.cli = { open: opened.trim(), textHead: read.split('\n').slice(0, 12).join('\n'), list: listed.trim() };
    result.shots.push(shot);
    result.checks.push('命令行 open / text / screenshot / list 在同一资料目录上读到阿里云页面');
    result.passed = true;
  } finally {
    // 只结束自己开的浏览器：先 CDP 正常退出，仍在就按记录的 PID 结束。
    try { await browser.close(); } catch {}
    if (browserPid) { try { process.kill(browserPid, 0); execFileSync('taskkill', ['/PID', String(browserPid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch {} }
    try { cdp?.close?.(); } catch {}
    if (hub) await gracefulQuit(hub).catch(e => console.error('quit:', e.message));
    fs.writeFileSync(path.join(out, '20261013-aliyun-console-e2e-claude3.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify(result, null, 2));
  }
}
main().catch(e => { console.error('FAIL', e.stack || e.message); process.exitCode = 1; });
