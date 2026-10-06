'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { EventEmitter } = require('events');
const { PassThrough } = require('stream');
const { LocalAsr, localPaths, localInstalled } = require('../core/local-asr/manager');
const voiceEngine = require('../core/voice-engine');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
// 模拟 worker 进程：按协议回应 load / transcribe，可注入失败。
function fakeSpawn({ envDelay = 1, failLoad = false, failTranscribe = false } = {}) {
  const procs = [];
  const spawnImpl = () => {
    const p = new EventEmitter();
    p.stdin = new PassThrough(); p.stdout = new PassThrough(); p.stderr = new PassThrough();
    p.killed = false; p.kill = () => { p.killed = true; setImmediate(() => p.emit('exit', null)); };
    p.ops = [];
    let buf = '';
    p.stdin.on('data', chunk => {
      buf += chunk;
      for (let i; (i = buf.indexOf('\n')) >= 0;) {
        const msg = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1); p.ops.push(msg.op);
        const reply = o => p.stdout.write(JSON.stringify({ id: msg.id, ...o }) + '\n');
        if (msg.op === 'load') setTimeout(() => reply(failLoad ? { error: 'CUDA out of memory' } : { event: 'loaded', ms: 3 }), 3);
        if (msg.op === 'transcribe') reply(failTranscribe ? { error: 'boom' } : { texts: msg.pcm.map((_, k) => `本地${k + 1}。`), ms: 2 });
      }
    });
    setTimeout(() => p.stdout.write(JSON.stringify({ event: 'env-ready', ms: 1 }) + '\n'), envDelay);
    procs.push(p); return p;
  };
  return { spawnImpl, procs };
}
const silentLog = () => {};
const tv = r => ({ text: r.text, via: r.via });
// 有声片段（与 voice-tokenplan 的静音判定配合）。
function speech(sec) { const b = Buffer.alloc(Math.round(sec * 16000) * 2); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / 7)), i * 2); return b; }

