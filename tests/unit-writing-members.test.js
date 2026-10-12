'use strict';
// 写作 Tab 新文章的成员卡：和「新建 AI 群聊」同一套 DeepSeek 接入与调参（2026-10-13）。
const assert = require('node:assert');
const { normalizeWritingMember, writingMemberSlots } = require('../renderer/writing-composer.js');
const { defaultMembers } = require('../main/ipc/writing-handlers.js');

function controller({ routeOk = true } = {}) {
  return {
    deepseekRouteState: () => ({ route: 'tokenplan' }),
    deepseekRouteStatus: () => (routeOk ? { available: true, reason: '' } : { available: false, reason: '没有配置 Key' }),
    buildSessionTuningOpts: (kind, model, sel) => ({ model: model || `${kind}-default`, ...(sel.effort ? { effort: sel.effort } : {}) }),
  };
}

let passed = 0;
function test(name, fn) { fn(); passed += 1; console.log(`  ✓ ${name}`); }

test('本机存过的旧 DeepSeek 成员换到 Claude Code，旧 Codex 模型名不带过去', () => {
  assert.deepStrictEqual(normalizeWritingMember({ kind: 'deepseek', model: 'deepseek-v4-pro', effort: 'high' }), { kind: 'deepseek-claude' });
  assert.deepStrictEqual(normalizeWritingMember({ kind: 'deepseek-acp' }), { kind: 'deepseek-claude' });
  assert.deepStrictEqual(normalizeWritingMember({ kind: 'codex', model: 'gpt-6-astra', effort: 'low', model2: 'x' }), { kind: 'codex', model: 'gpt-6-astra', effort: 'low' });
  assert.deepStrictEqual(normalizeWritingMember({ kind: 'gemini' }), { kind: 'claude' });
});

test('默认三位成员里 DeepSeek 跑 Claude Code', () => {
  assert.deepStrictEqual(defaultMembers({}), [{ kind: 'claude' }, { kind: 'codex' }, { kind: 'deepseek-claude' }]);
});

test('建群成员带上 DeepSeek 接入；选中的接入不可用时直接拦下', () => {
  const slots = writingMemberSlots([{ kind: 'claude' }, { kind: 'deepseek' }], controller());
  assert.deepStrictEqual(slots, [
    { index: 0, kind: 'claude', model: 'claude-default' },
    { index: 1, kind: 'deepseek-claude', model: 'deepseek-claude-default', deepseekRoute: 'tokenplan' },
  ]);
  assert.throws(() => writingMemberSlots([{ kind: 'deepseek-claude', deepseekRoute: 'api' }], controller({ routeOk: false })), /成员 1：.*不可用：没有配置 Key/);
});

console.log(`写作成员卡：${passed} 项通过`);
