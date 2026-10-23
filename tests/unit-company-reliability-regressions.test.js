'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http');
const { randomBytes } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { CompanyAssistant } = require('../core/company-assistant/service');
const W = require('../core/company-assistant/welink');
const { AuthKeeper, authFailure } = require('../core/company-assistant/auth-keeper');
const C = require('../core/company-assistant/citation-check');
const { checkManifests } = require('../core/app-update/downloader');
const { createAppUpdateController } = require('../main/app-update-controller');
const { packPayload, sha256 } = require('../core/app-update/payload');
const { stagingPaths, takeLastResult } = require('../core/app-update/apply');

function temp(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-reliability-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}
async function server(t, handler) {
  const s = http.createServer(handler);
  await new Promise(r => s.listen(0, '127.0.0.1', r));
  t.after(() => { s.closeAllConnections(); s.close(); });
  return { server: s, base: `http://127.0.0.1:${s.address().port}` };
}

test('会话限制优先采集当前最近顺序；新会话、重新活跃、10/20/不限、身份和目录回退', async t => {
  const now = Date.now();
  const svc = new CompanyAssistant({ dataDir: temp(t), noTimer: true, noTools: true, now: () => now });
  t.after(() => svc.close());
  const old = Array.from({ length: 25 }, (_, i) => ({ id: `old-${i}`, name: `旧会话${i}`, seenAt: now - 1000 }));
  const recent = [{ id: 'new', name: '新会话' }, { id: 'old-24', name: '重新活跃' }];
  for (const limit of [10, 20, 0]) {
    svc.write('conversation-catalog.json', { identity: 'self', conversations: old });
    const fetched = [];
    svc.conversationHistory = async conv => { fetched.push(conv.id); return { messages: [], cache: {}, coverage: { status: 'complete' } }; };
    const snap = { login: { uid: 'self' }, day: '2026-10-23', conversations: recent, messages: {}, errors: [] };
    await svc.collectMessages(snap, { ...svc.settings(), maxConversations: limit }, now, async () => [], { persistCache: false });
    assert.deepEqual(fetched.slice(0, 2), ['new', 'old-24']);
    assert.equal(fetched.length, limit || 26);
    assert.equal(new Set(snap.conversations.map(c => c.id)).size, 26);
  }
  for (const identity of ['self', 'other']) {
    svc.write('conversation-catalog.json', { identity, conversations: old });
    const snap = { login: { uid: 'self' }, day: '2026-10-23', conversations: [], directoryFallback: true, messages: {}, errors: [] };
    await svc.collectMessages(snap, { ...svc.settings(), maxConversations: 10 }, now, async () => [], { persistCache: false });
    assert.equal(snap.scope.fetched, identity === 'self' ? 10 : 0);
    assert.equal(snap.scope.directoryFallback, true);
  }
});

test('出处不跨下一文件抢页码，同名必须消歧，未知页数不能通过', () => {
  const docs = [{ name: '同名.pptx', path: 'C:/甲/同名.pptx', pages: 3 }, { name: '同名.pptx', path: 'C:/乙/同名.pptx', pages: 30 }];
  assert.deepEqual(C.extractCitations('甲.pptx 与 乙.pptx 第 8 页').map(x => x.name), ['乙.pptx']);
  const explicit = C.extractCitations('C:\\甲\\同名.pptx 第 8 页；C:/乙/同名.pptx 第 8 页');
  assert.equal(explicit.length, 2);
  const r = C.checkCitations(explicit, docs);
  assert.equal(r.verified, 1);
  assert.equal(r.problems[0].reason, 'out-of-range');
  assert.equal(C.checkCitations([{ name: '同名.pptx', page: 8 }], docs).problems[0].reason, 'ambiguous');
  assert.equal(C.checkCitations(C.extractCitations('C:/丙/同名.pptx 第 2 页'), docs).verified, 0);
  const spaced = [{ name: '同名.pptx', path: 'C:/Project A/同名.pptx', pages: 3 }];
  assert.equal(C.checkCitations(C.extractCitations('"C:\\Project A\\同名.pptx" 第 2 页'), spaced).verified, 1);
  assert.equal(C.checkCitations(C.extractCitations('`C:/Project A/同名.pptx` 第 4 页'), spaced).problems[0].reason, 'out-of-range');
  for (const pages of [0, undefined, -1, 1.5]) {
    const unknown = C.checkCitations([{ name: '唯一.pptx', page: 1 }], [{ name: '唯一.pptx', pages }]);
    assert.equal(unknown.verified, 0);
    assert.equal(unknown.problems[0].reason, 'unknown-pages');
    assert.match(C.renderCitationCheck(unknown), /页数.*未知|没有.*页数/);
  }
  assert.match(C.renderCitationCheck(C.checkCitations([{ name: '同名.pptx', page: 8 }], docs)), /同名|多份/);
});

