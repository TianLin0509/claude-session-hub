'use strict';
// 公司版一键更新（2026-10-13）：清单校验、更新方式判定、增量包打包/解包、多源下载切换、替换脚本与回滚。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { spawnSync } = require('node:child_process');
const { validateManifest, planUpdate, compareVersions, currentRuntime } = require('../core/app-update/manifest');
const { packPayload, unpackPayload, sha256 } = require('../core/app-update/payload');
const { checkManifests, downloadWithFallback } = require('../core/app-update/downloader');
const { stageIncremental, stagingPaths, takeLastResult } = require('../core/app-update/apply');

const tmp = t => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-app-update-')); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
const SHA = 'a'.repeat(64);
const manifest = (over = {}) => ({ schema: 1, version: '1.0.1', notes: ['改名'], runtime: { electron: '41.2.0', native: { 'node-pty': '1.1.0' } },
  incremental: { file: 'AIHubCommunity-1.0.1-update.gz', bytes: 7467767, sha256: SHA }, installer: { file: 'AIHubCommunity-Setup-1.0.1.exe', bytes: 94000000, sha256: SHA }, ...over });

test('清单校验：格式、版本号、文件名、大小、校验值都要合规', () => {
  assert.equal(validateManifest(manifest()).version, '1.0.1');
  assert.throws(() => validateManifest({ ...manifest(), schema: 2 }), /格式不认识/);
  assert.throws(() => validateManifest(manifest({ version: '1.0' })), /版本号无效/);
  assert.throws(() => validateManifest(manifest({ installer: { file: '../x.exe', bytes: 9999, sha256: SHA } })), /文件名不合规/);
  assert.throws(() => validateManifest(manifest({ incremental: { file: 'a.gz', bytes: 10, sha256: SHA } })), /大小不在允许范围/);
  assert.throws(() => validateManifest(manifest({ installer: { file: 'a.exe', bytes: 99999, sha256: 'x' } })), /校验值无效/);
  assert.throws(() => validateManifest(manifest({ runtime: {} })), /运行时信息/);
  assert.equal(compareVersions('1.0.10', '1.0.9'), 1);
});

test('更新方式：同运行时走增量；Electron 或原生依赖变了走完整安装包；不比本机新就不更新', () => {
  const m = validateManifest(manifest());
  const rt = { electron: '41.2.0', native: { 'node-pty': '1.1.0' } };
  assert.equal(planUpdate(m, { version: '1.0.0', runtime: rt }).kind, 'incremental');
  assert.equal(planUpdate(m, { version: '1.0.1', runtime: rt }).kind, 'none');
  assert.equal(planUpdate(m, { version: '1.0.2', runtime: rt }).kind, 'none');
  const e = planUpdate(m, { version: '1.0.0', runtime: { ...rt, electron: '40.0.0' } });
  assert.equal(e.kind, 'full'); assert.match(e.reason, /Electron 40\.0\.0 升到 41\.2\.0/);
  assert.equal(planUpdate(m, { version: '1.0.0', runtime: { electron: '41.2.0', native: { 'node-pty': '1.0.0' } } }).kind, 'full');
  assert.equal(planUpdate(validateManifest(manifest({ incremental: null })), { version: '1.0.0', runtime: rt }).kind, 'full');
});

function fakeResources(root, asarText, extra = {}) {
  const res = path.join(root, 'resources');
  fs.mkdirSync(path.join(res, 'app.asar.unpacked', 'core'), { recursive: true });
  fs.mkdirSync(path.join(res, 'app.asar.unpacked', 'node_modules', 'node-pty'), { recursive: true });
  fs.writeFileSync(path.join(res, 'app.asar'), asarText);
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'core', 'settings.json'), extra.settings || '{"v":1}');
  fs.writeFileSync(path.join(res, 'app.asar.unpacked', 'node_modules', 'node-pty', 'package.json'), '{"version":"1.1.0"}');
  return res;
}

