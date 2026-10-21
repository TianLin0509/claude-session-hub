'use strict';
// v3.1.1 WeLink 扫码二维码（2026-10-22）：真机 welink-cli 1.0.14 在 stdout 上用半块字符画二维码（公司回执 Q-1021-14）。
// 这里验收：字符画 → 矩阵逐位还原；半个框不算；框和网址同时出现选字符画；只有网址时不当图片；
// 编码不对时存诊断；等待/已扫码/超时的进度；自动续期与手动扫码共用识别。
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { PassThrough } = require('node:stream');
const { EventEmitter } = require('node:events');
const W = require('../core/company-assistant/welink');
const { needsScan, AuthKeeper, RETRY_MS } = require('../core/company-assistant/auth-keeper');
const { CompanyAssistant } = require('../core/company-assistant/service');

// fixture：segno 离线生成的真实二维码（版本 4，33×33，奇数行）。
const FIX = require('./fixtures/welink-login-qr.json');
const MATRIX = FIX.rows.map(r => [...r].map(c => c === '1'));
// 测试自己按回执的规则画字符画（不借用被测代码）：█ 上下黑，▀ 上黑，▄ 下黑，空格都白。
function art(matrix) {
  const w = matrix[0].length, lines = [];
  for (let y = 0; y < matrix.length; y += 2) {
    let s = '';
    for (let x = 0; x < w; x++) { const t = matrix[y][x], b = y + 1 < matrix.length && matrix[y + 1][x]; s += t && b ? '█' : t ? '▀' : b ? '▄' : ' '; }
    lines.push('|' + s + '|');
  }
  const border = '+' + '-'.repeat(w) + '+';
  return [border, ...lines, border].join('\n');
}
const pad = (m, k) => Array.from({ length: m.length + 2 * k }, (_, y) => Array.from({ length: m[0].length + 2 * k }, (_, x) => !!m[y - k]?.[x - k]));
const realOutput = (box, url = FIX.url) => `Obtaining QR code...\n     WeLink QR Code Login\n\nPlease scan QR code below with WeLink mobile app:\n\n${box}\n\nIf QR code is not displayed correctly, open this URL to scan:\n${url}\n\nWaiting for scan...\n`;

test('字符画逐位还原成原矩阵：奇数行、最后一行只用 ▀，行尾空格不丢', () => {
  const box = art(MATRIX), lines = box.split('\n');
  assert.equal(MATRIX.length % 2, 1, 'fixture 是奇数行');
  assert.match(lines[lines.length - 2], /^\|[▀ ]+\|$/, '最后一行字符只用 ▀ 和空格');
  assert.deepEqual(W.qrMatrixFromBlocks(realOutput(box)), MATRIX);
  // 四周带白边（行首行尾都是空格，最后一行是全白的上半行 + 补的下半行）也逐位相等
  const padded = pad(MATRIX, 1), paddedBox = art(padded);
  assert.match(paddedBox.split('\n')[1], / \|$/, '行尾是空格');
  assert.deepEqual(W.qrMatrixFromBlocks(realOutput(paddedBox)), padded);
  // 偶数行（最后一行带 ▄/█）不被误删
  const even = pad(MATRIX, 0).concat([MATRIX[0]]).map(r => r.slice()); even.forEach(r => r.push(false));
  assert.deepEqual(W.qrMatrixFromBlocks(art(even)), even);
  // 被测代码自己的画法与解析互逆
  assert.deepEqual(W.qrMatrixFromBlocks(W.qrBlocksFromMatrix(MATRIX)), MATRIX);
  assert.equal(W.qrBlocksFromMatrix(MATRIX), box);
});

test('流式输出只到半个框、行宽不齐、太小或有认不得的字符：都当没找到', () => {
  const lines = realOutput(art(MATRIX)).split('\n');
  const cut = lines.findIndex(l => l.startsWith('+')) + 9;
  const half = lines.slice(0, cut).join('\n');
  assert.equal(W.qrMatrixFromBlocks(half), null);
  assert.equal(W.qrFromLoginOutput(half), null, '半个框、还没有网址：什么都不显示');
  const box = art(MATRIX).split('\n');
  const ragged = [...box]; ragged[3] = ragged[3].slice(0, -2) + '|';
  assert.equal(W.qrMatrixFromBlocks(ragged.join('\n')), null);
  const tiny = MATRIX.slice(0, 19).map(r => r.slice(0, 19));
  assert.equal(W.qrMatrixFromBlocks(art(tiny)), null, '小于 21×21');
  const odd = [...box]; odd[4] = odd[4].replace('█', '#');
  assert.equal(W.qrMatrixFromBlocks(odd.join('\n')), null);
});

