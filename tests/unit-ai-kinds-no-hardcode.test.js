'use strict';
// 2026-05-02 防回归 lint 单测：
//   禁止在 core/main.js/renderer 代码里硬编码 ['claude', 'gemini', 'codex'] 字面量数组
//   或 (claude|gemini|codex) 正则字符类。
//
// 背景：项目早期硬假设 3 家 AI，后加 deepseek/glm 时大量分支没补，造成多个 P0 bug
// （一键提取假的、卡片不更新、自动标题失败、输入卡死等）。已建立 core/ai-kinds.js 单一
// 真理源，所有"AI 列表 / 家族判定"必须从这里 require，否则未来加新 AI（Qwen/Kimi 等）
// 又会重蹈覆辙。
//
// 本测试用 grep 兜底：扫描 core/ + main.js + renderer/ 的 .js 文件，禁止出现以下模式：
//   - ['claude', 'gemini', 'codex']         字面量数组
//   - "claude|gemini|codex"                 正则 alternation 字符串
//   - kind === 'claude' 链 + 漏 deepseek/glm 的 if 分支（启发式：连续判 claude/gemini/codex
//     但同段没有 deepseek/glm 字样 → 大概率漏判）
//
// 已知例外（白名单）：
//   - core/ai-kinds.js                      单一真理源本身
//   - tests/                                测试可显式列举验证
//   - docs/                                 文档/历史

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..');

// ---------- 待扫描的源文件 ----------
function listSourceFiles() {
  const out = [];
  const dirs = ['core', 'renderer', 'renderer-mobile', 'scripts'];
  for (const d of dirs) {
    walk(path.join(REPO_ROOT, d), out);
  }
  // 单独加 main.js
  out.push(path.join(REPO_ROOT, 'main.js'));
  return out.filter(f => f.endsWith('.js'));
}
function walk(dir, out) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === 'dist' || e.name === '_test-harness') continue;
      walk(p, out);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

// ---------- 例外白名单 ----------
const ALLOWED_FILES = new Set([
  path.join(REPO_ROOT, 'core', 'ai-kinds.js'),       // 单一真理源本身
  path.join(REPO_ROOT, 'core', 'summary-prompt.js'), // 给 AI 看的 prompt 模板（含 supporters 示例 JSON）
]);

