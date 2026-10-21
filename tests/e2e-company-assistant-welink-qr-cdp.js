'use strict';
// v3.1.1 WeLink 扫码二维码端到端（2026-10-22，claude1）：隔离 Hub（后台窗口、独立数据目录与 CDP 端口）+ welink-cli 替身。
// 替身按公司真机 1.0.14 的格式（回执 Q-1021-14）在 stdout 上画半块字符二维码，矩阵是 segno 离线生成的真实二维码
// （tests/fixtures/welink-login-qr.json）。不调用任何 AI：CodeAgent 指向一个立即退出的空脚本。
// 用真鼠标事件依次走：
//   ① 超时：出二维码 → CLI 报超时 → 面板写原因、给「重新获取二维码」；
//   ② 编码不对：点「重新获取二维码」→ 面板提示「二维码显示失败，请用下方链接」，数据目录 company-assistant/diag 下有诊断文件；
//   ③ 正常：再点「重新获取二维码」→ 二维码按原尺寸显示、「等待扫码 · N 秒」；截图后用 OpenCV（python cv2）真实解码，
//      必须解出 qrcode_content；点「在浏览器打开」走 shell.openExternal（桩，不真开）；扫码成功后显示已登录。
// 用法：node tests/e2e-company-assistant-welink-qr-cdp.js [截图目录]
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), net = require('node:net');
const { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = path.resolve(process.argv[2] || path.join(__dirname, '..', 'artifacts'));
const FIX = require('./fixtures/welink-login-qr.json');
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
const j = JSON.stringify;

// 用 OpenCV 的 QRCodeDetector 解码一张 PNG（python 已装 cv2 时）；解不出返回 ''，没有 cv2 返回 null。
const DECODE = `import sys, cv2
img = cv2.imread(sys.argv[1], cv2.IMREAD_GRAYSCALE)
text = cv2.QRCodeDetector().detectAndDecode(img)[0]
sys.stdout.buffer.write(('OK:' + text).encode('utf-8'))`;
function decode(png) {
  const r = spawnSync('python', ['-I', '-c', DECODE, png], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  if (r.status !== 0 || !String(r.stdout).startsWith('OK:')) return null;
  return r.stdout.slice(3);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-welink-qr-'));
  const dataDir = path.join(root, 'data'), state = path.join(root, 'welink-state'), mode = path.join(root, 'welink-login-mode'), log = path.join(root, 'welink-calls.jsonl');
  fs.mkdirSync(dataDir);
  fs.writeFileSync(state, 'expired'); fs.writeFileSync(path.join(root, 'welink-exchange'), 'x@example.com');
  const noAgent = path.join(root, 'no-codeagent.cmd'); fs.writeFileSync(noAgent, '@exit /b 1\r\n');
  const result = { harness: '隔离 Hub + welink-cli 替身（真机输出格式），无 AI', checks: [], shots: [] };
  let hub, c;
  try {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), label: 'ca-welink-qr', windowMode: 'background', extraEnv: {
      CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0',
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), AI_HUB_CODEAGENT_COMMAND: noAgent,
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures', 'welink-cli-standin.js'), WELINK_STANDIN_STATE: state, WELINK_STANDIN_LOG: log, WELINK_STANDIN_PAD: '0' } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await c.eval(expr).catch(() => false)) return; await _waitMs(250); } throw new Error('timeout: ' + label); };
    const click = async selector => {
      const p = await c.eval(`(() => { const e = document.querySelector(${j(selector)}); if (!e) return null; e.scrollIntoView({ block: 'center' }); const r = e.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      assert.ok(p, '找不到：' + selector);
      await c.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p });
      await c.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
      await c.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
    };
    const shot = async (name, clip) => {
      const s = await c.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      const f = path.join(OUT, `20261022-qr-e2e-${name}-claude1.png`); fs.writeFileSync(f, Buffer.from(s.data, 'base64')); result.shots.push(f); return f;
    };
    const panelText = () => c.eval(`document.querySelector('.ca-login')?.innerText || ''`);

    await until(`!!document.getElementById('btn-company-assistant') && typeof sessions !== 'undefined'`, 'boot', 90000);
    await click('#btn-company-assistant');
    await until(`!document.getElementById('company-assistant-page')?.hidden && !!document.querySelector('[data-ca="login"]')`, '扫码登录入口', 60000);

    // ① 超时
    fs.writeFileSync(mode, 'timeout scan=5000');
    await click('[data-ca="login"]');
    await until(`!!document.querySelector('.ca-login img.ca-qr-blocks')`, '二维码（超时轮）', 30000);
    await until(`/登录没成功：QR code login timeout/.test(document.querySelector('.ca-login')?.innerText || '') && !!document.querySelector('.ca-login [data-ca="login"]')`, '超时原因', 30000);
    assert.match(await c.eval(`document.querySelector('.ca-login [data-ca="login"]').innerText`), /重新获取二维码/);
    assert.equal(await c.eval(`document.querySelectorAll('.ca-login img').length`), 0, '超时后旧二维码不再显示');
    await shot('01-timeout');
    result.checks.push('超时：面板写「登录没成功：QR code login timeout, please try again.」，并给「重新获取二维码」按钮');

    // ② 编码不对
    fs.writeFileSync(mode, 'garbled timeout scan=6000');
    await click('.ca-login [data-ca="login"]');
    await until(`/二维码显示失败，请用下方链接/.test(document.querySelector('.ca-login')?.innerText || '')`, '乱码提示', 30000);
    assert.equal(await c.eval(`document.querySelectorAll('.ca-login img').length`), 0, '乱码时不显示图片');
    assert.equal(await c.eval(`!!document.querySelector('.ca-login [data-ca="open-login-url"]')`), true, '乱码时仍有兜底链接');
    const diagDir = path.join(dataDir, 'company-assistant', 'diag');
    const diags = fs.existsSync(diagDir) ? fs.readdirSync(diagDir) : [];
    assert.equal(diags.length, 1, '存了一份诊断');
    const diagText = fs.readFileSync(path.join(diagDir, diags[0]), 'utf8');
    assert.ok(diagText.includes('\uFFFD') && !/[█▀▄]/.test(diagText) && diagText.includes(FIX.url), '诊断文件就是这段乱码输出');
    await shot('02-garbled');
    result.checks.push(`编码不对：面板提示「二维码显示失败，请用下方链接」、不放图片、保留链接；诊断文件 ${path.join(diagDir, diags[0])}`);
    await until(`!!document.querySelector('.ca-login [data-ca="login"]')`, '乱码轮结束', 30000);

    // ③ 正常扫码
    fs.writeFileSync(mode, 'scan=20000');
    await click('.ca-login [data-ca="login"]');
    await until(`(() => { const i = document.querySelector('.ca-login img.ca-qr-blocks'); return !!i && i.complete && i.naturalWidth > 0; })()`, '二维码图片加载', 30000);
    await until(`/等待扫码 · ([2-9]|\\d\\d) 秒/.test(document.querySelector('.ca-login')?.innerText || '')`, '等待秒数', 30000);
    const img = await c.eval(`(() => { const i = document.querySelector('.ca-login img.ca-qr-blocks'); const r = i.getBoundingClientRect();
      return { src: i.getAttribute('src').slice(0, 40), nw: i.naturalWidth, nh: i.naturalHeight, w: r.width, h: r.height, x: r.left, y: r.top,
        httpImgs: [...document.querySelectorAll('.ca-login img')].filter(e => /^https?:/i.test(e.getAttribute('src') || '')).length }; })()`);
    assert.match(img.src, /^data:image\/svg\+xml;base64,/);
    assert.equal(img.httpImgs, 0, '网址没有进 <img>');
    const modules = FIX.size + 2 + 8, cell = img.w / modules;
    // 按 SVG 原尺寸显示（旧样式会压到 220px）；Hub 整页缩放可能带来 1% 以内的差别。
    result.zoom = await c.eval(`({ dpr: devicePixelRatio, ratio: document.querySelector('.ca-login img.ca-qr-blocks').getBoundingClientRect().width / document.querySelector('.ca-login img.ca-qr-blocks').naturalWidth })`);
    assert.ok(Math.abs(img.w - img.nw) / img.nw < 0.03 && img.w === img.h, `按原尺寸显示，不缩放（${img.w}×${img.h}，原 ${img.nw}×${img.nh}）`);
    assert.ok(cell >= 6 && cell <= 8, `每个模块 ${cell}px`);
    const text = await panelText();
    assert.match(text, /用手机 WeLink 扫下面的二维码/); assert.match(text, /二维码扫不出来？在浏览器打开/);
    const full = await shot('03-qr-waiting');
    const crop = await shot('04-qr-only', { x: img.x, y: img.y, width: img.w, height: img.h });
    const decodedCrop = decode(crop), decodedFull = decode(full);
    result.decode = { tool: 'OpenCV cv2.QRCodeDetector（python）', expected: FIX.content, crop: decodedCrop, fullPage: decodedFull };
    assert.notEqual(decodedCrop, null, '本机没有 python cv2，未能真实解码');
    assert.equal(decodedCrop, FIX.content, '二维码截图解出 qrcode_content');
    assert.equal(decodedFull, FIX.content, '整页截图（含面板文字）也能解出 qrcode_content');
    result.checks.push(`二维码：${img.w}×${img.h}px 原尺寸显示（${modules} 模块含 4 模块静区，每模块 ${cell}px），面板显示「${(text.match(/等待扫码 · \d+ 秒/) || [''])[0]}」；OpenCV 从截图解出 ${decodedCrop}`);

    // 「在浏览器打开」：shell.openExternal 用桩接住
    await c.eval(`(() => { const { shell } = require('electron'); window.__opened = []; shell.openExternal = url => { window.__opened.push(url); return Promise.resolve(); }; return true; })()`);
    await click('.ca-login [data-ca="open-login-url"]');
    await until(`window.__opened.length === 1`, 'openExternal', 10000);
    assert.deepEqual(await c.eval(`window.__opened`), [FIX.url]);
    result.checks.push(`点「在浏览器打开」→ shell.openExternal(${FIX.url})（桩，未真的打开）`);

    // 扫码成功 → 「已扫码，正在登录…」→ 已登录
    await until(`/已扫码，正在登录…/.test(document.querySelector('.ca-login')?.innerText || '')`, '已扫码', 40000);
    await shot('05-scanned');
    result.checks.push('收到 Scan successful 后面板显示「已扫码，正在登录…」');
    assert.equal(await c.eval(`document.querySelectorAll('.ca-login img').length`), 0, '扫码成功后不再显示二维码');
    await until(`!document.querySelector('.ca-login') && /在线/.test(document.querySelector('.ca-status')?.innerText || '')`, '登录完成、面板收起', 60000);
    await shot('06-logged-in');
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse);
    result.checks.push(`扫码成功后面板收起、状态转为在线；替身共收到 ${calls.filter(x => x[0] === 'auth' && x[1] === 'login').length} 次 auth login（含自动续期探测）`);
    result.passed = true;
  } finally {
    if (hub) { try { await gracefulQuit(hub); } catch (e) { result.teardownError = e.message; } }
    console.log(JSON.stringify(result, null, 2));
  }
  if (!result.passed) process.exitCode = 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