test('二维码刷新出了多个框：以最后一个完整的为准；新框只到一半时仍用上一个', () => {
  const second = MATRIX.map(r => r.map((v, x) => (x === 10 ? !v : v)));
  const two = realOutput(art(MATRIX)) + 'QR code refreshed\n' + realOutput(art(second));
  assert.deepEqual(W.qrMatrixFromBlocks(two), second);
  const streaming = realOutput(art(MATRIX)) + art(second).split('\n').slice(0, 6).join('\n');
  assert.deepEqual(W.qrMatrixFromBlocks(streaming), MATRIX);
});

test('框和网址同时出现选 blocks，转成白底黑块、留 4 模块静区的 SVG data 地址', () => {
  const qr = W.qrFromLoginOutput(realOutput(art(MATRIX)));
  assert.equal(qr.kind, 'blocks');
  assert.match(qr.value, /^data:image\/svg\+xml;base64,/);
  const svg = Buffer.from(qr.value.split(',')[1], 'base64').toString('utf8');
  assert.match(svg, /shape-rendering="crispEdges"/);
  assert.match(svg, /fill="#fff"/); assert.match(svg, /fill="#000"/);
  const cell = 7, side = (MATRIX.length + 8) * cell;
  assert.equal(qr.px, side); assert.equal(qr.modules, MATRIX.length);
  assert.match(svg, new RegExp(`width="${side}" height="${side}"`));
  // 把 SVG 的黑块按模块格子重新铺回去，和原矩阵逐位相等（静区全白）
  const back = Array.from({ length: MATRIX.length + 8 }, () => Array(MATRIX.length + 8).fill(false));
  for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v7h-\d+z/g))
    for (let i = 0; i < Number(w) / cell; i++) back[Number(y) / cell][Number(x) / cell + i] = true;
  assert.deepEqual(back, pad(MATRIX, 4));
  assert.equal(W.loginUrlFromOutput(realOutput(art(MATRIX))), FIX.url);
});

test('只有网址时：识别为 url，但扫码面板不放进 <img>，只当兜底链接', async t => {
  const onlyUrl = `If QR code is not displayed correctly, open this URL to scan:\n${FIX.url}\n`;
  assert.equal(W.qrFromLoginOutput(onlyUrl).kind, 'url');
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qr-url-')), noTimer: true, noTools: true,
    welinkRun: (args, opts) => {
      if (args[1] !== 'login') return Promise.resolve({ code: 0, stdout: 'User Token: EXPIRED', stderr: '' });
      opts.onData(onlyUrl);
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'WELINK_ABORTED' }))));
    } });
  t.after(() => a.close());
  void a.login();
  await new Promise(r => setTimeout(r, 30));
  assert.equal(a.loginFlow.qr, null);
  assert.equal(a.loginFlow.url, FIX.url);
  // http（非 https）不收作链接
  assert.equal(W.loginUrlFromOutput('open this URL to scan:\nhttp://plain.example.invalid/x\n'), null);
  // 页面：只有 blocks / data / file 能进 <img>；链接走 openExternal 且只认 https
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  const panel = page.slice(page.indexOf('function loginPanel'), page.indexOf('function setupCard'));
  assert.doesNotMatch(panel, /kind === 'url'/);
  assert.match(panel, /二维码扫不出来？<button[^>]*data-ca="open-login-url"[^>]*>在浏览器打开<\/button>/);
  assert.match(page, /verb === 'open-login-url'[^\n]*\/\^https:\\\/\\\/\/i\.test\(url\)[^\n]*shell\.openExternal\(url\)/);
});

