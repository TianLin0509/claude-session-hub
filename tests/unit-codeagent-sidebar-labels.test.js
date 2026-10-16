'use strict';
// 公司 CodeAgent 在侧栏与卡片上的几处小缺口（2026-10-16）：运行状态里 AI 名显示成「AI」；
// 同一原生会话的休眠卡不合并；侧栏「模型」筛选只有 Claude / Codex / 其他，公司版没法单筛 CodeAgent。
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

test('运行状态里 CodeAgent 会话显示 CodeAgent', () => {
  const { providerLabel } = require('../renderer/session-runtime-status');
  assert.equal(providerLabel({ kind: 'codeagent' }), 'CodeAgent');
  assert.equal(providerLabel({ kind: 'codeagent-resume' }), 'CodeAgent');
});

test('同一 CodeAgent 原生会话的休眠卡按 ccSessionId 合并', () => {
  const { nativeTranscriptSessionKey } = require('../renderer/past-session-modals');
  assert.equal(nativeTranscriptSessionKey({ kind: 'codeagent', ccSessionId: 'abc' }), 'codeagent:cc:abc');
  assert.equal(nativeTranscriptSessionKey({ kind: 'codeagent-resume', ccSessionId: 'abc' }), 'codeagent:cc:abc');
  assert.equal(nativeTranscriptSessionKey({ kind: 'codeagent' }), null);
});

function loadRendererWith(distribution) {
  const distPath = require.resolve('../core/distribution');
  const listPath = require.resolve('../renderer/session-list-renderer');
  delete require.cache[listPath];
  require.cache[distPath] = { id: distPath, filename: distPath, loaded: true, exports: distribution };
  try { return require('../renderer/session-list-renderer'); }
  finally { delete require.cache[distPath]; delete require.cache[listPath]; }
}

test('公司版：CodeAgent 单列一族；家里版仍归「其他」', () => {
  const company = loadRendererWith({ allowedKinds: ['codeagent', 'powershell'], kindAllowed: k => ['codeagent', 'powershell'].includes(String(k).replace(/-resume$/, '')) });
  assert.equal(company.familyOfKind('codeagent'), 'codeagent');
  assert.equal(company.familyOfKind('powershell'), 'other');
  const home = loadRendererWith({ allowedKinds: null, kindAllowed: () => true });
  assert.equal(home.familyOfKind('codeagent'), 'other');
  assert.equal(home.familyOfKind('claude'), 'claude');
});

test('界面：CodeAgent 筛选项默认隐藏，发行版裁剪时按装没装决定；偏好指向被裁掉的家族时退回全部', () => {
  const fs = require('node:fs');
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /<option value="codeagent" hidden>CodeAgent<\/option>/);
  const trim = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'edition-trim.js'), 'utf8');
  assert.match(trim, /#session-model-filter option/);
  const list = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
  assert.match(list, /option\.value === modelFilter && !option\.hidden\)\) modelFilter = 'all'/);
});
