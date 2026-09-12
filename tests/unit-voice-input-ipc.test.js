'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-ipc-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
delete process.env.DASHSCOPE_API_KEY;
const { registerVoiceInputIpc } = require('../main/ipc/voice-input-handlers');
const handlers = new Map(), app = new EventEmitter(), streams = [];
const storage = { isEncryptionAvailable: () => true, encryptString: text => Buffer.from(text.split('').reverse().join('')), decryptString: bytes => bytes.toString().split('').reverse().join('') };
const createStream = options => {
  let resolve, reject;
  const stream = { options, ready: new Promise((r, j) => { resolve = r; reject = j; }),
    audio: async () => {}, finish: async () => true, cancel() { this.cancelled = true; reject(new Error('cancelled')); }, resolve: () => resolve() };
  streams.push(stream); return stream;
};
const sender = id => Object.assign(new EventEmitter(), { id, isDestroyed: () => false, events: [], send(_name, value) { this.events.push(value); } });
async function main() {
  registerVoiceInputIpc({ handle: (name, fn) => handlers.set(name, fn) }, { app, safeStorage: storage, createStream });
  const one = sender(1), two = sender(2);
  const call = (who, name, value) => Promise.resolve().then(() => handlers.get(name)({ sender: who }, value));
  const project = 'C:\\Project';
  assert.equal((await call(one, 'voice:config', project)).keySet, false);
  await assert.rejects(call(one, 'voice:start', { id: '1234567890abcdef', sampleRate: 48000 }), /配置/);
  await call(one, 'voice:save-config', { region: 'beijing', project, apiKey: 'secret-for-test', profile: { terms: 'SRS', context: '通信' } });
  const disk = fs.readFileSync(path.join(root, 'voice-input.json'), 'utf8'); assert(!disk.includes('secret-for-test'));
  const settings = await call(one, 'voice:config', 'c:/project'); assert.equal(settings.profile.terms, 'SRS'); assert(!JSON.stringify(settings).includes('secret-for-test'));
  assert.equal((await call(one, 'voice:config', 'c:/another')).profile.terms, '');
  const req = { id: '1234567890abcdef', project, sampleRate: 48000 };
  const start = call(one, 'voice:start', req); await new Promise(resolve => setImmediate(resolve));
  assert.equal(streams[0].options.apiKey, 'secret-for-test'); assert.equal(streams[0].options.profile.terms, 'SRS');
  await assert.rejects(call(one, 'voice:start', req), /已有录音/);
  await assert.rejects(call(two, 'voice:audio', { id: req.id, data: [0, 0] }), /不属于/);
  await assert.rejects(call(one, 'voice:save-config', { region: 'beijing' }), /停止/);
  await call(two, 'voice:cancel', req.id); assert(!streams[0].cancelled);
  await call(one, 'voice:cancel', req.id); await assert.rejects(start, /cancelled/);
  assert(streams[0].cancelled);
  // A cancelled provider callback cannot corrupt the next recording.
  const next = call(one, 'voice:start', { ...req, id: 'fedcba0987654321' }); await new Promise(resolve => setImmediate(resolve));
  streams[1].resolve(); await next;
  streams[0].options.onEvent({ type: 'done', text: 'stale' }); assert.equal(one.events.length, 0);
  streams[1].options.onEvent({ type: 'done', text: 'result' }); assert.equal(one.events.length, 1); assert.equal(one.events[0].id, 'fedcba0987654321');
  const third = call(one, 'voice:start', req); await new Promise(resolve => setImmediate(resolve)); streams[2].resolve(); await third;
  one.emit('did-start-navigation', {}, 'file://reload', false, true); assert(streams[2].cancelled);
  const fourth = call(two, 'voice:start', req); await new Promise(resolve => setImmediate(resolve)); streams[3].resolve(); await fourth;
  two.emit('destroyed'); assert(streams[3].cancelled);
  storage.isEncryptionAvailable = () => false;
  await assert.rejects(call(one, 'voice:save-config', { region: 'beijing', apiKey: 'new' }), /加密/);
  assert.equal(fs.readFileSync(path.join(root, 'voice-input.json'), 'utf8'), disk);
  await call(one, 'voice:save-config', { region: 'beijing', clearKey: true, project, profile: {} });
  assert.equal((await call(one, 'voice:config', project)).keySet, false);
  fs.writeFileSync(path.join(root, 'voice-input.json'), 'corrupt');
  await assert.rejects(call(one, 'voice:config'), /读取失败/);
  console.log('PASS voice IPC: encrypted config, project scope, window ownership, startup cancellation, stale callback, reload/destroy cleanup, save failures');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
