'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const plan = require('../core/voice-tokenplan');

// 合成 16kHz 语音样：tone 段（响）与静音段交替，秒数由 spec 给出。
function speech(spec, rate = 16000) {
  const parts = spec.map(([kind, sec]) => {
    const b = Buffer.alloc(Math.round(sec * rate) * 2);
    if (kind === 'say') for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / 7)), i * 2);
    return b;
  });
  return Buffer.concat(parts);
}
function fakeFetch({ delays = [], fail = -1 } = {}) {
  const calls = [];
  const impl = async (url, init) => {
    const n = calls.length, body = JSON.parse(init.body);
    const audio = Buffer.from(body.input.messages.at(-1).content[0].input_audio.data.split(',')[1], 'base64');
    calls.push({ url, body, auth: init.headers.Authorization, seconds: (audio.length - 44) / 32000 });
    await new Promise((resolve, reject) => {
      const t = setTimeout(resolve, delays[n] || 0);
      init.signal?.addEventListener('abort', () => { clearTimeout(t); reject(new Error('aborted')); });
    });
    if (n === fail) return { ok: false, status: 500, json: async () => ({ message: 'secret sk-leak' }) };
    return { ok: true, status: 200, json: async () => ({ output: { text: `第${n + 1}段。` } }) };
  };
  return { impl, calls };
}