test('现场 User token not found 可恢复；网络/解析未知状态保留原因和退出码、不触发扫码', async t => {
  assert.equal(W.loginState('User token not found').reason, 'expired');
  assert.equal(authFailure('User token not found'), true);
  let restored = false;
  const keeper = new AuthKeeper({ now: () => 100000, read: () => ({}), write() {}, changed() {}, refresh: async () => {},
    rawWelink: async args => {
      if (args[1] === 'login') { restored = true; return { code: 0, stdout: 'Credentials cached.', stderr: '' }; }
      return restored ? { code: 0, stdout: 'UID: synthetic-self\nUser Token: VALID', stderr: '' }
        : { code: 1, stdout: '', stderr: 'User token not found' };
    } });
  t.after(() => keeper.close());
  assert.equal((await keeper.check()).state, 'online');
  assert.equal(restored, true, '现场缺失令牌错误走现有恢复流程');
  for (const response of [{ code: 1, stdout: '', stderr: 'network offline' }, { code: 0, stdout: 'unrecognized response', stderr: '' }]) {
    const calls = [];
    const a = { now: () => 100000, read: () => ({}), write() {}, changed() {}, rawWelink: async args => { calls.push(args); return response; } };
    const k = new AuthKeeper(a); t.after(() => k.close());
    const status = await k.check();
    assert.equal(status.state, 'unknown'); assert.equal(calls.length, 1);
    assert.equal(status.login.exitCode, response.code);
    assert.match(status.error, response.code ? /network offline/ : /无法识别|识别.*输出/);
  }
  const svc = new CompanyAssistant({ dataDir: temp(t), noTimer: true, noTools: true });
  t.after(() => svc.close());
  svc.refresh = async () => ({ login: { ok: false, reason: 'unknown', error: '网络暂时中断' } });
  const brief = await svc.generateBrief();
  assert.doesNotMatch(brief.note, /没登录|登录过期/);
  assert.match(brief.note, /无法确认|未确认/);
  const redacted = new AuthKeeper({ now: () => 100000, read: () => ({}), write() {}, changed() {},
    rawWelink: async () => ({ code: 1, stdout: '', stderr: 'network offline\n{"access_token":"synthetic-secret"}' }) });
  t.after(() => redacted.close());
  const redactedStatus = await redacted.check();
  assert.match(redactedStatus.error, /network offline/);
  assert.doesNotMatch(JSON.stringify(redactedStatus), /synthetic-secret/);
});

