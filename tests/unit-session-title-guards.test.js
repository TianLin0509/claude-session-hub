'use strict';

const assert = require('assert');
const {
  formatBranchSessionTitle,
  isGenericAutoSessionTitle,
  isStableSessionTitle,
  looksLikePathTitle,
  migrateLegacyBranchSessionMeta,
  normalizeLegacyBranchSessionTitle,
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

test('branch titles use a front-loaded marker and migrate the old suffix format', () => {
  assert.strictEqual(formatBranchSessionTitle('无线算法策略'), '分支: 无线算法策略');
  assert.strictEqual(formatBranchSessionTitle('分支: 无线算法策略'), '分支: 无线算法策略');
  assert.strictEqual(normalizeLegacyBranchSessionTitle('无线算法策略 · 分支'), '分支: 无线算法策略');
  assert.strictEqual(normalizeLegacyBranchSessionTitle('Codex CLI分支问答方法'), 'Codex CLI分支问答方法');
  assert.deepStrictEqual(
    migrateLegacyBranchSessionMeta({ title: 'Codex 2 · 分支', userRenamed: true }),
    {
      title: '分支: Codex 2',
      userRenamed: false,
      autoTitleGenerated: false,
      branchAutoTitlePending: true,
    },
  );
  assert.deepStrictEqual(
    migrateLegacyBranchSessionMeta({ title: '无线算法策略 · 分支', userRenamed: true }),
    {
      title: '分支: 无线算法策略',
      userRenamed: false,
      autoTitleGenerated: true,
      branchAutoTitlePending: false,
    },
  );
  const custom = { title: 'Codex CLI分支问答方法', userRenamed: true };
  assert.strictEqual(migrateLegacyBranchSessionMeta(custom), custom,
    'ordinary titles that merely contain the word branch must stay untouched');
});

console.log('Session title guard tests passed.');