async function main() {
  // 套餐 Key 只认套餐端点。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-plan-'));
  assert.equal(plan.tokenPlanKey(dir), '');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ acp: { apiKey: 'sk-sp-test', baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }));
  assert.equal(plan.tokenPlanKey(dir), 'sk-sp-test');
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ acp: { apiKey: 'sk-other', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1' } }));
  assert.equal(plan.tokenPlanKey(dir), '');

  // 降采样：48k → 16k 长度为三分之一，WAV 头声明 16k。
  const pcm48 = speech([['say', 1]], 48000);
  assert.equal(plan.toRate16k(pcm48, 48000).length, 32000);
  const header = plan.wav(Buffer.alloc(320));
  assert.equal(header.toString('ascii', 0, 4), 'RIFF'); assert.equal(header.readUInt32LE(24), 16000); assert.equal(header.readUInt32LE(40), 320);

  // 切段：在 8 秒后的停顿处切；无停顿时最长 30 秒；短录音不切。
  const parts = plan.splitAtPauses(speech([['say', 9], ['quiet', 1], ['say', 9], ['quiet', 1], ['say', 3]]));
  assert.equal(parts.length, 3);
  assert(Math.abs(parts[0].length / 32000 - 9.5) < 0.3, `first cut ${parts[0].length / 32000}`);
  assert.equal(parts.reduce((s, p) => s + p.length, 0), speech([['say', 9], ['quiet', 1], ['say', 9], ['quiet', 1], ['say', 3]]).length);
  assert(plan.splitAtPauses(speech([['say', 70]])).every(p => p.length / 32000 <= 30));
  assert.equal(plan.splitAtPauses(speech([['say', 5]])).length, 1);
  assert.equal(plan.joinTexts(['用 Claude', 'Codex 跑。', '好']), '用 Claude Codex 跑。好');

  // 整段识别（手机）：并发、按原顺序拼接，词表与领域说明随请求发送。
  const slow = fakeFetch({ delays: [60, 0, 0] });
  const text = await plan.transcribePcm(speech([['say', 9], ['quiet', 1], ['say', 9], ['quiet', 1], ['say', 3]]),
    { apiKey: 'sk-sp-test', profile: { terms: 'SRS\nSuperRAN', context: '无线仿真' }, fetchImpl: slow.impl });
  assert.equal(text, '第1段。第2段。第3段。');
  assert.equal(slow.calls.length, 3);
  assert.equal(slow.calls[0].url, 'https://token-plan.cn-beijing.maas.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
  assert.equal(slow.calls[0].auth, 'Bearer sk-sp-test');
  assert.equal(slow.calls[0].body.model, 'qwen-audio-3.0-asr-flash');
  assert.deepEqual(slow.calls[0].body.parameters.vocabulary, { SRS: 3, SuperRAN: 3 });
  assert.equal(slow.calls[0].body.input.messages[0].content[0].text, '无线仿真');
  // 纯静音段不送（服务端会回 400，且静音也计费）；全静音录音得到空文字、零请求。
  const silentTail = fakeFetch();
  assert.equal(await plan.transcribePcm(speech([['say', 9], ['quiet', 12]]), { apiKey: 'k', profile: {}, fetchImpl: silentTail.impl }), '第1段。');
  assert.equal(silentTail.calls.length, 1);
  const allQuiet = fakeFetch();
  assert.equal(await plan.transcribePcm(speech([['quiet', 15]]), { apiKey: 'k', profile: {}, fetchImpl: allQuiet.impl }), '');
  assert.equal(allQuiet.calls.length, 0);
  const failing = fakeFetch({ fail: 1 });
  await assert.rejects(plan.transcribePcm(speech([['say', 9], ['quiet', 1], ['say', 9]]), { apiKey: 'k', profile: {}, fetchImpl: failing.impl }),
    e => /HTTP 500/.test(e.message) && !/sk-leak/.test(e.message));

  // 电脑端边录边识别：48k 分块喂入，停顿处出 partial，停止后补尾段、只发一次 done。
  const live = fakeFetch(), events = [];
  const rec = new plan.RecordedVoice({ apiKey: 'k', sampleRate: 48000, profile: {}, fetchImpl: live.impl, onEvent: e => events.push(e) });
  await rec.ready;
  const audio = speech([['say', 9], ['quiet', 1], ['say', 4]], 48000);
  for (let at = 0; at < audio.length; at += 9601) await rec.audio(audio.subarray(at, at + 9601)); // 奇数块，验证半个采样的衔接
  await new Promise(r => setTimeout(r, 20));
  assert.equal(live.calls.length, 1); assert.equal(events.at(-1).type, 'partial'); assert.equal(events.at(-1).text, '第1段。');
  await rec.finish();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(live.calls.length, 2);
  assert(Math.abs(live.calls.reduce((s, c) => s + c.seconds, 0) - 14) < 0.05);
  assert.deepEqual(events.filter(e => e.type === 'done'), [{ type: 'done', text: '第1段。第2段。', via: { tokenplan: 2 } }]);
  await assert.rejects(rec.audio(Buffer.alloc(2)), /结束/);
  // 停止前有一段静音尾巴：只送有声的部分，done 正常。
  const tail = fakeFetch(), tailEvents = [];
  const tailRec = new plan.RecordedVoice({ apiKey: 'k', sampleRate: 16000, profile: {}, fetchImpl: tail.impl, onEvent: e => tailEvents.push(e) });
  const withTail = speech([['say', 9], ['quiet', 1], ['say', 3], ['quiet', 9]]);
  for (let at = 0; at < withTail.length; at += 32000) await tailRec.audio(withTail.subarray(at, at + 32000));
  await tailRec.finish(); await new Promise(r => setTimeout(r, 20));
  assert.equal(tail.calls.length, 2); assert.equal(tailEvents.at(-1).type, 'done');

  // 取消会中止在途请求，不再发事件；超长录音报错。
  const hang = fakeFetch({ delays: [10000] }), quiet = [];
  const cancelled = new plan.RecordedVoice({ apiKey: 'k', sampleRate: 16000, profile: {}, fetchImpl: hang.impl, onEvent: e => quiet.push(e) });
  const three = speech([['say', 3]]); for (let at = 0; at < three.length; at += 32000) await cancelled.audio(three.subarray(at, at + 32000));
  await cancelled.finish(); cancelled.cancel();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(quiet.length, 0);
  const long = new plan.RecordedVoice({ apiKey: 'k', sampleRate: 16000, profile: {}, fetchImpl: fakeFetch().impl, onEvent: () => {}, maxSeconds: 1 });
  await assert.rejects(long.audio(speech([['say', 1.5]])), /过长/);
  assert.throws(() => new plan.RecordedVoice({ apiKey: '', sampleRate: 16000, onEvent: () => {} }), /套餐 Key/);
  console.log('PASS voice tokenplan: key scope, engine default, resample, pause split, ordered concurrency, live partials, cancel, limits');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