test('真实 HTTP 清单超时覆盖响应头、卡住的正文和验证，健康源可用且取消会释放连接', async t => {
  const sockets = new Set();
  const { server: s, base } = await server(t, (req, res) => {
    if (req.url === '/good') { res.setHeader('content-type', 'application/json'); return res.end('{"version":"1.0.1"}'); }
    sockets.add(res); res.on('close', () => sockets.delete(res));
    if (req.url === '/body') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{'); }
  });
  // 旧实现正文会一直挂起；硬清理保证失败测试本身也有界，不留下服务。
  const safety = setTimeout(() => s.closeAllConnections(), 1500); t.after(() => clearTimeout(safety));
  const sources = ['head', 'body', 'good'].map(id => ({ id, name: id, manifest: base + '/' + id }));
  const at = Date.now();
  const results = await checkManifests({ sources, fetchImpl: fetch, validate: x => x, timeoutMs: 120 });
  assert.ok(Date.now() - at < 1000, '正文也必须在每源期限内失败');
  assert.deepEqual(results.map(r => r.ok), [false, false, true]);
  assert.match(results[1].reason, /超时|未完成|秒/);
  const ac = new AbortController();
  const cancelled = checkManifests({ sources: sources.slice(0, 2), fetchImpl: fetch, validate: x => x, timeoutMs: 1000, signal: ac.signal });
  setTimeout(() => ac.abort(), 30);
  assert.ok((await cancelled).every(r => !r.ok && /取消/.test(r.reason)));
  const failed = await checkManifests({ sources: sources.slice(0, 2), fetchImpl: fetch, validate: x => x, timeoutMs: 80 });
  assert.ok(failed.every(r => !r.ok));
  const validation = await checkManifests({ sources: sources.slice(2), fetchImpl: fetch, timeoutMs: 80,
    validate: async x => { await new Promise(r => setTimeout(r, 150)); return x; } });
  assert.equal(validation[0].ok, false, '校验也在清单期限内');
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sockets.size, 0, '超时/取消应关闭未读完正文');
});

test('更新控制器检查超时和取消都释放 checking，后续检查仍可成功', async t => {
  let mode = 'stall';
  const { base } = await server(t, (_req, res) => {
    res.setHeader('content-type', 'application/json');
    if (mode === 'stall') { res.write('{'); return; }
    res.end(JSON.stringify({ schema: 1, version: '1.0.1', runtime: { electron: '41.2.0', native: {} },
      installer: { file: 'setup.exe', bytes: 2048, sha256: 'a'.repeat(64) } }));
  });
  const ctl = createAppUpdateController({ dataDir: temp(t), currentVersion: '1.0.0', fetchImpl: fetch,
    env: { AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: 'local', manifest: base, files: base + '/' }]) } });
  t.after(() => ctl.dispose());
  const pending = ctl.check();
  setTimeout(() => ctl.cancel(), 50);
  assert.equal((await pending).phase, 'idle');
  mode = 'good';
  assert.equal((await ctl.check()).phase, 'available');
  mode = 'stall';
  const at = Date.now(), failed = await ctl.check();
  assert.equal(failed.phase, 'error');
  assert.match(failed.checks[0].reason, /超时/);
  assert.ok(Date.now() - at < 12500, '默认每源 10 秒期限释放远程更新检查状态');
  mode = 'good';
  assert.equal((await ctl.check()).phase, 'available');
});

async function updateRig(t, { matches = true, onlyDelta = false, runtimeChanged = false, mutateOnDownload = false } = {}) {
  const root = temp(t), resources = path.join(root, 'resources'), build = path.join(root, 'build');
  for (const dir of [resources, build]) fs.mkdirSync(path.join(dir, 'app.asar.unpacked', 'core'), { recursive: true });
  const fixed = randomBytes(4096), next = randomBytes(4096);
  fs.writeFileSync(path.join(resources, 'app.asar'), 'old');
  fs.writeFileSync(path.join(resources, 'app.asar.unpacked/core/fixed.bin'), fixed);
  fs.writeFileSync(path.join(build, 'app.asar'), next);
  fs.writeFileSync(path.join(build, 'app.asar.unpacked/core/fixed.bin'), fixed);
  const complete = packPayload(build, path.join(root, 'complete.gz'));
  const delta = packPayload(build, path.join(root, 'delta.gz'), { previous: complete.index });
  if (!matches) fs.writeFileSync(path.join(resources, 'app.asar.unpacked/core/fixed.bin'), 'changed');
  const oldElectron = Object.getOwnPropertyDescriptor(process.versions, 'electron');
  Object.defineProperty(process.versions, 'electron', { value: '41.2.0', configurable: true });
  t.after(() => { if (oldElectron) Object.defineProperty(process.versions, 'electron', oldElectron); else delete process.versions.electron; });
  const installer = randomBytes(2048), requests = [];
  const asset = (p, name) => ({ file: name, bytes: p.bytes, sha256: p.sha256 });
  const manifest = { schema: 1, version: '1.0.1', runtime: { electron: runtimeChanged ? '42.0.0' : '41.2.0', native: {} },
    incremental: onlyDelta ? null : asset(complete, 'complete.gz'), incrementalDelta: { ...asset(delta, 'delta.gz'), requires: delta.unchanged },
    installer: { file: 'setup.exe', bytes: installer.length, sha256: sha256(installer) } };
  const { base } = await server(t, (req, res) => {
    requests.push(req.url); res.setHeader('content-type', 'application/octet-stream');
    if (req.url === '/latest.json') return res.end(JSON.stringify(manifest));
    if (mutateOnDownload && req.url === '/delta.gz') fs.writeFileSync(path.join(resources, 'app.asar.unpacked/core/fixed.bin'), 'changed during download');
    const body = req.url === '/setup.exe' ? installer : fs.readFileSync(path.join(root, req.url.slice(1)));
    res.setHeader('content-length', body.length); res.end(body);
  });
  const dataDir = path.join(root, 'data');
  const ctl = createAppUpdateController({ dataDir, currentVersion: '1.0.0', fetchImpl: fetch, logger: { warn() {} },
    env: { AI_HUB_UPDATE_SOURCES: JSON.stringify([{ id: 'local', name: 'local', manifest: base + '/latest.json', files: base + '/' }]), AI_HUB_UPDATE_RESOURCES: resources, AI_HUB_UPDATE_FORCE_APPLY: '1' } });
  t.after(() => ctl.dispose());
  return { ctl, requests, manifest, dataDir, resources, next, fixed };
}

