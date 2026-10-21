'use strict';
// 写作 Tab 新文章的成员卡：和「新建 AI 群聊」同一套 DeepSeek 接入与调参（2026-10-13）。
const assert = require('node:assert');
const { normalizeWritingMember, writingMemberSlots, WRITING_MEMBER_KINDS } = require('../renderer/writing-composer.js');
const { defaultMembers } = require('../main/ipc/writing-handlers.js');
const { GROUP_MEMBER_KINDS } = require('../core/ai-kinds.js');

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
  // 写作成员与建群弹窗同一份清单：Antigravity（gemini）从 2026-10-22 起可加，不再回落成 Claude。
  assert.deepStrictEqual(normalizeWritingMember({ kind: 'gemini', model: 'gemini-3.1-pro-high' }), { kind: 'gemini', model: 'gemini-3.1-pro-high' });
});

test('写作成员清单与建群弹窗一致（只去掉旧 DeepSeek 接入），Antigravity 在列', () => {
  assert.deepStrictEqual(WRITING_MEMBER_KINDS, GROUP_MEMBER_KINDS.filter(kind => kind !== 'deepseek-acp'));
  assert.ok(WRITING_MEMBER_KINDS.includes('gemini'), 'Antigravity 能加进写作群');
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
  // Antigravity 与群里一样按选定的模型与思考档出发，不被换成 Claude
  assert.deepStrictEqual(writingMemberSlots([{ kind: 'gemini', model: 'gemini-3.1-pro-high', effort: 'high' }], controller()),
    [{ index: 0, kind: 'gemini', model: 'gemini-3.1-pro-high', effort: 'high' }]);
});

console.log(`写作成员卡：${passed} 项通过`);
