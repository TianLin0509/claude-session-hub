'use strict';
const assert = require('assert/strict');
const { EventEmitter } = require('events');
const fs = require('fs'), os = require('os'), path = require('path');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-learn-'));
process.env.CLAUDE_HUB_DATA_DIR = root;
process.env.HUB_LOCAL_ASR_PYTHON = path.join(root, 'no-python.exe');
delete process.env.DASHSCOPE_API_KEY;
const { correctionPairs } = require('../core/voice-text');
const { registerVoiceInputIpc, normalizePrefs, inWindow } = require('../main/ipc/voice-input-handlers');

// 纠错识别：短词替换才学；改半个词补成完整词；大段改写、单纯补充不学
const cases = [
  ['林田让王思雨晚上把念念的作业拍给他看。', '林田让王思妤晚上把念念的作业拍给他看。', [['王思雨', '王思妤']]],
  ['让cloud跑一遍单测', '让Claude跑一遍单测', [['cloud', 'Claude']]],
  ['检查super ran的仿真结果', '检查SuperRAN的仿真结果', [['super ran', 'SuperRAN']]],
  ['作手铃铛的报告', '作手林铛的报告', [['作手铃铛', '作手林铛']]],
  ['韩先触和黄永胜', '韩先楚和黄永胜', [['韩先触', '韩先楚']]],
  ['这个方案不太行我们再想想', '我觉得应该换个思路，先把需求理清楚再说', []],
  ['明天下午三点开会', '明天下午三点开会，记得带电脑', []],
  ['一样的文字', '一样的文字', []],
];
for (const [o, e, expected] of cases) assert.deepEqual(correctionPairs(o, e).map(p => [p.wrong, p.right]), expected, `${o} → ${e}`);

// 偏好：默认值、校验、常驻时段（含跨午夜）
assert.deepEqual(normalizePrefs({}), { voiceSend: true, autoStopSec: 0, keepWarm: { enabled: false, from: '09:00', to: '22:00' } });
assert.throws(() => normalizePrefs({ autoStopSec: 20 }), /1～10/);
assert.throws(() => normalizePrefs({ keepWarm: { from: '9点' } }), /HH:MM/);
assert.equal(inWindow({ enabled: true, from: '09:00', to: '22:00' }, new Date(2026, 9, 6, 10, 0)), true);
assert.equal(inWindow({ enabled: true, from: '09:00', to: '22:00' }, new Date(2026, 9, 6, 23, 0)), false);
assert.equal(inWindow({ enabled: true, from: '22:00', to: '02:00' }, new Date(2026, 9, 6, 1, 0)), true);
assert.equal(inWindow({ enabled: false, from: '00:00', to: '23:59' }), false);

// IPC：学会的词进通用热词、记次数，可撤销；偏好可保存读取
const handlers = new Map();
registerVoiceInputIpc({ handle: (n, fn) => handlers.set(n, fn) }, { app: new EventEmitter(), safeStorage: { isEncryptionAvailable: () => true, encryptString: s => Buffer.from(s), decryptString: b => b.toString() }, envStartDelayMs: 1e9 });
const call = (n, v) => Promise.resolve().then(() => handlers.get(n)({ sender: { id: 1 } }, v));
(async () => {
  await call('voice:save-config', { region: 'beijing', project: 'C:/p', profile: {}, global: { terms: 'Claude', personal: '' }, prefs: { voiceSend: false, autoStopSec: 2, keepWarm: { enabled: true, from: '08:30', to: '21:00' } } });
  let view = await call('voice:config', 'C:/p');
  assert.deepEqual(view.prefs, { voiceSend: false, autoStopSec: 2, keepWarm: { enabled: true, from: '08:30', to: '21:00' } });
  const r = await call('voice:learn', { original: '林田让王思雨晚上把念念的作业拍给他看。', edited: '林田让王思妤晚上把念念的作业拍给他看。' });
  assert.deepEqual(r.added, [{ wrong: '王思雨', right: '王思妤' }]);
  assert.deepEqual((await call('voice:learn', { original: '林田让王思雨晚上把念念的作业拍给他看。', edited: '林田让王思妤晚上把念念的作业拍给他看。' })).added, [], '已在词库的不重复添加');
  view = await call('voice:config', 'C:/p');
  assert.equal(view.global.terms, 'Claude\n王思妤'); assert.equal(view.learnedCount, 1);
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'voice-input.json'), 'utf8'));
  assert.equal(saved.learned[0].count, 2); assert.deepEqual(saved.learned[0].wrongs, ['王思雨']);
  assert.deepEqual((await call('voice:learn', { original: '这个方案不太行', edited: '完全不同的一段新内容，重新写过' })).added, []);
  await call('voice:unlearn', { right: '王思妤' });
  view = await call('voice:config', 'C:/p');
  assert.equal(view.global.terms, 'Claude'); assert.equal(view.learnedCount, 0);

  // 说话检测：本机装了模型才测（没装时退回音量判断，属正常）
  const vad = require('../core/voice-vad');
  if (await vad.load()) {
    const s = new vad.VadStream();
    const quiet = s.push(Buffer.alloc(32000));
    assert.equal(quiet.length, 50); assert(quiet.every(v => v === 0), '纯静音不应判为说话');
    s.destroy(); s.destroy();
    console.log('PASS voice learn: correction pairs, prefs + keep-warm window, learn/unlearn IPC, VAD silence');
  } else console.log('PASS voice learn: correction pairs, prefs + keep-warm window, learn/unlearn IPC (VAD model absent, skipped)');
})().catch(error => { console.error(error); process.exitCode = 1; });