test('下载计划与界面一致：匹配/不匹配/仅差量/运行时变化均核对实际 URL、字节、hash 与安装结果', async t => {
  for (const options of [{}, { matches: false }, { onlyDelta: true }, { onlyDelta: true, matches: false }, { runtimeChanged: true }]) {
    await t.test(JSON.stringify(options), async st => {
      const r = await updateRig(st, options), state = await r.ctl.check();
      const expected = options.runtimeChanged || options.onlyDelta && options.matches === false ? 'setup.exe' : options.matches === false ? 'complete.gz' : 'delta.gz';
      assert.equal(state.plan.file, expected);
      const done = await r.ctl.download();
      assert.equal(done.phase, 'ready', JSON.stringify(done));
      assert.deepEqual(r.requests, ['/latest.json', '/' + expected]);
      assert.equal(done.attempts[0].bytes, state.plan.bytes);
      const p = stagingPaths(r.dataDir);
      if (expected === 'setup.exe') {
        assert.equal(sha256(fs.readFileSync(path.join(p.downloads, expected))), r.manifest.installer.sha256);
      } else {
        assert.equal(sha256(fs.readFileSync(path.join(p.newDir, 'app.asar'))), sha256(r.next));
        assert.equal(fs.readFileSync(path.join(r.resources, 'app.asar'), 'utf8'), 'old', '暂存不修改安装目录');
        if (process.platform === 'win32') {
          const plan = JSON.parse(fs.readFileSync(p.plan, 'utf8')); plan.pid = 0; plan.relaunch = false; plan.exe = '';
          fs.writeFileSync(p.plan, JSON.stringify(plan));
          const installed = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', p.helper, '-Plan', p.plan], { windowsHide: true, encoding: 'utf8', timeout: 15000 });
          assert.equal(installed.status, 0, installed.stderr);
          assert.equal(takeLastResult(r.dataDir).ok, true);
          assert.equal(sha256(fs.readFileSync(path.join(r.resources, 'app.asar'))), sha256(r.next));
          assert.equal(sha256(fs.readFileSync(path.join(r.resources, 'app.asar.unpacked/core/fixed.bin'))), sha256(r.fixed));
        }
      }
    });
  }
});

test('差量下载期间前提文件变化须阻止暂存并允许重新检查退回完整更新包', async t => {
  const r = await updateRig(t, { mutateOnDownload: true });
  await r.ctl.check();
  const failed = await r.ctl.download();
  assert.equal(failed.phase, 'error'); assert.match(failed.error, /下载期间.*改动/);
  assert.equal(fs.readFileSync(path.join(r.resources, 'app.asar'), 'utf8'), 'old');
  assert.equal((await r.ctl.check()).plan.variant, 'complete');
  assert.equal((await r.ctl.download()).phase, 'ready');
});