async function main() {
  // 安装判定与默认路线：本地装好 → local；只有套餐 → tokenplan；都没有 → streaming。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-local-asr-'));
  const py = path.join(dir, 'python.exe'), model = path.join(dir, 'model');
  const saved = { py: process.env.HUB_LOCAL_ASR_PYTHON, model: process.env.HUB_LOCAL_ASR_MODEL };
  process.env.HUB_LOCAL_ASR_PYTHON = py; process.env.HUB_LOCAL_ASR_MODEL = model;
  assert.equal(localInstalled(localPaths({})), false);
  assert.equal(voiceEngine.resolveEngine({}, dir).engine, 'streaming');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ acp: { apiKey: 'sk-sp-x', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }));
  assert.equal(voiceEngine.resolveEngine({}, dir).engine, 'tokenplan');
  fs.writeFileSync(py, ''); fs.mkdirSync(model); fs.writeFileSync(path.join(model, 'config.json'), '{}');
  assert.deepEqual(voiceEngine.resolveEngine({}, dir), { engine: 'local', planKey: 'sk-sp-x', localReady: true });
  assert.equal(voiceEngine.resolveEngine({ engine: 'tokenplan' }, dir).engine, 'tokenplan');
  process.env.HUB_LOCAL_ASR_PYTHON = saved.py ?? ''; process.env.HUB_LOCAL_ASR_MODEL = saved.model ?? '';
  if (!saved.py) delete process.env.HUB_LOCAL_ASR_PYTHON; if (!saved.model) delete process.env.HUB_LOCAL_ASR_MODEL;
  assert.equal(voiceEngine.localContext({ terms: 'SRS\nSuperRAN', context: '无线' }), 'SRS、SuperRAN\n无线');

  // 生命周期：环境常驻不装模型 → prepare 装模型 → 识别 → 空闲到时结束进程并换新环境。
  const f = fakeSpawn();
  const local = new LocalAsr({ paths: { python: 'py', model: 'm', speakerModel: 's' }, spawnImpl: f.spawnImpl, idleMs: 60, log: silentLog });
  local.start(); assert.equal(local.state, 'starting');
  await tick(10); assert.equal(local.state, 'env'); assert.deepEqual(f.procs[0].ops, []);
  await local.prepare(); assert.equal(local.state, 'ready'); assert.deepEqual(f.procs[0].ops, ['load']);
  assert.deepEqual(await local.transcribe([speech(1), speech(1)], 'SRS'), ['本地1。', '本地2。']);
  await tick(100);
  assert(f.procs[0].killed, '空闲到时应结束进程释放显存');
  assert.equal(f.procs.length, 2, '释放后应立即换一个只含环境的新 worker');
  await tick(10); assert.equal(local.state, 'env');
  // prepare 在环境启动中调用：等环境就绪后再装模型；并发 prepare 共用一次装载。
  local.stop();
  const g = fakeSpawn({ envDelay: 20 });
  const early = new LocalAsr({ paths: {}, spawnImpl: g.spawnImpl, idleMs: 1000, log: silentLog });
  const [a, b] = [early.prepare(), early.prepare()];
  assert.equal(a, b); await a; assert.equal(early.state, 'ready'); assert.deepEqual(g.procs[0].ops, ['load']);
  // 进程意外退出：在途请求失败，状态回 off，随后自动重启（这里只验状态与拒绝）。
  const inflight = early.call('embed', { pcm: '' }, 1000).catch(e => e.message);
  g.procs[0].emit('exit', 1);
  assert.match(await inflight, /已结束/); assert.equal(early.state, 'off');
  early.stop();
  // 装载失败（如显存不足）：回到 env，prepare 拒绝，调用方据此改走 Token Plan。
  const h = fakeSpawn({ failLoad: true });
  const oom = new LocalAsr({ paths: {}, spawnImpl: h.spawnImpl, log: silentLog });
  await assert.rejects(oom.prepare(), /CUDA out of memory/); assert.equal(oom.state, 'env');
  oom.stop();

  // 逐段路由：本地未就绪 → Token Plan 接力；就绪 → 本地；本地出错 → Token Plan；用量逐段记账。
  const calls = [], usage = [];
  const fetchImpl = async (_u, init) => { calls.push(JSON.parse(init.body).model); return { ok: true, status: 200, json: async () => ({ output: { text: '套餐。' } }) }; };
  const k = fakeSpawn();
  const routed = new LocalAsr({ paths: {}, spawnImpl: k.spawnImpl, idleMs: 5000, log: silentLog });
  const rec = voiceEngine.segmentRecognizer({ engine: 'local', planKey: 'sk-sp-x', profile: { terms: 'SRS' }, local: routed, source: 'desktop', usage: u => usage.push(u), fetchImpl, log: silentLog });
  assert.deepEqual(tv(await rec(speech(2))), { text: '套餐。', via: 'tokenplan' });
  await routed.prepare();
  assert.deepEqual(tv(await rec(speech(2))), { text: '本地1。', via: 'local' });
  assert.deepEqual(usage.map(u => [u.source, u.via, u.sec]), [['desktop', 'tokenplan', 2], ['desktop', 'local', 2]]);
  routed.stop();
  const bad = fakeSpawn({ failTranscribe: true });
  const flaky = new LocalAsr({ paths: {}, spawnImpl: bad.spawnImpl, log: silentLog }); await flaky.prepare();
  const rec2 = voiceEngine.segmentRecognizer({ engine: 'local', planKey: 'sk-sp-x', profile: {}, local: flaky, fetchImpl, log: silentLog });
  assert.equal((await rec2(speech(1))).via, 'tokenplan');
  const rec3 = voiceEngine.segmentRecognizer({ engine: 'local', planKey: '', profile: {}, local: flaky, fetchImpl, log: silentLog });
  await assert.rejects(rec3(speech(1)), /boom/, '没有套餐 Key 时本地错误应如实报出');
  flaky.stop();
  // 没有套餐 Key：等本地就绪再识别，不改走任何云端。
  const w = fakeSpawn({ envDelay: 15 });
  const waiting = new LocalAsr({ paths: {}, spawnImpl: w.spawnImpl, log: silentLog });
  const rec4 = voiceEngine.segmentRecognizer({ engine: 'local', planKey: '', profile: {}, local: waiting, fetchImpl, log: silentLog });
  const before = calls.length;
  assert.deepEqual(tv(await rec4(speech(1))), { text: '本地1。', via: 'local' });
  assert.equal(calls.length, before);
  waiting.stop();

  // 手机整段录音：就绪时多段一次批量送本地；未就绪时走 Token Plan 并顺带开始装模型。
  const p = fakeSpawn();
  const phoneLocal = new LocalAsr({ paths: {}, spawnImpl: p.spawnImpl, idleMs: 5000, log: silentLog });
  const twoSentences = Buffer.concat([speech(9), Buffer.alloc(32000), speech(3)]);
  const cold = await voiceEngine.transcribeRecording(twoSentences, { engine: 'local', planKey: 'sk-sp-x', profile: {}, local: phoneLocal, fetchImpl, log: silentLog });
  assert.deepEqual(cold, { text: '套餐。套餐。', via: { tokenplan: 2 } });
  await tick(30); assert.equal(phoneLocal.state, 'ready', '首条走套餐时应顺带装好模型');
  const warm = await voiceEngine.transcribeRecording(twoSentences, { engine: 'local', planKey: 'sk-sp-x', profile: {}, local: phoneLocal, fetchImpl, log: silentLog });
  assert.deepEqual(warm, { text: '本地1。本地2。', via: { local: 2 } });
  assert.equal(p.procs[0].ops.filter(o => o === 'transcribe').length, 1, '多段应一次批量');
  assert.deepEqual(await voiceEngine.transcribeRecording(Buffer.alloc(64000), { engine: 'local', planKey: 'k', local: phoneLocal, fetchImpl }), { text: '', via: {} });
  phoneLocal.stop();

  // 用量账本落盘为 JSON 行。
  voiceEngine.usageLogger(dir)({ source: 'phone', via: 'local', sec: 3.14 });
  const line = JSON.parse(fs.readFileSync(path.join(dir, 'voice-usage.jsonl'), 'utf8').trim());
  assert.deepEqual([line.source, line.via, line.sec], ['phone', 'local', 3.1]);
  assert.equal(voiceEngine.describeVia({ local: 3, tokenplan: 1 }), '本地 3 段 · Token Plan 1 段');
  console.log('PASS local asr: install detection, default engine, env-only start, on-demand load, idle release+respawn, crash/OOM handling, per-segment routing+fallback, phone batch, usage ledger');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
