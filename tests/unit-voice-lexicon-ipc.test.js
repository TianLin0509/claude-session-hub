'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-lexicon-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
delete process.env.DASHSCOPE_API_KEY;
// 让「本地识别已安装」成立（假环境与假模型目录）
const py = path.join(root, 'python.exe'), model = path.join(root, 'model');
fs.writeFileSync(py, ''); fs.mkdirSync(model); fs.writeFileSync(path.join(model, 'config.json'), '{}');
process.env.HUB_LOCAL_ASR_PYTHON = py; process.env.HUB_LOCAL_ASR_MODEL = model;
process.env.DASHSCOPE_API_KEY = 'metered-for-test';
const { registerVoiceInputIpc } = require('../main/ipc/voice-input-handlers');

const handlers = new Map(), app = new EventEmitter();
const storage = { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() };
const fakeLocal = { ready: true, state: 'ready', prepare: async () => true, start() {}, stop() {} };
let live = null, apiProfile = null, askedSession = null;
registerVoiceInputIpc({ handle: (n, fn) => handlers.set(n, fn) }, {
  app, safeStorage: storage, getLocal: () => fakeLocal, getSpeaker: () => null, envStartDelayMs: 1e9,
  getRecentContext: async id => { askedSession = id; return '刚才在聊 SuperRAN 的 PMI'; },
  createStream: options => { apiProfile = options.profile; return { ready: Promise.resolve(), cancel() {} }; },
  createLive: options => { live = options; options.openApi(() => {}); return { ready: Promise.resolve(), cancel() {} }; },
});
const sender = Object.assign(new EventEmitter(), { id: 1, isDestroyed: () => false, events: [], send(_n, v) { this.events.push(v); } });
const call = (name, value) => Promise.resolve().then(() => handlers.get(name)({ sender }, value));

(async () => {
  const project = 'C:\\Proj';
  await call('voice:save-config', { region: 'beijing', project, engine: 'local', profile: { terms: 'SRS', context: '' },
    global: { terms: 'Claude\nSuperRAN', personal: '我是林田，女儿念念。' } });
  const view = await call('voice:config', project);
  assert.deepEqual(view.global, { terms: 'Claude\nSuperRAN', personal: '我是林田，女儿念念。' });
  await assert.rejects(call('voice:save-config', { region: 'beijing', project, global: { personal: '字'.repeat(2001) } }), /2000/);

  await call('voice:start', { id: '1234567890abcdef', project, sessionId: 'hub-session-1', sampleRate: 48000 });
  assert.equal(askedSession, 'hub-session-1', '应按当前会话取动态背景');
  assert(live.context.includes('我是林田，女儿念念。') && live.context.includes('Claude') && live.context.includes('SRS') && live.context.includes('刚才在聊 SuperRAN'),
    '本地背景应含个人背景、全部热词与最近对话：' + live.context);
  assert(apiProfile.terms.includes('SRS') && apiProfile.terms.includes('Claude'), '云端接力仍带热词');
  assert(!JSON.stringify(apiProfile).includes('念念') && !JSON.stringify(apiProfile).includes('刚才在聊'), '个人背景与对话不得发给云端');
  // 所有识别结果发回界面前去掉语气词
  live.onEvent({ type: 'partial', text: '嗯，林田让念念，呃，把作业拍给他看' });
  assert.equal(sender.events.at(-1).text, '林田让念念，把作业拍给他看');
  console.log('PASS voice lexicon IPC: global lexicon saved, dynamic context per session, local-only personal background, cloud terms only, fillers cleaned');
})().catch(error => { console.error(error); process.exitCode = 1; });
