'use strict';

// 回归守卫：session.kind 是持久化字段，resume 会话上原样写着 'deepseek-resume' /
// 'codex-resume' 这类值。normalizeProviderFamily 漏掉任何一个，该成员就会静默退回
// 旧的宽松路径 —— 中间输出可能被当成最终答案、provider turn id 也不再校验，
// 而且不会报错，只能靠这条测试发现。
const assert = require('node:assert');
const {
  ALL_AI_KINDS,
  CLAUDE_FAMILY,
  CODEX_CLI_KINDS,
  KIMI_CLI_KINDS,
} = require('../core/ai-kinds.js');
const { normalizeProviderFamily } = require('../core/groupchat-attempt-protocol.js');

const EXPECTED = new Map();
for (const kind of CLAUDE_FAMILY) EXPECTED.set(kind, 'claude');
for (const kind of CODEX_CLI_KINDS) EXPECTED.set(kind, 'codex');
for (const kind of KIMI_CLI_KINDS) EXPECTED.set(kind, 'kimi');
for (const kind of ALL_AI_KINDS) {
  if (!EXPECTED.has(kind)) EXPECTED.set(kind, kind);
}
// resume 变体：sessionManager 会持久化成 `${kind}-resume`，也必须落在同一个家族里。
for (const [kind, family] of [...EXPECTED]) {
  if (kind.endsWith('-resume')) continue;
  EXPECTED.set(`${kind}-resume`, family);
}

for (const [kind, family] of EXPECTED) {
  assert.strictEqual(
    normalizeProviderFamily(kind), family,
    `kind=${kind} 应归入 ${family} 家族，实际是 ${normalizeProviderFamily(kind)}（漏映射会静默关掉本轮身份校验）`,
  );
  assert.notStrictEqual(
    normalizeProviderFamily(kind), 'unknown',
    `kind=${kind} 落到 unknown，attempt 门禁会整体失效`,
  );
}

assert.strictEqual(normalizeProviderFamily(''), 'unknown');
assert.strictEqual(normalizeProviderFamily(null), 'unknown');

console.log(`groupchat provider family coverage ok (${EXPECTED.size} kinds)`);