test('增量包：只装 app.asar 和非依赖的解包文件，解包逐个核对', t => {
  const root = tmp(t);
  const res = fakeResources(root, 'NEW-ASAR'.repeat(1000));
  const out = path.join(root, 'u.gz');
  const packed = packPayload(res, out);
  assert.deepEqual(packed.files.map(f => f.path), ['app.asar', 'app.asar.unpacked/core/settings.json']);
  assert.equal(packed.sha256, sha256(fs.readFileSync(out)));
  const dest = path.join(root, 'new');
  unpackPayload(out, dest);
  assert.equal(fs.readFileSync(path.join(dest, 'app.asar'), 'utf8'), 'NEW-ASAR'.repeat(1000));
  assert.deepEqual(currentRuntime({ resourcesPath: res, electron: '41.2.0' }), { electron: '41.2.0', native: { 'node-pty': '1.1.0' } });
  // 篡改：目录里写了 ../ 路径
  const zlib = require('node:zlib');
  const evil = zlib.gzipSync(Buffer.concat([Buffer.from(JSON.stringify({ schema: 1, files: [{ path: 'app.asar', bytes: 1, sha256: sha256(Buffer.from('x')) }, { path: '../evil', bytes: 1, sha256: sha256(Buffer.from('y')) }] }) + '\n'), Buffer.from('xy')]));
  fs.writeFileSync(out, evil);
  assert.throws(() => unpackPayload(out, path.join(root, 'evil')), /不允许的文件/);
});

function serve(t, routes) {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      const route = routes[req.url];
      if (!route) { res.writeHead(404); res.end('nope'); return; }
      route(req, res);
    });
    server.listen(0, '127.0.0.1', () => { t.after(() => server.close()); resolve(`http://127.0.0.1:${server.address().port}`); });
  });
}

test('多源下载：拦截页、404、校验不符、超时各自写明原因并换下一个源；全部失败如实报告', async t => {
  const body = Buffer.alloc(200 * 1024, 7);
  const expect = { file: 'pkg.gz', bytes: body.length, sha256: sha256(body) };
  const blockPage = Buffer.from('<!DOCTYPE html><html><body>Access denied by proxy</body></html>' + ' '.repeat(3400));
  const base = await serve(t, {
    '/block/v1.0.1/pkg.gz': (q, r) => { r.writeHead(200, { 'content-type': 'text/html', 'content-length': blockPage.length }); r.end(blockPage); },
    '/bad/v1.0.1/pkg.gz': (q, r) => { const b = Buffer.from(body); b[5] = 1; r.writeHead(200, { 'content-length': b.length }); r.end(b); },
    '/slow/v1.0.1/pkg.gz': (q, r) => { r.writeHead(200, { 'content-length': body.length }); r.write(body.subarray(0, 1000)); },
    '/good/v1.0.1/pkg.gz': (q, r) => { r.writeHead(200, { 'content-length': body.length }); r.end(body); },
  });
  const src = (id, dir) => ({ id, name: id, files: `${base}/${dir}/v{version}/` });
  const root = tmp(t);
  const dest = path.join(root, 'pkg.gz');
  const progress = [];
  const r = await downloadWithFallback({ sources: [src('block', 'block'), src('missing', 'missing'), src('bad', 'bad'), src('slow', 'slow'), src('good', 'good')],
    version: '1.0.1', expect, dest, fetchImpl: fetch, idleTimeoutMs: 800, onProgress: p => progress.push(p) });
  assert.equal(r.ok, true);
  assert.equal(r.source.id, 'good');
  const reasons = Object.fromEntries(r.attempts.map(a => [a.id, a.reason || a.status]));
  assert.match(reasons.block, /收到 3\.\d KB 的网页而不是更新包，可能被公司代理拦截/);
  assert.match(reasons.missing, /HTTP 404/);
  assert.match(reasons.bad, /校验不一致/);
  assert.match(reasons.slow, /连续 1 秒没有收到数据/);
  assert.equal(reasons.good, 'ok');
  assert.ok(fs.readFileSync(dest).equals(body));
  assert.ok(progress.some(p => p.sourceId === 'good' && p.received === body.length));
  assert.equal(fs.existsSync(dest + '.part'), false);

  const none = await downloadWithFallback({ sources: [src('block', 'block'), src('missing', 'missing')], version: '1.0.1', expect, dest: path.join(root, 'x.gz'), fetchImpl: fetch });
  assert.equal(none.ok, false);
  assert.equal(none.attempts.length, 2);
  assert.equal(fs.existsSync(path.join(root, 'x.gz')), false);
});