// ---------- 检测器 ----------
const HARDCODE_ARRAY_PATTERN = /\[\s*['"](?:claude|claude-resume)['"]\s*,\s*['"](?:claude|claude-resume|gemini|codex)['"]/i;
const REGEX_ALT_PATTERN = /\(claude\|gemini\|codex\)/;
const REGEX_ALT_STRICT = /['"`]claude\|gemini\|codex['"`]/;

function scanFile(filepath) {
  const issues = [];
  const rel = path.relative(REPO_ROOT, filepath);
  if (ALLOWED_FILES.has(filepath)) return issues;
  // 跳过 node_modules / dist
  if (rel.includes('node_modules') || rel.startsWith('dist')) return issues;

  const src = fs.readFileSync(filepath, 'utf-8');
  const lines = src.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // 跳过注释行（//开头 或 /*...*/ 内）— 只看代码行
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // 模式 1：['claude', 'gemini', ...] 三家硬编码
    if (HARDCODE_ARRAY_PATTERN.test(line)) {
      // 进一步确认：同行是否同时含 'deepseek' 和 'glm'？含的话视为完整列表（非旧硬编码）
      if (!/['"]deepseek['"]/i.test(line) || !/['"]glm['"]/i.test(line)) {
        issues.push({ line: i + 1, code: trimmed, type: 'hardcoded_array' });
      }
    }

    // 模式 2：(claude|gemini|codex) 正则字符类
    if (REGEX_ALT_PATTERN.test(line)) {
      if (!/deepseek/i.test(line) || !/glm/i.test(line)) {
        issues.push({ line: i + 1, code: trimmed, type: 'regex_alt' });
      }
    }
    if (REGEX_ALT_STRICT.test(line)) {
      issues.push({ line: i + 1, code: trimmed, type: 'regex_alt_string' });
    }
  }
  return issues;
}

function testNoHardcodedAiArrays() {
  const files = listSourceFiles();
  const allIssues = [];
  for (const f of files) {
    const issues = scanFile(f);
    for (const issue of issues) {
      allIssues.push({ file: path.relative(REPO_ROOT, f), ...issue });
    }
  }

  if (allIssues.length > 0) {
    console.error('\n  以下位置硬编码了三家 AI 字面量数组/正则，必须改用 core/ai-kinds.js 的 helper：\n');
    for (const issue of allIssues) {
      console.error(`    ${issue.file}:${issue.line}  [${issue.type}]`);
      console.error(`      ${issue.code.slice(0, 120)}${issue.code.length > 120 ? '...' : ''}`);
    }
    console.error('\n  修复方法：');
    console.error('    - require core/ai-kinds.js 的 ALL_AI_KINDS / CLAUDE_FAMILY / PASTE_SENSITIVE_KINDS');
    console.error('    - 用 isClaudeFamily(kind) / isPasteSensitive(kind) helper 替代 if 链');
    console.error('    - 正则用 kindRegexAlternation() 动态构造\n');
    assert.fail(`发现 ${allIssues.length} 个硬编码 AI kind 字面量，必须改用 core/ai-kinds.js`);
  }
  console.log(`  ✓ testNoHardcodedAiArrays（扫描 ${files.length} 个文件，无违规）`);
}

// ---------- 检查 core/ai-kinds.js 本身契约 ----------
function testAiKindsModuleExportsContract() {
  const m = require('../core/ai-kinds');

  assert.ok(Array.isArray(m.ALL_AI_KINDS), 'ALL_AI_KINDS 必须是数组');
  // 当前应包含 8 家
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.ALL_AI_KINDS.includes(k), `ALL_AI_KINDS 必须包含 ${k}`);
  }

  assert.ok(Array.isArray(m.CLAUDE_FAMILY), 'CLAUDE_FAMILY 必须是数组');
  for (const k of ['claude', 'claude-resume', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.CLAUDE_FAMILY.includes(k), `CLAUDE_FAMILY 必须包含 ${k}`);
  }
  assert.ok(!m.CLAUDE_FAMILY.includes('gemini'), 'CLAUDE_FAMILY 不应包含 gemini');
  assert.ok(!m.CLAUDE_FAMILY.includes('codex'), 'CLAUDE_FAMILY 不应包含 codex');

  assert.ok(Array.isArray(m.PASTE_SENSITIVE_KINDS), 'PASTE_SENSITIVE_KINDS 必须是数组');
  for (const k of ['claude', 'gemini', 'codex', 'deepseek', 'glm', 'gpt', 'kimi', 'qwen']) {
    assert.ok(m.PASTE_SENSITIVE_KINDS.includes(k), `PASTE_SENSITIVE_KINDS 必须含 ${k}`);
  }
  assert.ok(!m.PASTE_SENSITIVE_KINDS.includes('powershell'), 'PASTE_SENSITIVE_KINDS 不应含 powershell');

  assert.strictEqual(m.isClaudeFamily('deepseek'), true);
  assert.strictEqual(m.isClaudeFamily('glm'), true);
  assert.strictEqual(m.isClaudeFamily('gpt'), true);
  assert.strictEqual(m.isClaudeFamily('kimi'), true);
  assert.strictEqual(m.isClaudeFamily('qwen'), true);
  assert.strictEqual(m.isClaudeFamily('claude'), true);
  assert.strictEqual(m.isClaudeFamily('gemini'), false);
  assert.strictEqual(m.isClaudeFamily('codex'), false);

  assert.strictEqual(m.isPasteSensitive('deepseek'), true);
  assert.strictEqual(m.isPasteSensitive('claude'), true);
  assert.strictEqual(m.isPasteSensitive('gpt'), true);
  assert.strictEqual(m.isPasteSensitive('kimi'), true);
  assert.strictEqual(m.isPasteSensitive('qwen'), true);
  assert.strictEqual(m.isPasteSensitive('powershell'), false);

  // listKindsForPrompt 已删除（2026-05-08）：刻意不向 AI prompt 注入家族枚举
  assert.strictEqual(m.listKindsForPrompt, undefined, 'listKindsForPrompt 已删除');

  assert.strictEqual(typeof m.kindRegexAlternation(), 'string');
  assert.ok(m.kindRegexAlternation().includes('deepseek'));
  assert.ok(m.kindRegexAlternation().includes('glm'));
  assert.ok(m.kindRegexAlternation().includes('gpt'));
  assert.ok(m.kindRegexAlternation().includes('kimi'));
  assert.ok(m.kindRegexAlternation().includes('qwen'));

  console.log('  ✓ testAiKindsModuleExportsContract');
}

// ---------- 关键调用方迁移到 ai-kinds 的契约 ----------
function testKeyCallsitesUseAiKindsHelpers() {
  // 验证关键文件已 require ai-kinds.js（防止有人改回硬编码）
  // 摘要功能 2026-05-08 整体下线：roundtable-scenes.js 不再 require ai-kinds.js
  //   （原 listKindsForPrompt 已删；scene preset 不向 AI 注入家族枚举，避免 stereotype 先验）
  const requiredFiles = [
    'core/roundtable-orchestrator.js',
    'core/session-manager.js',
    'renderer/renderer.js',
    'renderer/meeting-room.js',
  ];
  for (const f of requiredFiles) {
    const src = fs.readFileSync(path.join(REPO_ROOT, f), 'utf-8');
    assert.ok(/require\(['"]\.\.?\/(?:core\/)?ai-kinds(?:\.js)?['"]\)/.test(src),
      `${f} 必须 require core/ai-kinds.js（含 ai-kind helper 调用点）`);
  }

  // renderer.js 自动标题分支必须用 isClaudeFamily（不能再硬编码）
  const rendererSrc = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'renderer.js'), 'utf-8');
  assert.ok(/isClaudeFamily\s*\(\s*session\.kind\s*\)/.test(rendererSrc),
    'renderer.js OSC 标题分支必须用 isClaudeFamily(session.kind)');

  // meeting-room.js 普通发送 baseDelay 必须用 isPasteSensitive
  const mrSrc = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'meeting-room.js'), 'utf-8');
  assert.ok(/isPasteSensitive\s*\(\s*session\.kind\s*\)/.test(mrSrc),
    'renderer/meeting-room.js 普通发送 baseDelay 必须用 isPasteSensitive(session.kind)');

  // session-manager.js readTranscriptTail 必须用 isClaudeFamily
  const smSrc = fs.readFileSync(path.join(REPO_ROOT, 'core', 'session-manager.js'), 'utf-8');
  assert.ok(/isClaudeFamily\s*\(\s*kind\s*\)/.test(smSrc),
    'core/session-manager.js readTranscriptTail 必须用 isClaudeFamily(kind)');

  // roundtable-scenes.js BASE_RULES 不应再含模板字符串"你和另外两位 AI 同事（共三家"
  // （注释里的历史引用允许，模板字符串实际内容不允许）
  const scenesSrc = fs.readFileSync(path.join(REPO_ROOT, 'core', 'roundtable-scenes.js'), 'utf-8');
  assert.ok(!/你和另外两位\s*AI\s*同事[（(]共三家/.test(scenesSrc),
    'roundtable-scenes.js BASE_RULES 模板字符串不应再含"你和另外两位 AI 同事（共三家"');

  // slot 化（2026-05-03）：BASE_RULES 必须包含 slot 昵称列表（防止 slot 化被回退到 kind）
  // 称谓中文化（2026-05-08）：席位昵称改用中文宝可梦名
  assert.ok(/皮卡丘\s*\/\s*小火龙\s*\/\s*杰尼龟/.test(scenesSrc),
    'roundtable-scenes.js BASE_RULES 必须含 "皮卡丘 / 小火龙 / 杰尼龟" 席位说明');

  console.log('  ✓ testKeyCallsitesUseAiKindsHelpers');
}

