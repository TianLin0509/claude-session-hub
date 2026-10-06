'use strict';
const assert = require('assert/strict');
const { LiveVoice } = require('../core/voice-live');

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));
function speech(sec, freq = 7) { const b = Buffer.alloc(Math.round(sec * 16000) * 2); for (let i = 0; i < b.length / 2; i++) b.writeInt16LE(Math.round(6000 * Math.sin(i / freq)), i * 2); return b; }
const pause = sec => Buffer.alloc(Math.round(sec * 16000) * 2);
async function feed(v, pcm, chunk = 3200, ms = 0) { for (let at = 0; at < pcm.length; at += chunk) { await v.audio(pcm.subarray(at, at + chunk)); if (ms) await tick(ms); } }
const fakeLocal = (ready = true) => ({ ready, calls: [], async transcribe(pcms) { this.calls.push(pcms[0].length / 32000); return [`本地${(pcms[0].length / 32000).toFixed(0)}秒`]; } });
// 模拟实时 API（VoiceStream 接口）：收到的音频每满 1 秒出一个「句子」；finish 后发 done。
function fakeApi({ failAfter = Infinity } = {}) {
  const api = { sent: 0, finished: false, cancelled: false, sentences: new Map() };
  api.factory = onEvent => {
    api.onEvent = onEvent;
    return { ready: Promise.resolve(), sentences: api.sentences,
      async audio(chunk) {
        api.sent += chunk.length;
        const sec = Math.floor(api.sent / 32000);
        if (sec >= failAfter) { onEvent({ type: 'error', message: '额度已停' }); return; }
        if (sec > api.sentences.size) { api.sentences.set(sec, { text: `实时${sec}。`, final: true, begin: (sec - 1) * 1000, end: sec * 1000 }); onEvent({ type: 'partial', text: [...api.sentences.values()].map(s => s.text).join('') }); }
      },
      async finish() { api.finished = true; setTimeout(() => onEvent({ type: 'done', text: [...api.sentences.values()].map(s => s.text).join('') }), 2); return true; },
      cancel() { api.cancelled = true; } };
  };
  return api;
}
const segmentBy = local => async pcm => ({ text: `定稿${(pcm.length / 32000).toFixed(0)}秒`, via: local.ready ? 'local' : 'tokenplan', me: null, removed: 0, otherOnly: false });

async function main() {
  // 1) 本地已就绪：说话途中滚动预览出字；停顿处定稿；全程不开实时 API。
  {
    const local = fakeLocal(true), events = [], api = fakeApi();
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: api.factory, onEvent: e => events.push(e), rollingMs: 10, log: () => {} });
    await feed(v, speech(3), 3200, 3);
    assert(events.some(e => e.type === 'partial' && /本地\d秒/.test(e.text)), '说话途中应有本地滚动预览');
    assert.equal(api.onEvent, undefined, '本地已就绪时不开实时 API');
    await feed(v, Buffer.concat([speech(6), pause(1), speech(2)]));
    await v.finish(); await tick(30);
    const done = events.find(e => e.type === 'done');
    assert.deepEqual(done.via, { local: 2 });
    assert.match(done.text, /^定稿(9|10)秒定稿[23]秒$/);
  }
  // 1b) 小停顿（0.4 秒）切成小句：滚动识别只重识别停顿之后的那一截，窗口不随整句变长；停顿前的小句单独识别定下。
  {
    const local = fakeLocal(true), events = [];
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: () => null, onEvent: e => events.push(e), rollingMs: 10, log: () => {} });
    await feed(v, Buffer.concat([speech(2.5), pause(0.4), speech(2.5), pause(0.4), speech(2.5)]), 3200, 3);
    assert(Math.max(...local.calls) < 4, '滚动窗口应在小停顿处重新开始：' + Math.max(...local.calls));
    assert(events.at(-1).text.split('本地').length - 1 >= 3, '前面的小句应已定下、显示在预览之前：' + events.at(-1).text);
    assert.equal(events.at(-1).route, 'local');
    v.cancel();
  }
  // 2) 冷启动：先走实时 API 逐字出；本地装好后在下一个停顿处切到本地，实时 API 收尾。
  {
    const local = fakeLocal(false), events = [], api = fakeApi(), usage = [];
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: api.factory, onEvent: e => events.push(e), usage: u => usage.push(u), rollingMs: 10, log: () => {} });
    await feed(v, speech(4));
    assert(events.some(e => /实时3。/.test(e.text)), '冷启动期间实时 API 逐句出字');
    local.ready = true;
    await feed(v, Buffer.concat([speech(5), pause(1)]));
    assert(api.finished, '本地就绪后在停顿处结束实时 API');
    const apiBytes = api.sent;
    await feed(v, speech(3), 3200, 2);
    assert.equal(api.sent, apiBytes, '切换后音频不再发给实时 API');
    await v.finish(); await tick(30);
    const done = events.find(e => e.type === 'done');
    assert.equal(done.via.realtime, 1); assert.equal(done.via.local, 1);
    assert(done.text.startsWith('实时1。') && /定稿[34]秒$/.test(done.text), done.text);
    assert.equal(usage[0].via, 'realtime'); assert(Math.abs(usage[0].sec - 9.5) < 0.6, '实时 API 只计到切换点：' + usage[0].sec);
  }
  // 3) 没有实时 API（未配 Key / 额度停用）：未就绪期间按段交 Token Plan。
  {
    const local = fakeLocal(false), events = [];
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: () => null, onEvent: e => events.push(e), log: () => {} });
    await feed(v, Buffer.concat([speech(9), pause(1), speech(2)]));
    await v.finish(); await tick(30);
    assert.deepEqual(events.find(e => e.type === 'done').via, { tokenplan: 2 });
  }
  // 4) 实时 API 中途失败：已出的句子保留，其后录音补交接力，不丢字。
  {
    const local = fakeLocal(false), events = [], api = fakeApi({ failAfter: 3 });
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: api.factory, onEvent: e => events.push(e), log: () => {} });
    await feed(v, Buffer.concat([speech(9), pause(1), speech(3)]));
    await v.finish(); await tick(30);
    const done = events.find(e => e.type === 'done');
    assert(done.text.startsWith('实时1。实时2。'), done.text);
    assert(/定稿/.test(done.text), '失败后的录音应补交识别：' + done.text);
    assert.equal(events.filter(e => e.type === 'error').length, 0, '实时 API 失败不应让整条录音报错');
  }
  // 5) 取消：停止计时并关闭实时 API。
  {
    const local = fakeLocal(false), api = fakeApi();
    const v = new LiveVoice({ sampleRate: 16000, local, recognizeSegment: segmentBy(local), openApi: api.factory, onEvent: () => {}, log: () => {} });
    await feed(v, speech(1)); v.cancel(); assert(api.cancelled);
    await assert.rejects(v.audio(Buffer.alloc(2)), /结束/);
  }
  console.log('PASS voice live: local rolling preview, cold-start realtime relay + switch at pause, no-API token plan relay, realtime failure recovery, cancel');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
