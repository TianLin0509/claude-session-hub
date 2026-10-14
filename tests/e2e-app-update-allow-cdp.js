'use strict';
// 公司版检查更新：阿里云被公司代理拦截时，给出网址让用户手动放行（2026-10-14 用户：打开网页点一下「允许」就通）。
//   node tests/e2e-app-update-allow-cdp.js [--out <截图目录>]
// 把当前工作区按公司目标导出、以源码方式启动；本机 http 服务冒充两个更新源：
//   GitHub 连不上；阿里云在「放行」之前对任何请求都返回 3.5 KB 的拦截网页，放行之后返回正常的版本清单。
//   ① 设置 → 检查更新：阿里云一行写明被拦截，下面出现放行说明、完整网址和三个按钮；
//   ② 点「打开网页放行」：交给系统浏览器打开的正是阿里云被拦截的那个网址（测试里接住，不真开浏览器）；
//   ③ 点「复制网址」：剪贴板里是这个网址（隔离实例用内存剪贴板）；
//   ④ 模拟用户在浏览器里点了「允许」，回来点「重新检查」：阿里云可用、查到新版本，放行说明消失。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), http = require('http'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const argv = process.argv.slice(2);
const out = path.resolve(argv.includes('--out') ? argv[argv.indexOf('--out') + 1] : path.join('artifacts', '20261014-aliyun-allow-claude1'));
const repo = path.resolve(__dirname, '..');
const j = JSON.stringify;
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

