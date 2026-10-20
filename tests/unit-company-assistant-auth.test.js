'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { AuthKeeper, RETRY_MS } = require('../core/company-assistant/auth-keeper');
const { CompanyAssistant } = require('../core/company-assistant/service');
const W = require('../core/company-assistant/welink');
const result = stdout => ({ code: 0, stdout, stderr: '' });
function rig(run) {
  let now = 10000000, allowed = true;
  const calls = [], notices = [];
  const a = { now: () => now, read: () => ({}), write() {}, changed() {},
    rawWelink: async (args, opts) => { calls.push(args.join(' ')); return run(args, opts); },
    publish: n => { if (!allowed) return false; notices.push(n); return true; }, refresh: async () => {} };
  return { k: new AuthKeeper(a), calls, notices, advance: () => { now += RETRY_MS + 1; }, allow: b => { allowed = b; } };
}
test('过期自动恢复、并发只登录一次；即将到期提前续期', async () => {
  let valid = false, near = false;
  const r = rig(async args => {
    if (args[1] === 'login') { valid = true; near = false; return result('Credentials cached.'); }
    return result(valid ? `User Token: valid (expires in ${near ? '4m11s' : '29m11s'})\nUID: test` : 'User Token: EXPIRED');
  });
  const [a, b] = await Promise.all([r.k.check(), r.k.check()]);
  assert.equal(a.state, 'online'); assert.equal(b.state, 'online');
  assert.equal(r.calls.filter(x => x === 'auth login').length, 1);
  r.advance(); near = true; await r.k.check();
  assert.equal(r.calls.filter(x => x === 'auth login').length, 2);
});
test('网络错误不当成扫码；两次扫码后停止登录但额度恢复仍补通知', async () => {
  let network = false;
  const r = rig(async (args, opts) => {
    if (network) throw new Error('network offline');
    if (args[1] === 'status') return result('User Token: EXPIRED');
    opts.onData('请扫码二维码'); assert.equal(opts.signal.aborted, true);
    throw Object.assign(new Error('aborted'), { code: 'WELINK_ABORTED' });
  });
  r.allow(false);
  await r.k.check(); r.advance(); await r.k.check();
  assert.equal(r.k.status().scanAttempts, 2);
  network = true; r.advance(); await r.k.check(); assert.equal(r.k.status().state, 'unknown');
  network = false; r.allow(true); r.advance(); await r.k.check();
  assert.equal(r.k.status().state, 'needs-scan'); assert.equal(r.notices.length, 1); assert.ok(r.notices[0].id);
  assert.equal(r.calls.filter(x => x === 'auth login').length, 2);
  // After a manual login the count starts over: one QR is not yet a scan request, the second in a row is.
  r.k.manualSucceeded({ ok: true }); r.advance(); await r.k.check();
  assert.equal(r.k.status().state, 'unknown'); assert.equal(r.notices.length, 1);
  r.advance(); await r.k.check();
  assert.equal(r.k.status().state, 'needs-scan'); assert.equal(r.notices.length, 2); assert.notEqual(r.notices[0].id, r.notices[1].id);
});
test('关闭过程中返回的状态不再触发登录；超时不冒充出现二维码', async () => {
  let resolve;
  const r = rig(() => new Promise(done => { resolve = done; }));
  const pending = r.k.check(); r.k.close(); resolve(result('User Token: EXPIRED')); await pending;
  assert.deepEqual(r.calls, ['auth status']);
  const timeout = rig(async args => { if (args[1] === 'status') return result('User Token: EXPIRED'); throw Object.assign(new Error('timeout'), { code: 'WELINK_TIMEOUT' }); });
  await timeout.k.check(); assert.equal(timeout.k.status().state, 'unknown'); assert.equal(timeout.notices.length, 0);
});
test('欢迎发送失败不接通；并发接通和关闭按用户顺序生效', async t => {
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-auth-test-')), noTimer: true, noTools: true });
  t.after(() => a.close());
  a.phone.send = async () => false;
  assert.equal((await a.setPhone({ groupId: '1234567890123', enabled: true })).ok, false);
  assert.equal(a.settings().phone.enabled, false);
  let release, count = 0;
  a.phone.send = async () => { count++; await new Promise(r => { release = r; }); return true; };
  const first = a.setPhone({ groupId: '1234567890123', enabled: true });
  const second = a.setPhone({ groupId: '1234567890123', enabled: true });
  const off = a.setPhone({ enabled: false });
  await new Promise(r => setImmediate(r)); release();
  await Promise.all([first, second, off]);
  assert.equal(count, 1); assert.equal(a.settings().phone.enabled, false);
  await assert.rejects(a.setPhone({ groupId: '1'.repeat(81), enabled: true }), /格式/);
});
test('停止登录要等本次子进程退出，再允许上层发起下一次', async () => {
  const { EventEmitter } = require('node:events'), child = new EventEmitter(), abort = new AbortController();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); let killed = false, settled = false;
  child.kill = () => { killed = true; };
  const pending = W.run(['auth', 'login'], { cli: 'fixture.exe', allowSetup: true, signal: abort.signal, spawnFn: () => child })
    .then(() => { throw Error('unexpected success'); }, e => { settled = true; return e; });
  abort.abort(); await new Promise(r => setImmediate(r));
  assert.equal(killed, true); assert.equal(settled, false);
  child.emit('close', 1);
  assert.equal((await pending).code, 'WELINK_ABORTED');
});
test('发送进程成功但业务返回失败时，不能把群显示为接通', async t => {
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-send-test-')), noTimer: true, noTools: true,
    welinkRun: async () => result('{"error":{"error_code":403,"error_msg":"group denied"}}') });
  t.after(() => a.close());
  const r = await a.setPhone({ groupId: '1234567890123', enabled: true });
  assert.equal(r.ok, false); assert.equal(a.settings().phone.enabled, false); assert.match(r.error, /group denied/);
});
test('自动续期与手动扫码用同一套二维码识别：图片路径、网址也算出现二维码', () => {
  const { needsScan } = require('../core/company-assistant/auth-keeper');
  for (const text of ['二维码已保存到 C:\\Users\\me\\AppData\\Local\\Temp\\welink-login.png', 'Open https://login.example.com/qr?id=1 to sign in', 'data:image/png;base64,AAAA', '请使用手机扫码'])
    assert.equal(needsScan(text), !!W.qrFromLoginOutput(text) || /扫码/.test(text), text);
  assert.equal(needsScan('C:\\Users\\me\\login.png'), true);
  assert.equal(needsScan('https://login.example.com/qr'), true);
  assert.equal(needsScan('Credentials cached.'), false);
});
test('出图片路径时不用等满超时；连续两次（二维码或超时）才转扫码并通知，第三次不再自动登录', async () => {
  let n = 0;
  const r = rig(async (args, opts) => {
    if (args[1] === 'status') return result('User Token: EXPIRED');
    n++;
    if (n === 1) { opts.onData('QR saved: C:\\Temp\\welink-qr.png'); assert.equal(opts.signal.aborted, true); throw Object.assign(new Error('aborted'), { code: 'WELINK_ABORTED' }); }
    throw Object.assign(new Error('welink-cli 超过 90 秒没返回'), { code: 'WELINK_TIMEOUT' });
  });
  await r.k.check();
  assert.equal(r.k.status().state, 'unknown'); assert.equal(r.k.status().scanAttempts, 1); assert.equal(r.notices.length, 0);
  r.advance(); await r.k.check();
  assert.equal(r.k.status().state, 'needs-scan'); assert.equal(r.k.status().scanAttempts, 2); assert.equal(r.notices.length, 1);
  assert.doesNotMatch(r.notices[0].title, /需要扫码/);
  r.advance(); await r.k.check();
  assert.equal(r.calls.filter(x => x === 'auth login').length, 2);
  const timeouts = rig(async args => { if (args[1] === 'status') return result('User Token: EXPIRED'); throw Object.assign(new Error('timeout'), { code: 'WELINK_TIMEOUT' }); });
  await timeouts.k.check(); timeouts.advance(); await timeouts.k.check();
  assert.equal(timeouts.k.status().state, 'needs-scan'); assert.equal(timeouts.notices.length, 1);
});
test('令牌仍有效时提前续期出二维码或超时：结束登录、不转扫码、不发通知、不计数', async () => {
  for (const mode of ['qr', 'timeout']) {
    const r = rig(async (args, opts) => {
      if (args[1] === 'status') return result('User Token: valid (expires in 3m10s)\nUID: test');
      if (mode === 'qr') { opts.onData('请扫码登录'); assert.equal(opts.signal.aborted, true); throw Object.assign(new Error('aborted'), { code: 'WELINK_ABORTED' }); }
      throw Object.assign(new Error('timeout'), { code: 'WELINK_TIMEOUT' });
    });
    await r.k.check();
    assert.equal(r.k.status().state, 'online', mode); assert.equal(r.k.status().scanAttempts, 0, mode); assert.equal(r.notices.length, 0, mode);
    assert.equal(r.calls.filter(x => x === 'auth login').length, 1, mode);
    await r.k.check({ force: true });
    assert.equal(r.calls.filter(x => x === 'auth login').length, 1, mode + ': no retry within ten minutes');
  }
});
test('手动扫码登录接上停止信号：Hub 退出时结束这棵进程', async t => {
  let signal;
  const a = new CompanyAssistant({ dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-stop-')), noTimer: true, noTools: true,
    welinkRun: (args, opts) => { if (args[1] === 'login') { signal = opts.signal; return new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(Object.assign(new Error('stopped'), { code: 'WELINK_ABORTED' })))); } return Promise.resolve(result('User Token: EXPIRED')); } });
  t.after(() => a.close());
  const flow = a.login();
  await new Promise(r => setTimeout(r, 50));
  assert.ok(signal, 'auth login got a signal'); assert.equal(signal.aborted, false);
  a.close();
  assert.equal(signal.aborted, true);
  await flow;
});