test('手动扫码：输出按真机格式流式到达，面板拿到二维码、链接、等待秒数；扫码成功后显示已扫码', async t => {
  let feed;
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qr-flow-')), noTimer: true, noTools: true,
    welinkRun: (args, opts) => {
      if (args[1] !== 'login') return Promise.resolve({ code: 0, stdout: 'User Token: EXPIRED', stderr: '' });
      feed = opts.onData;
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'WELINK_ABORTED' }))));
    } });
  t.after(() => a.close());
  void a.login();
  await new Promise(r => setTimeout(r, 30));
  const full = realOutput(art(pad(MATRIX, 1)));
  feed(full.slice(0, full.indexOf('|') + 50));
  assert.equal(a.loginFlow.qr, null, '框只到一半');
  assert.equal(a.loginFlow.progress.phase, 'obtaining');
  let text = full + '\rWaiting for scan... (elapsed 1 seconds)\rWaiting for scan... (elapsed 12 seconds)';
  feed(text);
  assert.equal(a.loginFlow.qr.kind, 'blocks');
  assert.equal(a.loginFlow.url, FIX.url);
  assert.deepEqual(a.loginFlow.progress, { phase: 'waiting', elapsed: 12, reason: '' });
  text += '\nScan successful! Obtaining login credentials...\n';
  feed(text);
  assert.equal(a.loginFlow.progress.phase, 'scanned');
  assert.equal(a.loginFlow.qr.kind, 'blocks', '二维码保留');
});

test('超时或失败：给出原因；「重新获取二维码」会先结束卡住的那次再开新的', async t => {
  assert.deepEqual(W.loginProgress(realOutput(art(MATRIX)) + '\rWaiting for scan... (elapsed 120 seconds)\nQR code login timeout, please try again.\n'),
    { phase: 'failed', elapsed: 120, reason: 'QR code login timeout, please try again.' });
  assert.equal(W.loginProgress('Scan failed: user cancelled').phase, 'failed');
  assert.equal(W.loginProgress(realOutput(art(MATRIX))).phase, 'waiting', '网址那几行不算失败');
  // 手动登录（5 分钟超时）和自动续期（失败后刷新会顺带查一次登录，见到二维码立刻停）分开计数。
  let logins = 0, feeds = [];
  const aborted = () => Object.assign(new Error('stopped'), { code: 'WELINK_ABORTED' });
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qr-fail-')), noTimer: true, noTools: true,
    welinkRun: (args, opts) => {
      if (args[1] !== 'login') return Promise.resolve({ code: 0, stdout: 'User Token: EXPIRED', stderr: '' });
      if (opts.timeoutMs !== 5 * 60000) { opts.onData(realOutput(art(MATRIX))); return Promise.reject(aborted()); }
      logins++; feeds.push(opts.onData);
      if (logins === 1) opts.onData(realOutput(art(MATRIX)));
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(aborted())));
    } });
  t.after(() => a.close());
  await a.login();
  feeds[0](realOutput(art(MATRIX)) + '\nQR code login timeout, please try again.\n');
  assert.equal(a.loginFlow.state, 'waiting'); assert.equal(a.loginFlow.progress.phase, 'failed');
  void a.login();
  for (let i = 0; i < 100 && logins < 2; i++) await new Promise(r => setTimeout(r, 20));
  assert.equal(logins, 2, '卡住的那次已结束，开了新的一次');
  assert.equal(a.loginFlow.state, 'waiting'); assert.equal(a.loginFlow.qr, null, '新的一次从空白开始');
  feeds[1](realOutput(art(MATRIX)));
  assert.equal(a.loginFlow.qr.kind, 'blocks');
  await a.login();
  assert.equal(logins, 2, '正常等待中不重复开');
});

test('登录命令结束、核对后仍没登录：转成失败并给原因（面板才有「重新获取二维码」），CLI 自己报的原因优先', async t => {
  for (const [tail, code, reason] of [['Scan successful! Obtaining login credentials...\n', 0, null], ['QR code login timeout, please try again.\n', 1, 'QR code login timeout, please try again.']]) {
    const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qr-end-')), noTimer: true, noTools: true,
      welinkRun: async args => args[1] === 'login' ? { code, stdout: realOutput(art(MATRIX)) + tail, stderr: '' } : { code: 0, stdout: 'User Token: EXPIRED', stderr: '' } });
    t.after(() => a.close());
    await a.login();
    for (let i = 0; i < 100 && a.loginFlow.state !== 'failed'; i++) await new Promise(r => setTimeout(r, 20));
    assert.equal(a.loginFlow.state, 'failed');
    assert.match(a.loginFlow.error, /没查到已登录/);
    assert.equal(a.loginFlow.progress.phase, reason ? 'failed' : 'scanned');
    if (reason) assert.equal(a.loginFlow.progress.reason, reason);
  }
  const page = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'company-assistant-page.js'), 'utf8');
  assert.match(page, /const reason = p\.phase === 'failed' \? p\.reason : f\.error;/);
});