test('查版本：两个源并行，拦截页和坏清单写明原因', async t => {
  const good = JSON.stringify(manifest());
  const base = await serve(t, {
    '/a/latest.json': (q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(good); },
    '/b/latest.json': (q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end('<html>blocked</html>'); },
    '/c/latest.json': (q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end('{"schema":9}'); },
  });
  const results = await checkManifests({ sources: ['a', 'b', 'c', 'd'].map(id => ({ id, name: id, manifest: `${base}/${id}/latest.json` })), fetchImpl: fetch, validate: validateManifest });
  assert.equal(results[0].ok, true); assert.equal(results[0].manifest.version, '1.0.1');
  assert.match(results[1].reason, /网页.*可能被公司代理拦截/);
  assert.match(results[2].reason, /版本清单无效/);
  assert.match(results[3].reason, /HTTP 404/);
});

function runHelper(paths) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', paths.helper, '-Plan', paths.plan], { encoding: 'utf8', timeout: 60000, windowsHide: true });
  return r;
}

test('替换脚本：程序退出后替换并核对；任何一步失败就全部回滚，结果只报告一次', { skip: process.platform !== 'win32' }, t => {
  const root = tmp(t);
  const newRes = fakeResources(path.join(root, 'build'), 'NEW'.repeat(5000), { settings: '{"v":2}' });
  const payload = path.join(root, 'u.gz');
  packPayload(newRes, payload);
  const installed = fakeResources(path.join(root, 'install'), 'OLD'.repeat(5000));
  const dataDir = path.join(root, 'data');

  // 失败：模拟最后一步出错 → 回滚
  let staged = stageIncremental({ dataDir, payloadFile: payload, resourcesDir: installed, version: '1.0.1', from: '1.0.0', exe: '', pid: 0, relaunch: false, simulateFailure: '模拟失败' });
  runHelper(staged.paths);
  let result = takeLastResult(dataDir);
  assert.equal(result.ok, false); assert.equal(result.rolledBack, true); assert.match(result.reason, /模拟失败/);
  assert.equal(fs.readFileSync(path.join(installed, 'app.asar'), 'utf8'), 'OLD'.repeat(5000));
  assert.equal(fs.readFileSync(path.join(installed, 'app.asar.unpacked', 'core', 'settings.json'), 'utf8'), '{"v":1}');
  assert.equal(takeLastResult(dataDir), null, '只报告一次');

  // 成功
  staged = stageIncremental({ dataDir, payloadFile: payload, resourcesDir: installed, version: '1.0.1', from: '1.0.0', exe: '', pid: 0, relaunch: false });
  const r = runHelper(staged.paths);
  result = takeLastResult(dataDir);
  assert.equal(result.ok, true, r.stderr + JSON.stringify(result));
  assert.equal(result.version, '1.0.1');
  assert.equal(fs.readFileSync(path.join(installed, 'app.asar'), 'utf8'), 'NEW'.repeat(5000));
  assert.equal(fs.readFileSync(path.join(installed, 'app.asar.unpacked', 'core', 'settings.json'), 'utf8'), '{"v":2}');
  assert.equal(fs.existsSync(stagingPaths(dataDir).newDir), false, '成功后清掉暂存');
});
