'use strict';
// 会议室运行时按需下载（2026-10-22，v3.1.3）：安装包不再带 76.8MB 的秘书终结者。
// 守住四件事：① 多源依次试，校验值来自签名清单；② 下砸了不留半截文件；
// ③ 下过一次就复用；④ 旧安装包自带的副本优先用，不让老用户白下 77MB。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { createHash, randomBytes } = require('node:crypto');
const { createRuntimeDownload, SOURCES } = require('../core/company-assistant/room-runtime-download');
const component = require('../core/company-assistant/room-component');

const sha = buf => createHash('sha256').update(buf).digest('hex');
const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-dl-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const FILE = 'MishuTerminator-2.1.0.exe';
const body = randomBytes(1024 * 1024);
const baseline = { version: '2.1.0', exe: { file: FILE, size: body.length, sha256: sha(body) } };

function serve(t, handler) {
  return new Promise(resolve => {
    let hits = 0;
    const server = http.createServer((req, res) => { hits++; handler(req, res); });
    server.listen(0, '127.0.0.1', () => {
      t.after(() => server.close());
      resolve({ base: `http://127.0.0.1:${server.address().port}`, hits: () => hits });
    });
  });
}
const send = (res, buf) => { res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': buf.length }); res.end(buf); };
const notFound = res => { res.writeHead(404); res.end('nope'); };

test('第一个源没有就换下一个；下完按签名清单核过才落到数据目录，第二次直接用不再联网', async t => {
  const { base, hits } = await serve(t, (req, res) => req.url.startsWith('/mirror/') ? send(res, body) : notFound(res));
  const root = tmp(t);
  const seen = [];
  const dl = createRuntimeDownload({ dataDir: root, baseline, fetchImpl: fetch, onState: s => seen.push(s.phase),
    sources: [{ id: 'github', name: 'GitHub', files: `${base}/v{version}/` }, { id: 'aliyun', name: '阿里云', files: `${base}/mirror/` }] });
  assert.equal(dl.installed(), false);
  const exe = await dl.ensure();
  assert.equal(exe, path.join(root, 'room-runtime', baseline.exe.sha256, FILE));
  assert.equal(sha(fs.readFileSync(exe)), baseline.exe.sha256);
  assert.equal(dl.installed(), true);
  const attempts = dl.status().attempts.map(a => [a.name, a.status]);
  assert.deepEqual(attempts, [['GitHub', 'failed'], ['阿里云', 'ok']]);
  assert.equal(dl.status().phase, 'installed');
  assert.ok(seen.includes('downloading') && seen.includes('installed'));
  const before = hits();
  assert.equal(await dl.ensure(), exe);
  assert.equal(hits(), before, '第二次不再联网');
  assert.equal(dl.status().bytes, body.length);
});

test('源上的文件不对就拒收并换源；都拿不到时写清每个源的原因，不留半截文件', async t => {
  const tampered = Buffer.from(body); tampered[100] ^= 0xff;
  let mode = 'bad';
  const { base } = await serve(t, (req, res) => {
    if (mode === 'bad') send(res, tampered);
    else if (req.url.startsWith('/v2.1.0/')) {
      if (mode === 'down') send(res, body);
      else { res.writeHead(500); res.end('boom'); }
    } else notFound(res);
  });
  const root = tmp(t);
  const sources = [{ id: 'github', name: 'GitHub', files: `${base}/v{version}/` }, { id: 'aliyun', name: '阿里云', files: `${base}/mirror/` }];
  const dl = createRuntimeDownload({ dataDir: root, baseline, fetchImpl: fetch, sources });
  await assert.rejects(dl.ensure(), error => {
    assert.equal(error.code, 'runtime-download-failed');
    assert.match(error.message, /会议室组件没下载成功/);
    assert.match(error.message, /GitHub/); assert.match(error.message, /阿里云/);
    return true;
  });
  const dir = path.join(root, 'room-runtime', baseline.exe.sha256);
  assert.equal(fs.existsSync(dir) && fs.readdirSync(dir).length, 0, '不留下不完整的文件');
  assert.equal(dl.status().phase, 'error');
  assert.equal(dl.installed(), false);

  mode = 'down';
  const retry = createRuntimeDownload({ dataDir: root, baseline, fetchImpl: fetch, sources });
  assert.equal(await retry.ensure(), path.join(root, 'room-runtime', baseline.exe.sha256, FILE), '用户点重试还能成功');
});

test('下载中可以取消，取消后没有文件也不当成失败原因留在状态里', async t => {
  const { base } = await serve(t, (req, res) => {
    res.writeHead(200, { 'content-length': body.length });
    res.write(Buffer.from(body.subarray(0, 4096)));
    setTimeout(() => { try { res.end(Buffer.from(body.subarray(4096))); } catch (_) {} }, 5000);
  });
  const root = tmp(t);
  const dl = createRuntimeDownload({ dataDir: root, baseline, fetchImpl: fetch, sources: [{ id: 'github', name: 'GitHub', files: `${base}/v{version}/` }] });
  const pending = dl.ensure().catch(error => error);
  await new Promise(r => setTimeout(r, 300));
  dl.cancel();
  const error = await pending;
  assert.equal(error.code, 'runtime-download-failed');
  assert.equal(dl.status().phase, 'cancelled');
  assert.equal(dl.installed(), false);
  assert.equal(dl.status().error, '下载已取消');
  // 取消一次不能留下 77MB 的 .part（原来只在「校验不一致」那条路删）。
  const dir = path.join(root, 'room-runtime', baseline.exe.sha256);
  assert.equal(fs.existsSync(dir) ? fs.readdirSync(dir).length : 0, 0, '取消后不留半截文件');
});

test('安装目录里的旧副本对不上签名清单时拒绝启动，也不会悄悄改成下载', async t => {
  const root = tmp(t), dataDir = path.join(root, 'data');
  const bundle = path.join(root, 'bundle');
  fs.mkdirSync(path.join(bundle, 'runtime'), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '../core/company-assistant/room-component/baseline.json'), path.join(bundle, 'baseline.json'));
  const real = JSON.parse(fs.readFileSync(path.join(bundle, 'baseline.json'), 'utf8'));
  const info = component.runtimeInfo({ dir: dataDir }, { bundle });
  assert.equal(info.bytes, real.exe.size);
  assert.equal(info.cached, false);
  assert.equal(info.bundled, false);
  const called = [];
  const fakeDownloader = { ensure: async () => { called.push('ensure'); throw new Error('不该下载'); } };
  const staged = path.join(bundle, 'runtime', real.exe.file);
  fs.writeFileSync(staged, randomBytes(1024));
  await assert.rejects(component.prepareRuntime({ dir: dataDir }, { bundle, downloader: fakeDownloader }), /随包会议室组件校验失败/);
  assert.deepEqual(called, [], '被改过的副本既不能跑，也不该拿它当没下载');
  assert.equal(component.runtimeInfo({ dir: dataDir }, { bundle }).bundled, false, '大小不对的副本不算自带');
});