test('编码不对（不含 █▀▄ 却有乱码）：存一份诊断到数据目录 company-assistant/diag，面板提示改用链接', async t => {
  const box = art(pad(MATRIX, 1));
  const gbk = Buffer.concat([...box].map(ch => ({ '█': Buffer.from('a880', 'hex'), '▀': Buffer.from('81379932', 'hex'), '▄': Buffer.from('a87b', 'hex') }[ch] || Buffer.from(ch)))).toString('utf8');
  assert.equal(W.loginOutputGarbled(realOutput(gbk)), true);
  assert.equal(W.loginOutputGarbled(realOutput(box.replace(/[█▀▄]/g, '?'))), true, '代码页把字换成 ? 也算');
  assert.equal(W.loginOutputGarbled(realOutput(box)), false);
  assert.equal(W.loginOutputGarbled('Obtaining QR code...'), false);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-qr-garbled-'));
  let feed;
  const a = new CompanyAssistant({ dataDir, noTimer: true, noTools: true,
    welinkRun: (args, opts) => {
      if (args[1] !== 'login') return Promise.resolve({ code: 0, stdout: 'User Token: EXPIRED', stderr: '' });
      feed = opts.onData;
      return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'WELINK_ABORTED' }))));
    } });
  t.after(() => a.close());
  void a.login();
  await new Promise(r => setTimeout(r, 30));
  const out = realOutput(gbk);
  feed(out); feed(out + '\rWaiting for scan... (elapsed 3 seconds)');
  assert.equal(a.loginFlow.garbled, true); assert.equal(a.loginFlow.qr, null); assert.equal(a.loginFlow.url, FIX.url);
  const dir = path.join(dataDir, 'company-assistant', 'diag');
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 1, '一次登录只存一份'); assert.match(files[0], /^\d{8}-\d{6}-welink-login-output\.txt$/);
  assert.equal(fs.readFileSync(path.join(dir, files[0]), 'utf8'), out);
});

test('子进程输出按 UTF-8 拼字：█ 的 3 个字节被拆在两块里也不乱码', async () => {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.kill = () => {};
  const seen = [];
  const pending = W.run(['auth', 'login'], { cli: 'fixture.exe', allowSetup: true, spawnFn: () => child, onData: t => seen.push(t) });
  const bytes = Buffer.from('|█▀▄ |\n', 'utf8');
  child.stdout.write(bytes.subarray(0, 2)); child.stdout.write(bytes.subarray(2, 5)); child.stdout.write(bytes.subarray(5));
  await new Promise(r => setImmediate(r));
  child.emit('close', 0);
  const r = await pending;
  assert.equal(r.stdout, '|█▀▄ |\n');
  assert.ok(seen.every(t => !t.includes('�')));
});

test('自动续期与手动扫码共用识别：真机字符画、固定提示行都算要扫码，框没画完也能停下', async () => {
  const full = realOutput(art(MATRIX));
  for (const text of [full, 'Obtaining QR code...', '     WeLink QR Code Login', 'Please scan QR code below with WeLink mobile app:', 'Waiting for scan...', art(MATRIX).split('\n').slice(0, 3).join('\n')]) {
    assert.equal(needsScan(text), true, text.slice(0, 60));
    assert.equal(needsScan(text), W.loginNeedsScan(text));
  }
  assert.equal(needsScan('Credentials cached.'), false);
  assert.equal(needsScan('Login successful.'), false);
  // 自动续期一看到字符画就结束登录并计一次扫码，连续两次转「需要扫码」
  let now = 10000000; const notices = [];
  const k = new AuthKeeper({ now: () => now, read: () => ({}), write() {}, changed() {}, refresh: async () => {}, publish: n => { notices.push(n); return true; },
    rawWelink: async (args, opts) => {
      if (args[1] === 'status') return { code: 0, stdout: 'User Token: EXPIRED', stderr: '' };
      opts.onData(full); assert.equal(opts.signal.aborted, true);
      throw Object.assign(new Error('aborted'), { code: 'WELINK_ABORTED' });
    } });
  await k.check(); assert.equal(k.status().scanAttempts, 1);
  now += RETRY_MS + 1; await k.check();
  assert.equal(k.status().state, 'needs-scan'); assert.equal(notices.length, 1);
});
