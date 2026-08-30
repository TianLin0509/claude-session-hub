'use strict';

// webview 挂掉时屏幕上只有一句 `预览进程异常退出：launch-failed`。
// 2026-08-29 那次排查就是被这句话带偏的 —— 它读起来像「预览这个功能坏了」，
// 于是先去翻刚合并的代码，实际根因是运行期间品牌化 exe 被换掉
// （见 core/hub-exe-branding.js 的 brandedExeInUse）。
// 所以这里守两件事：常见 reason 必须给出「原因 + 该干什么」，
// 且原始 reason 码必须仍然出现在文案里，排查时还能拿到。

const assert = require('assert');
const { describeGuestFailure } = require('../renderer/preview-panel-controller.js');

const FALLBACK = '预览进程异常退出';

const launchFailed = describeGuestFailure('launch-failed', FALLBACK);
assert.ok(launchFailed.startsWith(FALLBACK));
assert.ok(launchFailed.includes('重启'), 'launch-failed 必须告诉用户重启 Hub 能恢复');
assert.ok(launchFailed.includes('内存'), '也要提到内存吃紧这条可能');
assert.ok(launchFailed.includes('launch-failed'), '原始 reason 码必须保留，排查要用');

const oom = describeGuestFailure('oom', FALLBACK);
assert.ok(oom.includes('内存') && oom.includes('oom'));

const crashed = describeGuestFailure('crashed', FALLBACK);
assert.ok(crashed.includes('重试') && crashed.includes('crashed'));

// 未知 reason：不要编解释，如实带出码值
assert.strictEqual(describeGuestFailure('some-future-reason', FALLBACK), FALLBACK + '：some-future-reason');
// 数字 exitCode 也能走通
assert.strictEqual(describeGuestFailure(57, FALLBACK), FALLBACK + '：57');
// 没有 reason 时保持原样，不要多出一个空冒号
assert.strictEqual(describeGuestFailure(null, FALLBACK), FALLBACK);
assert.strictEqual(describeGuestFailure(undefined, FALLBACK), FALLBACK);
assert.strictEqual(describeGuestFailure('', FALLBACK), FALLBACK);

console.log('unit-preview-guest-failure: OK');
