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

test('公司版与家里版：CodeAgent 都单列一族', () => {
  const company = loadRendererWith({ allowedKinds: ['codeagent', 'powershell'], kindAllowed: k => ['codeagent', 'powershell'].includes(String(k).replace(/-resume$/, '')) });
  assert.equal(company.familyOfKind('codeagent'), 'codeagent');
  assert.equal(company.familyOfKind('powershell'), 'other');
  const home = loadRendererWith({ allowedKinds: null, kindAllowed: () => true });
  assert.equal(home.familyOfKind('codeagent'), 'codeagent');
  assert.equal(home.familyOfKind('claude'), 'claude');
});

test('模型选项按发行版动态生成，同品牌任一后端可用即可筛选', () => {
  const company=loadRendererWith({allowedKinds:['codeagent'],kindAllowed:k=>k==='codeagent'});
  assert.deepEqual(company.SESSION_FAMILY_TABS.map(t=>t.key),['all','codeagent','other']);
  const dsh=loadRendererWith({allowedKinds:['deepseek-acp'],kindAllowed:k=>k==='deepseek-acp'});
  assert.deepEqual(dsh.SESSION_FAMILY_TABS.map(t=>t.key),['all','deepseek','other']);
  const fs = require('node:fs');
  const list = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'session-list-renderer.js'), 'utf8');
  assert.match(list, /option\.value === modelFilter && !option\.hidden\)\) modelFilter = 'all'/);
});
