'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  ALL_AI_KINDS,
  FAMILY_KINDS,
  KIND_LABELS,
  canonicalAiKind,
  isKimiCliKind,
  isPasteSensitive,
} = require('../core/ai-kinds.js');
const { MODEL_OPTIONS_BY_KIND, DEFAULT_MODEL_BY_KIND } = require('../core/model-options.js');
const { _private: sessionManagerPrivate } = require('../core/session-manager.js');

const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

assert.ok(ALL_AI_KINDS.includes('kimi'));
assert.ok(FAMILY_KINDS.includes('kimi'));
assert.strictEqual(KIND_LABELS.kimi, 'Kimi');
assert.strictEqual(canonicalAiKind('kimi-resume'), 'kimi');
assert.ok(isKimiCliKind('kimi'));
assert.ok(isKimiCliKind('kimi-resume'));
assert.ok(isPasteSensitive('kimi'));
assert.strictEqual(DEFAULT_MODEL_BY_KIND.kimi, 'kimi-code/k3');
assert.deepStrictEqual(MODEL_OPTIONS_BY_KIND.kimi, [{ id: 'kimi-code/k3', label: 'Kimi K3' }]);

const manager = read('core/session-manager.js');
assert.match(manager, /\.kimi-code['"], ['"]bin['"], ['"]kimi\.exe/);
assert.match(manager, /--yolo\$\{kimiModelArg/);
assert.match(manager, /isKimiModelConfigured/);
assert.match(manager, /--session/);
assert.match(manager, /Kimi K3/);

const kimiHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-kimi-model-'));
try {
  const env = { ...process.env, KIMI_CODE_HOME: kimiHome };
  assert.strictEqual(sessionManagerPrivate.isKimiModelConfigured('kimi-code/k3', env), false);
  assert.strictEqual(sessionManagerPrivate.kimiModelArg('kimi-code/k3', env), '');
  fs.writeFileSync(path.join(kimiHome, 'config.toml'), [
    'default_model = "kimi-code/k3"',
    '',
    '[models."kimi-code/k3"]',
    'provider = "managed:kimi-code"',
    'model = "k3"',
    '',
  ].join('\n'), 'utf8');
  assert.strictEqual(sessionManagerPrivate.isKimiModelConfigured('kimi-code/k3', env), true);
  assert.strictEqual(sessionManagerPrivate.kimiModelArg('kimi-code/k3', env), " --model 'kimi-code/k3'");
} finally {
  fs.rmSync(kimiHome, { recursive: true, force: true });
}

const html = read('renderer/index.html');
assert.match(html, /data-kind="kimi"/);
assert.match(html, /data-resume-kind="kimi-resume"/);
assert.match(html, /Kimi Code · K3/);
assert.match(html, /data-ai="kimi"/);
assert.match(html, /id="cfg-detail-kimi"/);

const configModal = read('renderer/config-modal.js');
assert.match(configModal, /kimi:\s*\{/);
assert.match(configModal, /Kimi Code CLI 登录/);

const keyboardShortcuts = read('renderer/keyboard-shortcuts.js');
assert.match(keyboardShortcuts, /新建 Kimi Code 会话/);
// 2026-07-27：快捷键不再直接 invoke('create-session', kind)，改走 createWorkspaceSession，
// 这样新会话会正确分配 workspace（旧路径会落到 home 目录）。断言改盯行为：
// 面板项必须调 createSession('kimi')，且 createSession 必须优先走 workspace 感知入口。
assert.match(keyboardShortcuts, /新建 Kimi Code 会话[\s\S]{0,80}createSession\('kimi'\)/);
assert.match(
  keyboardShortcuts,
  /createSession\s*=\s*kind\s*=>[\s\S]{0,200}createWorkspaceSession\(kind\)/,
  'kimi 快捷键必须经过 workspace 感知入口，否则新会话会落到 home 目录',
);
assert.match(keyboardShortcuts, /ipcRenderer\.invoke\('create-session', kind\)/,
  'createWorkspaceSession 缺失时仍须有 IPC 兜底');

const modal = read('renderer/meeting-create-modal.js');
// 这里守的是「建会议的模型下拉必须从共享目录派生，不能自己抄一份」——
// 抄一份的直接后果就是新增 Kimi 后建会议时选不到它。
// 2026-09-04：3cfce1e 把 Object.entries(MODEL_OPTIONS_BY_KIND) 换成了同一个模块的
// modelOptionsFor(kind)，来源没变、还更收敛，但原来盯死写法的断言就红了。
// 改成盯来源：必须 require 共享目录，且用它的某个访问器展开。
assert.match(modal, /require\(['"]\.\.\/core\/model-options\.js['"]\)/,
  '建会议弹窗必须从 core/model-options.js 取模型，不能自带一份清单');
assert.match(modal, /Object\.entries\(MODEL_OPTIONS_BY_KIND\)|modelOptionsFor\(/,
  '模型下拉必须由共享目录展开');
assert.doesNotMatch(modal, /['"]kimi-code\/k3['"]/,
  '模型 id 不得硬编码进弹窗，否则共享目录改了这里不会跟着改');
assert.match(read('main/ipc/meeting-create-handlers.js'), /createSession\(kind, sessionOpts\)/);

const main = read('main.js');
assert.match(main, /kimiSid: session\.kimiSid/);
assert.match(main, /kimiSessionDir/);
assert.match(main, /parseKimiUsage/);
assert.match(main, /refreshKimiAccountUsageLive/);

const renderer = read('renderer/renderer.js');
assert.match(renderer, /isKimiCliKind/);
assert.match(renderer, /supportsCardHistory[\s\S]*isKimiCliKind/);
assert.match(renderer, /MeetingRoom\.refreshSessionMetrics\(payload\.sessionId\)/);

const turnCards = read('renderer/turn-card-renderer.js');
assert.match(turnCards, /k3/);
assert.match(turnCards, /context_tokens/);

const meetingRoom = read('renderer/meeting-room.js');
assert.match(meetingRoom, /class="mr-gc-member-logo"/);
assert.match(meetingRoom, /function refreshSessionMetrics\(sessionId\)/);
assert.match(meetingRoom, /refreshSessionMetrics,/);

console.log('Kimi integration contract tests passed.');
