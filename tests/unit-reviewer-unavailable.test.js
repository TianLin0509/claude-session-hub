'use strict';
/**
 * 「评审席位不可用」与「答了但没给裁决」必须分开 —— 这两者对维护者的意义完全不同。
 *
 * 实测事故（2026-09-05 B5 验收）：合并位整轮只回了一句
 *   "You've hit your session limit · resets 6am (America/Los_Angeles)"
 * 引擎当它「没给裁决」保守判 fail，于是又派工作位重做两轮。
 * 工作位每轮都正确回答「阻断项是评审没出裁决，我改不了」——
 * 白烧两轮 token，最后报「返工用尽」。
 *
 * 维护者看到的是「任务太难做不完」，真实原因却是**换个评审就好**。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const LC = require('../renderer/loop-workflow.js');
const DP = require('../renderer/dev-progress.js');

let pass = 0;
function test(name, fn) { fn(); pass++; console.log('  ✓ ' + name); }

console.log('reviewer-unavailable');

const REAL = "You've hit your session limit · resets 6am (America/Los_Angeles)";

test('认得出实测那句原话', () => {
  assert.strictEqual(LC.looksUnavailable(REAL), true);
});

test('额度 / 限流 / 鉴权 三类都认', () => {
  const cases = [
    'usage limit reached',
    'rate limit exceeded',
    'quota exceeded',
    'insufficient quota',
    '额度已用尽',
    '配额不足',
    '请求过于频繁',
    '403 Forbidden',
    'Please run /login',
    'not authenticated',
  ];
  for (const t of cases) {
    assert.strictEqual(LC.looksUnavailable(t), true, '应该认出：' + t);
  }
});

test('判据必须窄：正常裁决和普通回答不被误伤', () => {
  const cases = [
    'RESULT: PASS\nBLOCKERS: 无\nVERIFIED: 跑了 345 条\nNEXT: 无',
    'RESULT: FAIL\nBLOCKERS: 空列表没测\nVERIFIED: 1 条红\nNEXT: 补测试',
    '我看了 diff，实现是对的',
    '',
    null,
    undefined,
  ];
  for (const t of cases) {
    assert.strictEqual(LC.looksUnavailable(t), false, '不该误判：' + String(t).slice(0, 30));
  }
});

test('长回答里讨论限流不算席位挂了（否则一篇讲限流的审查意见会被误杀）', () => {
  const essay = '这个报错是 rate limit exceeded，正确做法是加指数退避重试并降低并发。'.repeat(15);
  assert(essay.length > 400);
  assert.strictEqual(LC.looksUnavailable(essay), false);
});

test('它和 parseVerdict 是两个正交的判断', () => {
  // 席位挂了：解析不出裁决，但能被单独认出来
  assert.strictEqual(LC.parseVerdict(REAL), null);
  assert.strictEqual(LC.looksUnavailable(REAL), true);
  // 真实 FAIL：能解析出裁决，且不是席位问题
  const realFail = 'RESULT: FAIL\nBLOCKERS: 边界没测';
  assert.strictEqual(LC.parseVerdict(realFail).decision, 'fail');
  assert.strictEqual(LC.looksUnavailable(realFail), false);
});

test('看板给它专属说法，不跟「返工用尽」混为一谈', () => {
  const mk = (status, round) => DP.deriveStage({
    serialWorkflow: { loop: { maxRounds: 3 }, loopState: { status, round: round || 0 } },
  });
  const noRev = mk('reviewer_unavailable', 1);
  assert.strictEqual(noRev.key, 'noReviewer');
  assert(/额度|登录/.test(noRev.label), '要说清是额度还是登录，别只说失败：' + noRev.label);
  assert.strictEqual(noRev.tone, 'bad');
  // 两者必须是不同说法：前者换个人就好，后者是任务本身的问题
  assert.notStrictEqual(noRev.label, mk('stopped_max', 3).label);
});

test('引擎里确实接了这条早停路径，不是只加了个函数', () => {
  // 光有检测函数没用 —— 引擎不调用的话照样白烧三轮。用源码断言守住接线。
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'main/groupchat/loop-engine.js'), 'utf-8');
  assert(/LC\.looksUnavailable\(/.test(src), '引擎必须调用 looksUnavailable');
  assert(/reviewer_unavailable/.test(src), '引擎必须写出这个专属终态');
  assert(/unavailable\.length === reviews\.length/.test(src),
    '必须是「所有评审都不可用」才早停，单个评审挂了不该影响多评审场景');
});

test('源码里不得混入控制字符（会让正则静默失效）', () => {
  // 这条是被坑出来的：用非 raw 字符串写词边界转义时，落盘变成了字面的退格符 0x08。
  // 正则看起来一模一样、node --check 也过，但永远匹配不上 —— 肉眼根本看不出来。
  // 典型的静默失效，不写这条测试就只能等它在生产里咬人。
  //
  // 逐字符按码位判，不用正则 —— 检查控制字符的东西自己不能带控制字符或转义歧义。
  // 允许 tab(9) / LF(10) / CR(13)；其余 C0 控制字符出现在源码里都是事故。
  const REPO = path.resolve(__dirname, '..');
  const targets = [
    'renderer/loop-workflow.js', 'renderer/dev-progress.js', 'renderer/ran.js',
    'main/groupchat/loop-engine.js', 'core/transcript-tap.js',
  ];
  const isBadCtrl = (c) => c < 9 || c === 11 || c === 12 || (c > 13 && c < 32);
  for (const rel of targets) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf-8');
    let at = -1;
    let code = 0;
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      if (isBadCtrl(c)) { at = i; code = c; break; }
    }
    assert.strictEqual(at, -1,
      rel + ' 第 ' + at + ' 字节混进了控制字符 U+'
      + code.toString(16).padStart(4, '0') + '，正则或字符串会静默失效');
  }
});

console.log('\n──────────────');
console.log('通过 ' + pass + ' / 失败 0');
