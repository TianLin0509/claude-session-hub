'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const vm = require('vm');
const fs = require('fs');
const { VoiceStream, endpoint, runTask, normalizeProfile } = require('../core/voice-input');
class Socket extends EventEmitter {
  constructor() { super(); this.sent = []; this.bufferedAmount = 0; }
  send(data, cb) { this.sent.push(data); cb(); }
  terminate() { this.terminated = true; this.emit('close'); }
}
function stream(overrides = {}) {
  const socket = new Socket(), events = [];
  const s = new VoiceStream({ config: { region: 'beijing' }, apiKey: 'test-key', sampleRate: 48000,
    profile: { terms: 'SINR\nSRS', context: '无线通信' }, onEvent: e => events.push(e), socketFactory: () => socket, ...overrides });
  const receive = (event, sentence, taskId = s.id) => socket.emit('message', Buffer.from(JSON.stringify({ header: { event, task_id: taskId }, payload: { output: { sentence } } })));
  socket.emit('open');
  return { s, socket, events, receive };
}
async function main() {
  assert.equal(endpoint({ region: 'singapore', workspace: 'abc-123' }), 'wss://abc-123.ap-southeast-1.maas.aliyuncs.com/api-ws/v1/inference');
  assert.throws(() => endpoint({ region: 'beijing', workspace: 'evil.example/path' }));
  assert.throws(() => normalizeProfile({ terms: Array.from({ length: 81 }, (_, i) => `word${i}`).join('\n') }));
  assert.throws(() => normalizeProfile({ context: '中'.repeat(401) }));
  assert.deepEqual(runTask('id', 48000, { terms: 'SINR, SRS,SINR', context: '无线通信' }).payload.parameters.vocabulary, { SINR: 3, SRS: 3 });
  const { s, socket, events, receive } = stream();
  assert.equal(JSON.parse(socket.sent[0]).payload.parameters.sample_rate, 48000);
  await assert.rejects(s.audio(new Uint8Array(128)), /尚未就绪/);
  receive('task-started'); await s.ready;
  await s.audio(new Uint8Array([1, 0, 255, 127]));
  assert.deepEqual([...socket.sent[1]], [1, 0, 255, 127]);
  receive('result-generated', { sentence_id: 1, text: '不要合', sentence_end: false });
  receive('result-generated', { sentence_id: 1, text: '不要合并 master。', sentence_end: true });
  receive('result-generated', { sentence_id: 1, text: '不要合并 master。', sentence_end: true });
  receive('result-generated', { sentence_id: 1, text: '过时片段', sentence_end: false });
  receive('result-generated', { sentence_id: 9, text: '错误任务' }, 'wrong-id');
  receive('result-generated', { heartbeat: true });
  receive('result-generated', { sentence_id: 2, text: 'SRS 十毫秒。', sentence_end: true });
  assert.equal(s.text(), '不要合并 master。SRS 十毫秒。');
  await s.finish();
  assert.equal(events.filter(e => e.type === 'done').length, 0);
  assert.equal(JSON.parse(socket.sent.at(-1)).header.action, 'finish-task');
  receive('task-finished');
  assert.equal(events.at(-1).type, 'done'); assert.equal(events.at(-1).text, s.text()); assert(socket.terminated);
  receive('task-finished'); assert.equal(events.filter(e => e.type === 'done').length, 1);

  const early = stream(); early.receive('task-started'); await early.s.ready;
  early.receive('result-generated', { sentence_id: 1, text: '临时文字', sentence_end: false });
  await early.s.finish(); early.receive('task-finished');
  assert.equal(early.events.at(-1).type, 'error'); assert.equal(early.events.at(-1).text, '临时文字');
  const disconnected = stream(); disconnected.receive('task-started'); await disconnected.s.ready;
  disconnected.socket.emit('close'); assert.equal(disconnected.events.at(-1).type, 'error');
  const cancelled = stream(); const rejection = assert.rejects(cancelled.s.ready, /取消/); cancelled.s.cancel(); await rejection;
  assert.equal(cancelled.events.length, 0);
  const timeout = stream({ timeoutMs: 10 }); await assert.rejects(timeout.s.ready, /超时/); assert(timeout.socket.terminated);
  const finishTimeout = stream({ timeoutMs: 10 }); finishTimeout.receive('task-started'); await finishTimeout.s.ready; await finishTimeout.s.finish();
  await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(finishTimeout.events.at(-1).type, 'error');
  const overflow = stream(); overflow.receive('task-started'); await overflow.s.ready; overflow.socket.bufferedAmount = 48000 * 5;
  await assert.rejects(overflow.s.audio(new Uint8Array(2)), /积压/);
  const malformed = stream(); malformed.receive('task-started'); await malformed.s.ready; malformed.socket.emit('message', Buffer.from('bad'));
  assert.equal(malformed.events.at(-1).type, 'error');

  // Real worklet code, including little-endian encoding, clipping and tail flush.
  let Processor;
  const messages = [];
  vm.runInNewContext(fs.readFileSync(require.resolve('../renderer/voice-pcm-worklet'), 'utf8'), {
    AudioWorkletProcessor: class { constructor() { this.port = { postMessage: m => messages.push(m) }; } },
    registerProcessor: (_name, value) => { Processor = value; },
  });
  const pcm = new Processor(); pcm.process([[new Float32Array([-2, -1, 0, 1, 2])]]);
  assert.equal(messages.length, 0); pcm.port.onmessage({ data: 'flush' });
  assert.deepEqual([...new Int16Array(messages[0].pcm)], [-32768, -32768, 0, 32767, 32767]);
  assert.equal(messages[1].flushed, true);
  pcm.process([[new Float32Array([1])]]); assert.equal(messages.length, 2);
  console.log('PASS voice stream: protocol, sentence dedup, late events, cancellation, start/finish timeout, backpressure, PCM and tail flush');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
