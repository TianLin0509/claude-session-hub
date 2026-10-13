'use strict';
// CodeAgent 会话的回答卡片头像（2026-10-12 用户：公司版 GLM 的头像没了，之前用的是 Claude 的）。
//   根因：CodeAgent 落盘是 Claude 格式，解析出的回合带 kind:'claude'，卡片只在回合没有 kind 时才用会话 kind，
//   于是取了 Claude 画像；公司纯净版不带 claude.png，显示成破图。
const assert = require('assert');
const { turnWithSessionKind } = require('../renderer/turn-card-renderer');
const { chatAvatarSrc, makeChatAvatarSrc } = require('../renderer/chat-avatar');
const { makeKindFilter } = require('../core/distribution');

const GLM = 'assets/ai-avatars/cel-v2/glm.png';
const CLAUDE = 'assets/ai-avatars/cel-v2/claude.png';

// 1. 卡片以会话 kind 为准
const claudeTurn = { id: 't1', role: 'assistant', kind: 'claude', text: 'ok' };
assert.strictEqual(turnWithSessionKind(claudeTurn, 'codeagent').kind, 'codeagent', 'CodeAgent 会话的 Claude 格式回合按 CodeAgent 显示');
assert.strictEqual(turnWithSessionKind({ ...claudeTurn, kind: 'claude-resume' }, 'codeagent-resume').kind, 'codeagent-resume');
assert.strictEqual(claudeTurn.kind, 'claude', '不改调用方的回合对象');
assert.strictEqual(turnWithSessionKind(claudeTurn, 'claude'), claudeTurn, 'Claude 会话原样');
assert.strictEqual(turnWithSessionKind({ id: 't2', kind: 'codex' }, 'codeagent').kind, 'codex', '只替换 Claude 格式的回合，其他 kind 保留');
assert.strictEqual(turnWithSessionKind({ id: 't3' }, 'codex').kind, 'codex', '回合没有 kind 时补会话 kind（原行为）');
assert.strictEqual(turnWithSessionKind({ id: 't4', kind: 'gemini' }, 'claude').kind, 'gemini', '回合自带 kind 时不覆盖（原行为）');
const bare = { id: 't5', kind: 'claude' };
assert.strictEqual(turnWithSessionKind(bare, undefined), bare, '没有会话 kind 时原样');

// 2. 自用版与公开版：画像不变
assert.strictEqual(chatAvatarSrc('codeagent'), GLM, 'CodeAgent 借用智谱画像');
assert.strictEqual(chatAvatarSrc(turnWithSessionKind(claudeTurn, 'codeagent').kind), GLM, '自用版 CodeAgent 卡片不再显示 Claude 画像');
assert.strictEqual(chatAvatarSrc('claude'), CLAUDE);

// 3. 只留 CodeAgent 的发行版：不在名单里的 kind 也落到 CodeAgent 画像，不出破图
const pure = makeChatAvatarSrc(makeKindFilter(['codeagent']));
for (const kind of ['codeagent', 'codeagent-resume', 'claude', 'claude-resume', 'codex', 'gpt', 'deepseek-acp', 'kimi', 'qwen', 'gemini', 'glm']) {
  assert.strictEqual(pure(kind), GLM, kind);
}
assert.strictEqual(pure('powershell'), null, '本来就没有画像的 kind 仍走字母兜底');
assert.strictEqual(pure('__proto__'), null);
assert.strictEqual(pure('claude', { assistant: true }), 'assets/assistant/penguin.png', '助理画像不受影响');

// 4. 名单里有的 AI 仍用自己的画像；codex 的归类名是 gpt
const two = makeChatAvatarSrc(makeKindFilter(['codex', 'deepseek']));
assert.strictEqual(two('codex'), 'assets/ai-avatars/cel-v2/codex.png');
assert.strictEqual(two('gpt'), 'assets/ai-avatars/cel-v2/codex.png');
assert.strictEqual(two('deepseek-acp'), 'assets/ai-avatars/cel-v2/deepseek.png');
assert.strictEqual(two('claude'), 'assets/ai-avatars/cel-v2/codex.png', '不在名单里的落到名单第一个');
const all = makeChatAvatarSrc(makeKindFilter(null));
assert.strictEqual(all('claude'), CLAUDE, '不限 AI 时不兜底');

console.log('unit-codeagent-card-avatar: all passed');