test('打包后（app.asar）也去找 app.asar.unpacked 下的旧副本，老用户不用重下 77MB', () => {
  const bundle = path.join('C:\\app', 'resources', 'app.asar', 'core', 'company-assistant', 'room-component');
  const paths = component.runtimeSourcePaths(bundle, FILE);
  assert.equal(paths.length, 2);
  assert.ok(paths[0].includes(`app.asar${path.sep}`) && !paths[0].includes('app.asar.unpacked'));
  assert.equal(paths[1], paths[0].replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`));
  assert.ok(paths[1].endsWith(path.join('runtime', FILE)));
  // 开发目录不在 asar 里，只需要一个候选
  assert.deepEqual(component.runtimeSourcePaths(path.join('D:\\w', 'room-component'), FILE).length, 1);
});

test('下载器给的地址是官方公开 release；期望值只认签名清单，地址换了也没用', () => {
  const github = SOURCES.find(s => s.id === 'github');
  assert.match(github.files, /^https:\/\/github\.com\/TianLin0509\/mishu-terminator\/releases\/download\/v\{version\}\/$/);
  const real = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../core/company-assistant/room-component/baseline.json'), 'utf8'));
  assert.equal(real.version, '2.1.0');
  assert.equal(real.exe.file, FILE);
  assert.equal(real.exe.size, 80568759);
  assert.match(real.exe.sha256, /^[0-9a-f]{64}$/);
});

test('本机没有运行时、也没有下载器时照直说：去设置里点下载，不冒充已安装', async t => {
  const root = tmp(t), bundle = path.join(root, 'bundle');
  fs.mkdirSync(bundle);
  fs.copyFileSync(path.resolve(__dirname, '../core/company-assistant/room-component/baseline.json'), path.join(bundle, 'baseline.json'));
  await assert.rejects(component.prepareRuntime({ dir: path.join(root, 'data') }, { bundle }), error => {
    assert.equal(error.code, 'runtime-missing');
    assert.match(error.message, /下载会议室组件/);
    return true;
  });
  assert.equal(component.runtimeInfo({ dir: path.join(root, 'data') }, { bundle }).cached, false);
});
