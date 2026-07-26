'use strict';

const assert = require('assert');
const {
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  looksLikePathTitle,
  shouldAcceptExternalSessionTitle,
} = require('../core/session-title-guards.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

console.log('Running session title guard tests...');

test('default provider titles are generic', () => {
  assert.strictEqual(isGenericAutoSessionTitle('Claude 1'), true);
  assert.strictEqual(isGenericAutoSessionTitle('DeepSeek Resume 3'), true);
  assert.strictEqual(isStableSessionTitle('Claude 1', 'claude'), false);
  assert.strictEqual(isGenericAutoSessionTitle('repo 架构梳理'), false);
});

test('local path titles are rejected as unstable', () => {
  const imageTitle = 'C:\\Users\\lintian\\.claude-session-hub\\images\\20260628154526-27db07.png 会话中断恢复';
  assert.strictEqual(looksLikePathTitle(imageTitle), true);
  assert.strictEqual(isStableSessionTitle(imageTitle), false);
  assert.strictEqual(isStableSessionTitle('投研圆桌复盘'), true);
});

test('external title sync only replaces generic unprotected titles', () => {
  assert.strictEqual(
    shouldAcceptExternalSessionTitle({ title: 'Claude 1', kind: 'claude' }, 'Greeting in Chinese'),
    true,
  );
  assert.strictEqual(
    shouldAcceptExternalSessionTitle({ title: '投研圆桌复盘', kind: 'claude' }, 'New statusline title'),
    false,
  );
  assert.strictEqual(
    shouldAcceptExternalSessionTitle({ title: 'Claude 1', kind: 'claude' }, 'C:\\tmp\\x.png 会话中断恢复'),
    false,
  );
  assert.strictEqual(
    shouldAcceptExternalSessionTitle({ title: 'Claude 1', kind: 'claude', autoTitleGenerated: true }, 'New title'),
    false,
  );
});

console.log('Session title guard tests passed.');
