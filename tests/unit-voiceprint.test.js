'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const voiceprint = require('../core/voiceprint');
const voiceEngine = require('../core/voice-engine');
const plan = require('../core/voice-tokenplan');

function speech(sec, freq = 7) { const b = Buffer.alloc(Math.round(sec * 16000) * 2); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / freq)), i * 2); return b; }
const unit = v => { const n = Math.hypot(...v); return v.map(x => x / n); };
const ME = unit([1, 0, 0]), OTHER = unit([0, 1, 0]);
// 模拟声纹 worker：频率参数 7 的合成音当「本人」，其余当「他人」。
// 按有声部分的过零率区分：频率参数 7 的周期短（过零更密）。
function crossingRate(p) { let n = 0, voiced = 0, prev = 0; for (let i = 0; i < p.length / 2; i++) { const v = p.readInt16LE(i * 2); if (v === 0) continue; voiced++; if (prev && Math.sign(v) !== Math.sign(prev)) n++; prev = v; } return voiced ? n / voiced : 0; }
const fakeSpeaker = { embed: async (pcms) => pcms.map(p => (crossingRate(p) > 0.037 ? ME : OTHER)) };

async function main() {
  // 小句切分：0.3 秒以上的安静切开。
  const utt = voiceprint.utterances(Buffer.concat([speech(3), Buffer.alloc(32000 * 0.4), speech(2)]), plan.frameLevels);
  assert.equal(utt.length, 2); assert(Math.abs(utt[1][0] / 32000 - 3.4) < 0.05);
  assert(Math.abs(voiceprint.cosine([1, 2, 3], [2, 4, 6]) - 1) < 1e-9);

  // 录入：有效说话不足 10 秒拒绝；成功只存向量；开关与门槛校验；删除。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voiceprint-'));
  assert.equal(voiceprint.status(dir).enrolled, false); assert.equal(voiceprint.active(dir), null);
  await assert.rejects(voiceprint.enroll(dir, Buffer.concat([speech(6), Buffer.alloc(32000 * 10)]), { speaker: fakeSpeaker, frameLevels: plan.frameLevels }), /至少 10 秒/);
  const enrolled = await voiceprint.enroll(dir, speech(20), { speaker: fakeSpeaker, frameLevels: plan.frameLevels });
  assert.equal(enrolled.enrolled, true); assert.equal(enrolled.enabled, true); assert.equal(enrolled.threshold, 0.4);
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(path.join(dir, 'voiceprint.json'), 'utf8'))).sort(), ['adapted', 'enabled', 'enrolledAt', 'enrolledVector', 'model', 'seconds', 'threshold', 'vector']);
  assert.throws(() => voiceprint.setOptions(dir, { threshold: 0.95 }), /0.1～0.8/);
  voiceprint.setOptions(dir, { enabled: false }); assert.equal(voiceprint.active(dir), null);
  voiceprint.setOptions(dir, { enabled: true, threshold: 0.35 }); assert.equal(voiceprint.active(dir).threshold, 0.35);
  const vp = { profile: voiceprint.active(dir), speaker: fakeSpeaker };

  // 段内筛查：确认本人后，他人小句静音；尚未确认本人时全是他人的段落原样保留并标记。
  const gap = Buffer.alloc(Math.round(32000 * 0.4));
  const inner = Buffer.concat([speech(4, 7), gap, speech(4, 11), gap, speech(4, 7)]);
  const st = { seenMe: false };
  const s1 = await voiceprint.screen(inner, { vp, state: st, frameLevels: plan.frameLevels });
  assert.equal(s1.me, 2); assert.equal(s1.removed, 1); assert(st.seenMe);
  assert(s1.pcm.subarray(Math.round(32000 * 4.6), Math.round(32000 * 8.2)).every(b => b === 0), '他人小句应静音');
  assert(s1.pcm.subarray(0, 32000 * 3).some(b => b !== 0), '本人小句保留');
  const s2 = await voiceprint.screen(speech(4, 11), { vp, state: { seenMe: false }, frameLevels: plan.frameLevels });
  assert.deepEqual([s2.me, s2.removed, s2.otherOnly], [0, 0, true]);

  // 手机整段：本人 + 他人两段 → 只留本人；账本记下分数与滤掉段数。
  const usage = [];
  const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ output: { text: '一段。' } }) });
  const mixed = Buffer.concat([speech(9, 7), Buffer.alloc(32000), speech(9, 11)]);
  const r = await voiceEngine.transcribeRecording(mixed, { engine: 'tokenplan', planKey: 'k', profile: {}, vp, fetchImpl, usage: u => usage.push(u) });
  assert.deepEqual(r, { text: '一段。', via: { tokenplan: 1, filtered: 1 } });
  assert.deepEqual(usage[0].scores.map(s => s.map(Math.round)), [[1], [0]]); assert.equal(usage[0].filtered, 1);
  // 全是他人（多半是换了麦克风）：全部保留。
  const others = await voiceEngine.transcribeRecording(Buffer.concat([speech(9, 11), Buffer.alloc(32000), speech(9, 11)]), { engine: 'tokenplan', planKey: 'k', profile: {}, vp, fetchImpl });
  assert.deepEqual(others.via, { tokenplan: 2 });
  // 声纹进程出错：本次不过滤，识别照常。
  const broken = { profile: vp.profile, speaker: { embed: async () => { throw new Error('dead'); } } };
  const safe = await voiceEngine.transcribeRecording(mixed, { engine: 'tokenplan', planKey: 'k', profile: {}, vp: broken, fetchImpl, log: () => {} });
  assert.deepEqual(safe.via, { tokenplan: 2 });

  // 电脑端边录边识别：他人段在出现本人段后不进文字，done 报告滤掉段数。
  const events = [];
  const rec = new plan.RecordedVoice({ sampleRate: 16000, profile: {}, onEvent: e => events.push(e),
    recognizeSegment: voiceEngine.segmentRecognizer({ engine: 'tokenplan', planKey: 'k', profile: {}, vp, fetchImpl, source: 'desktop' }) });
  const audio = Buffer.concat([speech(9, 11), Buffer.alloc(32000), speech(9, 7), Buffer.alloc(32000)]);
  for (let at = 0; at < audio.length; at += 32000) await rec.audio(audio.subarray(at, at + 32000));
  await rec.finish(); await new Promise(r => setTimeout(r, 30));
  const done = events.find(e => e.type === 'done');
  assert.deepEqual(done, { type: 'done', text: '一段。', via: { tokenplan: 2, filtered: 1 } });
  assert.equal(voiceEngine.describeVia(done.via), 'Token Plan 2 段 · 已滤掉他人说话 1 段');
  // 声纹自动更新：只采用接近当初录入声纹的向量，每次微调；离得太远（别人）的不采用。
  const before = voiceprint.load(dir).vector;
  assert.equal(voiceprint.adapt(dir, [OTHER]), 0, '离录入声纹太远的不采用');
  const tilted = unit([1, 0.3, 0]);
  assert.equal(voiceprint.adapt(dir, [tilted, tilted]), 2);
  const after = voiceprint.load(dir);
  assert(voiceprint.cosine(after.vector, before) > 0.99 && after.vector[1] > 0, '小幅更新');
  assert.deepEqual(after.enrolledVector, ME); assert.equal(voiceprint.status(dir).adapted, 2);
  voiceprint.remove(dir); assert.equal(voiceprint.status(dir).enrolled, false);
  // 同一段里他人插话：送去识别的音频里那句已静音。
  let sent = null;
  const capture = async (_u, init) => { sent = Buffer.from(JSON.parse(init.body).input.messages.at(-1).content[0].input_audio.data.split(',')[1], 'base64').subarray(44); return { ok: true, status: 200, json: async () => ({ output: { text: '本人。' } }) }; };
  const one = await voiceEngine.transcribeRecording(inner, { engine: 'tokenplan', planKey: 'k', profile: {}, vp, fetchImpl: capture });
  assert.deepEqual(one.via, { tokenplan: 1, filtered: 1 });
  assert(sent.subarray(Math.round(32000 * 4.6), Math.round(32000 * 8.2)).every(b => b === 0));
  console.log('PASS voiceprint: utterance split, in-segment masking, other-only before/after confirmation, enroll guard, options, phone+desktop filtering, failure keeps text');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
