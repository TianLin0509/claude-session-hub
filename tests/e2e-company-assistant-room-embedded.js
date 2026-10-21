'use strict';
// Real pinned exe + original Python booking engine + headless browser against
// the secretary's local mock site. No pre-installed secretary, real bookings or network messages.
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { spawn, execFileSync } = require('node:child_process');
const { CompanyAssistant } = require('../core/company-assistant/service');
const component = require('../core/company-assistant/room-component');
const { stageRuntime } = require('../core/company-assistant/room-component/build-runtime');
const { packPayload, unpackPayload } = require('../core/app-update/payload');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const until = async (fn, label, ms = 120000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(300); } throw Error('timeout: ' + label); };
async function main() {
  const original = process.env.MSZ_SOURCE;
  if (!original) throw Error('MSZ_SOURCE must point to the original secretary source (mock fixture only)');
  const asset = process.env.AI_HUB_ROOM_RUNTIME_SOURCE || path.join(original, 'release', 'v2.1.0', 'MishuTerminator-2.1.0.exe');
  const out = path.resolve(__dirname, '..', 'output', '20261021-room-embedded-codex2');
  fs.mkdirSync(out, { recursive: true });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-room-embedded-'));
  const home = path.join(root, 'company-assistant', 'meeting-room');
  const bundle = path.join(out, 'staged', 'core', 'company-assistant', 'room-component');
  fs.mkdirSync(bundle, { recursive: true });
  const originals = path.resolve(__dirname, '..', 'core', 'company-assistant', 'room-component');
  for (const file of ['baseline.json', 'control.json', 'msz-code-2.1.1.zip']) fs.copyFileSync(path.join(originals, file), path.join(bundle, file));
  const staged = stageRuntime({ appDir: path.join(out, 'staged'), source: asset });
  const receipt = { root, staged, checks: [], startedAt: Date.now() }, messages = [], mockErrors = [];
  let mock, assistant, second;
  try {
    // Prove the existing incremental packer carries the runtime and verifies it
    // again on unpack, even if the previous installation had no room component.
    const resources = path.join(out, 'payload-fixture', 'resources');
    const rel = path.join('app.asar.unpacked', 'core', 'company-assistant', 'room-component', 'runtime', path.basename(staged.file));
    fs.mkdirSync(path.dirname(path.join(resources, rel)), { recursive: true });
    fs.writeFileSync(path.join(resources, 'app.asar'), 'synthetic application archive');
    fs.copyFileSync(staged.file, path.join(resources, rel));
    const payload = packPayload(resources, path.join(out, '20261021-room-incremental-codex2.hub.gz'));
    const restored = path.join(out, 'payload-restored'); unpackPayload(payload.file, restored);
    assert.ok(component.verified(path.join(restored, rel), component.bundledRuntime(bundle).baseline.exe));
    receipt.payload = { bytes: payload.bytes, runtimeIncluded: payload.files.some(f => f.path.endsWith('.exe')) };
    receipt.checks.push('incremental update from an installation without runtime carries and restores the pinned exe');
    mock = spawn(path.join(original, '.venv', 'Scripts', 'python.exe'), [path.join(__dirname, 'fixtures', 'company-room-mock.py'), home, original],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    mock.stderr.on('data', value => mockErrors.push(String(value)));
    await until(() => fs.existsSync(path.join(home, 'mock-ready.json')), 'mock site');
    const mockInfo = JSON.parse(fs.readFileSync(path.join(home, 'mock-ready.json')));
    const bookings = async () => (await fetch(`http://127.0.0.1:${mockInfo.port}/__state`)).json();
    const instance = 'hub-embedded-' + process.pid;
    assistant = new CompanyAssistant({ dataDir: root, noTimer: true, noTools: true, roomBundle: bundle, roomProcesses: async () => [],
      roomEnv: { QT_QPA_PLATFORM: 'offscreen', MSZ_HUB_TEST_INSTANCE: instance, MSZ_E2E_REPORT: path.join(home, 'runtime.json') } });
    assistant.phone.active = () => true; assistant.phone.send = async text => { messages.push(text); return true; };
    assert.equal(assistant.settings().rooms?.exePath, undefined);
    const before = Date.now(), ready = await assistant.rooms.ensure();
    receipt.prepareMs = Date.now() - before;
    assert.equal(ready.connected, true); assert.equal(ready.running, false); assert.equal(ready.enabled, false);
    assert.deepEqual(await bookings(), []);
    const exe = assistant.settings().rooms.exePath;
    assert.ok(exe.startsWith(path.join(root, 'company-assistant', 'room-runtime')));
    assert.equal(assistant.rooms.home(), home);
    const cfg = JSON.parse(fs.readFileSync(path.join(home, 'config.json')));
    assert.equal(cfg['系统']['自动检查更新'], false); assert.equal(cfg['系统']['开机自动启动守护'], false); assert.equal(cfg['高级']['无界面'], true);
    receipt.checks.push('new user: no saved exe, no download/install/picker; embedded control ready and booking stays stopped');
    // The unchanged Qt local-server lock rejects another process on the same
    // instance key, even when it was given a different data directory.
    const otherHome = path.join(root, 'second-home'); fs.mkdirSync(otherHome);
    await component.stage(assistant, exe, otherHome, { baseline: component.bundledRuntime(bundle).baseline, bundle });
    second = spawn(exe, ['--hub-control'], { windowsHide: true, stdio: 'ignore', env: { ...process.env, QT_QPA_PLATFORM: 'offscreen', MSZ_NO_TRAY: '1', MSZ_HUB_TEST_INSTANCE: instance, MSZ_HOME: otherHome } });
    const secondExit = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(Error('second fixture did not exit under single-instance lock')), 45000);
      second.once('error', e => { clearTimeout(timer); reject(e); }); second.once('exit', code => { clearTimeout(timer); resolve(code); });
    });
    assert.equal(secondExit, 0); assert.equal(fs.existsSync(path.join(otherHome, 'hub-control/status.json')), false);
    receipt.checks.push('original global single-instance lock prevents a second control process with another data home');
    await assistant.rooms.command('configure', { 主题: '内嵌组件模拟验收', 开始时间: '14:00', 时长小时: 2, 时长分钟: 0, 优先会议室: ['练秋湖F12-3-13R'], 抢订日: [1, 2, 3, 4, 5, 6, 7] });
    assert.equal(assistant.rooms.status().running, false);
    await assistant.rooms.command('test');
    await until(() => !assistant.rooms.status().running && fs.existsSync(path.join(home, 'booking_history.json')), 'real engine test');
    assert.deepEqual(await bookings(), []);
    assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'booking_history.json'))).at(-1)['状态'], '测试');
    receipt.checks.push('Hub configuration -> real original engine fills correct slot in headless browser; test never submits');
    await assistant.rooms.command('start');
    assert.equal(assistant.settings().rooms.enabled, true);
    await until(async () => (await bookings()).length > 0, 'explicit start -> local mock booking');
    const booked = await bookings(); assert.equal(booked.length, 1);
    assert.equal(booked[0].start, '14:00'); assert.equal(Number(booked[0].h), 2); assert.equal(Number(booked[0].m), 0);
    await until(() => JSON.parse(fs.readFileSync(path.join(home, 'booking_history.json'))).some(x => x['状态'] === '成功'), 'history success');
    await assistant.rooms.tick(); assert.ok(messages.some(text => text.includes('会议室成功') && text.includes('14:00–16:00')));
    await assistant.rooms.command('pause'); await until(() => !assistant.rooms.status().running, 'pause');
    assert.equal(assistant.settings().rooms.enabled, false);
    await until(() => fs.existsSync(path.join(home, 'runtime.json')), 'runtime version');
    receipt.runtime = JSON.parse(fs.readFileSync(path.join(home, 'runtime.json')));
    assert.equal(receipt.runtime.exe_version, '2.1.0'); assert.equal(receipt.runtime.version, '2.1.1');
    receipt.booking = booked[0]; receipt.messages = messages;
    receipt.checks.push('only explicit start books once at 14:00-16:00 -> success history -> result card source -> phone transport fixture; pause remains stopped');
    receipt.ok = true;
  } catch (error) { receipt.ok = false; receipt.error = error.stack; process.exitCode = 1; }
  finally {
    if (assistant?.rooms.child?.exitCode == null && assistant?.rooms.child?.pid) {
      const child = assistant.rooms.child;
      const actual = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(child.pid)} -ErrorAction Stop).Path`], { encoding: 'utf8', windowsHide: true }).trim();
      assert.equal(path.resolve(actual).toLowerCase(), path.resolve(assistant.settings().rooms.exePath).toLowerCase());
      await component.killTree(child);
      receipt.checks.push('teardown verified exact owned PID and exe, then stopped only that process tree');
    }
    assistant?.close(); if (second?.exitCode == null) await component.killTree(second); mock?.kill();
    receipt.mockErrors = mockErrors; receipt.finishedAt = Date.now();
    fs.writeFileSync(path.join(out, '20261021-room-embedded-e2e-codex2.json'), JSON.stringify(receipt, null, 2));
    console.log(JSON.stringify({ ok: receipt.ok, checks: receipt.checks.length, prepareMs: receipt.prepareMs, output: out, error: receipt.error }));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
