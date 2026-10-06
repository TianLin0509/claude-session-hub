'use strict';
const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const t = require('../core/voice-text');

// 语气词：独立的去掉，词语里的、作语气助词的保留
const cases = [
  ['嗯，我想一下。', '我想一下。'], ['好啊。', '好啊。'], ['然后，呃，我们明天再说。', '然后，我们明天再说。'],
  ['额度不够了', '额度不够了'], ['金额，不对', '金额，不对'], ['嗯嗯，对。', '对。'], ['我觉得嗯，这个可以。', '我觉得，这个可以。'],
  ['这个，啊，SuperRAN 的仿真结果嗯。', '这个，SuperRAN 的仿真结果。'], ['哦，原来是这样啊。', '原来是这样啊。'],
  ['呃 你看一下', '你看一下'], ['是哦，那就这样。', '是哦，那就这样。'], ['嗯', ''], ['', ''],
];
for (const [input, expected] of cases) assert.equal(t.cleanFillers(input), expected, input);

// 通用词库：校验与上限
assert.deepEqual(t.normalizeGlobal({ terms: 'Claude, Codex\nClaude', personal: ' 我是林田 ' }), { terms: 'Claude\nCodex', personal: '我是林田' });
assert.throws(() => t.normalizeGlobal({ terms: Array.from({ length: 301 }, (_, i) => 'w' + i).join('\n') }), /300/);
assert.throws(() => t.normalizeGlobal({ personal: '字'.repeat(2001) }), /2000/);

// 云端词表：项目术语优先、最多 80 个、不含个人背景；本地背景：个人背景 + 全部热词 + 最近对话
const global = { terms: Array.from({ length: 100 }, (_, i) => 'g' + i).join('\n'), personal: '我是林田，女儿念念。' };
const cloud = t.cloudProfile({ terms: 'SRS\nPMI', context: '无线' }, global);
const cloudTerms = cloud.terms.split('\n');
assert.equal(cloudTerms.length, 80); assert.deepEqual(cloudTerms.slice(0, 3), ['SRS', 'PMI', 'g0']);
assert(!JSON.stringify(cloud).includes('念念'), '个人背景不得进云端词表');
const local = t.localBackground({ terms: 'SRS' }, global, '刚才聊到 SuperRAN 的信道估计');
assert(local.startsWith('我是林田，女儿念念。') && local.includes('常用词：SRS、g0') && local.includes('最近的对话：刚才聊到 SuperRAN'));
assert.equal(t.localBackground({}, {}, ''), '');

// 聊天记录 md 末尾：去掉标题、来源说明和工具行
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-text-'));
const md = path.join(dir, 'x.md');
fs.writeFileSync(md, '# 标题\n\n- 来源：claude\n- 工作目录：C:\\AIWork\n\n## 我 · 2026-10-06 10:00\n\n帮我看下 SuperRAN 的 PMI 选择\n\n## Claude · 2026-10-06 10:01\n\n> 工具 · Bash {"command":"ls"}\n\n好的，PMI 选择用的是码本搜索。\n');
const recent = t.recentFromTranscript(md);
assert(recent.includes('帮我看下 SuperRAN 的 PMI 选择') && recent.includes('码本搜索'));
assert(!/工具 ·|来源：|^#/.test(recent), recent);
assert.equal(t.recentFromTranscript(path.join(dir, 'missing.md')), '');
assert.equal([...t.recentFromTranscript(md, 10)].length, 10);
console.log('PASS voice text: filler cleanup keeps real words, global lexicon limits, cloud excludes personal, local background, transcript tail');