async function main() {
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-update-allow-'));
  const exportDir = path.join(root, 'export'), dataDir = path.join(root, 'data');
  execFileSync(process.execPath, [path.join(repo, 'scripts', 'community', 'export-community.js'), '--target', 'company', '--ref', 'WORKTREE', '--out', exportDir], { cwd: repo, stdio: 'ignore' });
  execFileSync('cmd.exe', ['/c', 'mklink', '/J', path.join(exportDir, 'node_modules'), path.join(repo, 'node_modules')], { stdio: 'ignore' });
  const current = JSON.parse(fs.readFileSync(path.join(exportDir, 'community-edition.json'), 'utf8')).version;
  const next = current.split('.').map((x, i) => (i === 2 ? String(Number(x) + 1) : x)).join('.');

  let allowed = false;
  const interceptPage = '<!DOCTYPE html><html><head><title>访问提示</title></head><body>' + '该网站需要确认后访问。<button>允许</button>'.repeat(60) + '</body></html>';
  const server = http.createServer((req, res) => {
    if (req.url === '/allow') { allowed = true; res.writeHead(200); res.end('ok'); return; }
    if (!allowed) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(interceptPage); return; }
    if (/\/latest\.json$/.test(req.url)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(j({ schema: 1, product: 'AI HUB-Huawei', version: next, publishedAt: new Date().toISOString(), notes: [`v${next} 的更新说明`],
        runtime: { electron: '0.0.0', native: {} }, incremental: { file: 'AIHubHuawei-x-update.gz', bytes: 1024, sha256: '0'.repeat(64) },
        installer: { file: 'AIHubHuawei-Setup-x.exe', bytes: 2048, sha256: '1'.repeat(64) } }));
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const aliyunManifest = `${base}/hub-update/company/latest.json`;
  const sources = [{ id: 'github', name: 'GitHub', manifest: 'http://127.0.0.1:9/latest.json', files: 'http://127.0.0.1:9/' },
    { id: 'aliyun', name: '阿里云', manifest: aliyunManifest, files: `${base}/hub-update/company/v{version}/` }];

  const result = { checks: [], passed: false, current };
  const check = (ok, label) => { assert.ok(ok, label); result.checks.push(label); console.log('  ✓ ' + label); };
  let hub = null, c = null;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { try { if (await c.eval(expr)) return; } catch (_) {} await _waitMs(250); } throw Error('timeout: ' + label); };
  const shot = async name => { const s = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    const p = await c.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing control: '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
    for (const type of ['mousePressed', 'mouseReleased']) await c.send('Input.dispatchMouseEvent', { type, ...p, button: 'left', clickCount: 1 });
    await _waitMs(300);
  };
  const dialogText = `document.querySelector('dialog.app-update-dialog[open]')?.innerText || ''`;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'update-allow', windowMode: 'hidden', entryPath: exportDir,
      extraEnv: { CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', AI_HUB_UPDATE_SOURCES: j(sources), AI_HUB_UPDATE_STARTUP_DELAY_MS: '600000',
        AI_HUB_RULES_BASE_URL: 'http://127.0.0.1:9/hub-rules/' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until('typeof sessions !== "undefined" && !!window.__appUpdate', 'renderer', 90000);
    // 系统浏览器在测试里接住：记下要打开的网址，不真开。
    await c.eval(`(()=>{const { shell } = require('electron'); window.__opened = []; shell.openExternal = url => { window.__opened.push(url); return Promise.resolve(); }; return true;})()`);

    // ① 设置 → 检查更新
    await click('#btn-options');
    await until(`getComputedStyle(document.getElementById('options-menu')).display !== 'none'`, 'menu', 10000);
    await click('#options-check-update');
    await until(`!!document.querySelector('dialog.app-update-dialog[open] .au-allow')`, 'allow box', 30000);
    const text = await c.eval(dialogText);
    result.blockedText = text;
    check(/阿里云.*拦截/.test(text), '阿里云一行写明被公司代理拦截');
    check(text.includes('「阿里云」被公司网络拦截了，可以手动放行') && text.includes('点「允许」') && text.includes('重新检查'), '下面出现放行说明（打开网页 → 点允许 → 重新检查）');
    check(await c.eval(`document.querySelector('.au-allow-url').textContent === ${j(aliyunManifest)}`), `完整网址可见：${aliyunManifest}`);
    await shot('01-blocked');
    check(await c.eval(`(()=>{const b=document.getElementById('hub-edition-badge');return b.textContent==='内测先锋版'&&!b.classList.contains('has-update');})()`), '没查到新版本时，左上角仍是「内测先锋版」');

    // ② 打开网页放行
    await click('.au-allow [data-au="allow-open"]');
    check(j(await c.eval('window.__opened')) === j([aliyunManifest]), '点「打开网页放行」：交给系统浏览器打开的正是被拦截的网址');

    // ③ 复制网址
    await click('.au-allow [data-au="allow-copy"]');
    const copied = await c.eval(`require('electron').clipboard.readText()`);
    check(copied === aliyunManifest && await c.eval(`document.querySelector('.au-allow [data-au="allow-copy"]').textContent === '已复制'`), '点「复制网址」：剪贴板里是这个网址，按钮变成「已复制」');

    // ④ 用户在浏览器里点了「允许」→ 回来重新检查
    await new Promise((resolve, reject) => http.get(`${base}/allow`, r => { r.resume(); r.on('end', resolve); }).on('error', reject));
    await click('.au-allow [data-au="retry"]');
    await until(`window.__appUpdate.state()?.latest?.version === ${j(next)}`, 'rechecked', 30000);
    await until(`!document.querySelector('dialog.app-update-dialog[open] .au-allow')`, 'allow box gone', 10000);
    const after = await c.eval(dialogText);
    check(after.includes(`可用，最新 v${next}`) && after.includes(`v${next} 的更新说明`), `放行后点「重新检查」：阿里云可用，查到新版本 v${next}，放行说明消失`);
    await shot('02-after-allow');
    // 左上角标签：有新版本 + 绿色呼吸圆点，点它打开更新窗（2026-10-14 用户）
    const badge = await c.eval(`(()=>{const b=document.getElementById('hub-edition-badge');const dot=getComputedStyle(b,'::before');return {text:b.textContent,cls:b.classList.contains('has-update'),dot:dot.backgroundColor,anim:dot.animationName,reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,color:getComputedStyle(b).color};})()`);
    result.badge = badge;
    check(badge.text === `有新版本 v${next}` && badge.cls && badge.dot === 'rgb(34, 197, 94)' && badge.anim === (badge.reduced ? 'none' : 'hub-update-pulse'),
      `左上角标签变成「有新版本 v${next}」，带绿色圆点（${badge.reduced ? '系统关了动画效果，圆点不闪' : '呼吸闪动'}）`);
    await click('dialog.app-update-dialog [data-au="close"]');
    await until(`!document.querySelector('dialog.app-update-dialog[open]')`, 'dialog closed', 5000);
    const box = await c.eval(`(()=>{const r=document.getElementById('hub-edition-badge').getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height};})()`);
    const shotBadge = await c.send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, box.x - 260), y: Math.max(0, box.y - 12), width: box.w + 300, height: box.h + 24, scale: 2 } });
    fs.writeFileSync(path.join(out, '03-badge.png'), Buffer.from(shotBadge.data, 'base64'));
    await click('#hub-edition-badge');
    await until(`!!document.querySelector('dialog.app-update-dialog[open]')`, 'dialog from badge', 5000);
    check(true, '点左上角标签打开更新窗');
    result.passed = true;
  } catch (error) {
    result.error = error && error.stack || String(error);
    if (c) { try { await shot('fail'); result.screen = await c.eval(dialogText); } catch (_) {} }
  } finally {
    try { c && c.close(); } catch (_) {}
    if (hub) await gracefulQuit(hub).catch(() => {});
    server.close();
    try { execFileSync('cmd.exe', ['/c', 'rmdir', path.join(exportDir, 'node_modules')], { stdio: 'ignore' }); } catch (_) {}
    if (!fs.existsSync(path.join(exportDir, 'node_modules'))) { try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {} }
    fs.writeFileSync(path.join(out, 'result.json'), j(result, null, 2));
    console.log(j({ passed: result.passed, checks: result.checks, error: result.error }, null, 2));
    if (!result.passed) process.exitCode = 1;
  }
}
main();