// ---------- slot 单一真理源契约 ----------
function testSlotIdsModuleContract() {
  const m = require(path.join(REPO_ROOT, 'core', 'ai-kinds.js'));
  assert.deepStrictEqual(m.SLOT_IDS, ['pikachu', 'charmander', 'squirtle'],
    'SLOT_IDS 必须按 ["pikachu","charmander","squirtle"] 顺序');
  // 称谓中文化（2026-05-08）：getSlotPromptName 改返回中文，给 AI prompt 用
  assert.strictEqual(m.getSlotPromptName(0), '皮卡丘');
  assert.strictEqual(m.getSlotPromptName('charmander'), '小火龙');
  assert.strictEqual(m.getSlotPromptName(2), '杰尼龟');
  assert.ok(m.getSlotDisplayLabel(0).includes('皮卡丘'), 'displayLabel 含中文宝可梦名');
  assert.ok(m.getSlotDisplayLabel('squirtle').includes('Squirtle'), 'displayLabel 仍保留英文 slot 名（双语展示）');
  assert.strictEqual(m.slotIdRegexAlternation(), 'pikachu|charmander|squirtle');
  assert.strictEqual(m.slotIdToIndex('pikachu'), 0);
  assert.strictEqual(m.slotIdToIndex('charmander'), 1);
  assert.strictEqual(m.slotIdToIndex('squirtle'), 2);
  assert.strictEqual(m.slotIdToIndex('unknown'), -1);
  assert.strictEqual(m.slotIndexToId(0), 'pikachu');
  assert.strictEqual(m.slotIndexToId(2), 'squirtle');
  assert.strictEqual(m.slotIndexToId(3), null, 'idx>=3 必须返回 null（圆桌仅 3 席）');

  // main.js 必须 require slot helper（防止有人把 dispatchRoundtableTurn 改回 summarizerKind）
  const mainSrc = fs.readFileSync(path.join(REPO_ROOT, 'main.js'), 'utf-8');
  assert.ok(/getSlotPromptName/.test(mainSrc), 'main.js 必须 require getSlotPromptName');
  // 摘要功能 2026-05-08 整体下线：main.js dispatchRoundtableTurn 不再接收 summarizerSlot 入参
  assert.ok(!/summarizerSlot/.test(mainSrc), 'main.js summarizerSlot 入参已删（摘要功能下线）');
  assert.ok(!/sidByKind/.test(mainSrc), 'main.js 不应再有 sidByKind（已替换为 sidBySlot）');

  // renderer/meeting-room.js dropdown 必须按 slot 枚举（不再按 kind 去重）
  const mrSrc = fs.readFileSync(path.join(REPO_ROOT, 'renderer', 'meeting-room.js'), 'utf-8');
  assert.ok(/slotIdRegexAlternation/.test(mrSrc),
    'renderer/meeting-room.js @ 解析正则必须用 slotIdRegexAlternation（不再用 kindRegexAlternation 当圆桌身份判定）');
  // 摘要功能 2026-05-08 整体下线：triggerRoundtable 不再传 summarizerSlot
  assert.ok(!/summarizerSlot/.test(mrSrc), 'renderer/meeting-room.js summarizerSlot 已删（摘要功能下线）');

  console.log('  ✓ testSlotIdsModuleContract');
}

// ---------- 跑测 ----------
console.log('Running ai-kinds no-hardcode lint tests...');
let failed = 0;
for (const t of [testAiKindsModuleExportsContract, testKeyCallsitesUseAiKindsHelpers, testNoHardcodedAiArrays, testSlotIdsModuleContract]) {
  try { t(); }
  catch (e) {
    console.error('  ✗', t.name);
    console.error('    ', e.message);
    failed++;
  }
}
console.log(`\n${4 - failed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
