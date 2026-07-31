'use strict';
// 项目规则只写在 CLAUDE.md 里时，Codex / Kimi 一个字都读不到——但体检以前报全 ok。
//
// 2026-07-29 第六轮实测：C:\Vibe\AI\ChannelHub_main 有 .git 和自己的 CLAUDE.md，
// Claude 拿到 8154 字节（三份），Kimi 只有 1308 字节（纯全局）。当时体检对 Kimi 的结论是
// 「project root ✓ / AGENTS.md 1 份 ✓」——因为它只数份数，不问规则到底送到没有。
// 有 .git 的项目 Hub 不会自动 seed（那是项目自己的事），所以只能靠告警提醒用户补 AGENTS.md。

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PI = require('../core/prompt-inspect.js');

let failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  OK ${name}`); }
  catch (err) { failed++; console.error(`  FAIL ${name}`); console.error(err.message); }
}

function withRepo(fn) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-blind-'));
  try { fn(root); } finally { fs.rmSync(root, { recursive: true, force: true }); }
}

const titles = (cwd, kind) => PI.buildInspection({ cwd, kind }).health.map(h => `${h.level}:${h.title}`);
const hasBlind = (cwd, kind) => titles(cwd, kind).some(t => /Claude 规则未完整送到/.test(t));
const blindPaths = (cwd, kind) => {
  const insp = PI.buildInspection({ cwd, kind });
  const provider = kind === 'kimi' ? insp.kimi.entries : insp.codex.entries;
  return PI.findUnmirroredClaudeRules(insp.claude.entries, provider).map(e => PI.pathKey(e.path));
};
const hasBlindPath = (cwd, kind, file) => blindPaths(cwd, kind).includes(PI.pathKey(file));

console.log('Running unreachable project rules tests...');

// Kimi 固定认 .git；Codex 认的是用户 ~/.codex/config.toml 里配的 project_root_markers
// （本机实测是 .vibe-root，不是默认的 .git）。两个标记都放，才能同时构造出两家的 project root。
function makeRepo(root, name) {
  const repo = path.join(root, name);
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  fs.writeFileSync(path.join(repo, '.vibe-root'), '# marker\n', 'utf8');
  return repo;
}

test('project root 上只有 CLAUDE.md → Codex / Kimi 都要报 bad', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    const claudeFile = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, '# 项目规则\n\n- 只有 Claude 看得到\n', 'utf8');
    for (const kind of ['kimi', 'codex']) {
      assert.ok(hasBlindPath(repo, kind, claudeFile), `${kind} 必须报这份规则读不到，实际：${titles(repo, kind).join(' | ')}`);
    }
    // Claude 自己读得到，不该被这条打扰
    assert.ok(!hasBlind(repo, 'claude'));
  });
});

test('同目录补上正文相同的 AGENTS.md 后告警消失', () => {
  withRepo((root) => {
    const repo = path.join(root, 'proj');
    fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 项目规则\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 项目规则\n', 'utf8');
    for (const kind of ['kimi', 'codex']) {
      assert.ok(!hasBlindPath(repo, kind, path.join(repo, 'CLAUDE.md')), `${kind} 不该再报这份规则，实际：${titles(repo, kind).join(' | ')}`);
    }
  });
});

test('子目录的 CLAUDE.md 同样会被查出来', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    const sub = path.join(repo, 'packages', 'web');
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 根规则\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 根规则\n', 'utf8');
    const childClaude = path.join(sub, 'CLAUDE.md');
    fs.writeFileSync(childClaude, '# 子包规则\n', 'utf8');   // 没有配套 AGENTS.md
    assert.ok(hasBlindPath(sub, 'kimi', childClaude), `实际：${titles(sub, 'kimi').join(' | ')}`);
  });
});

test('嵌套 project root 之外的 Claude 规则仍要报：Claude 读到了，provider 没读到', () => {
  withRepo((root) => {
    const outer = path.join(root, 'outer');
    fs.mkdirSync(outer, { recursive: true });
    const repo = makeRepo(outer, 'proj');
    const outerClaude = path.join(outer, 'CLAUDE.md');
    fs.writeFileSync(outerClaude, '# 外层规则\n', 'utf8');  // 在 project root 之外
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 项目规则\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 项目规则\n', 'utf8');
    assert.ok(hasBlindPath(repo, 'kimi', outerClaude),
      `Kimi 越不过嵌套 git，但 Claude 确实读到了外层规则，Prompt 检视必须如实指出差异。实际：${titles(repo, 'kimi').join(' | ')}`);
  });
});

test('无 project root 时也要报：两家规则明确退化为只读 cwd，不是无从判断', () => {
  withRepo((root) => {
    const dir = path.join(root, 'plain');
    fs.mkdirSync(dir, { recursive: true });
    const claudeFile = path.join(dir, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, '# 规则\n', 'utf8');
    assert.ok(hasBlindPath(dir, 'kimi', claudeFile), `实际：${titles(dir, 'kimi').join(' | ')}`);
  });
});

test('同目录 AGENTS.md 存在但正文不同，不能用文件名冒充已送达', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    const claudeFile = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, '# Claude 项目规则\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 空壳占位\n', 'utf8');
    for (const kind of ['kimi', 'codex']) assert.ok(hasBlindPath(repo, kind, claudeFile), `${kind} 实际：${titles(repo, kind).join(' | ')}`);
  });
});

test('AGENTS.md 完整包含 Claude 规则并追加 provider 说明，视为已送达', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    const claudeFile = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, '# 共用项目规则\n\n- 先验证\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 共用项目规则\n\n- 先验证\n\n## Codex 专属\n- 跑 node --check\n', 'utf8');
    for (const kind of ['kimi', 'codex']) assert.ok(!hasBlindPath(repo, kind, claudeFile), `${kind} 实际：${titles(repo, kind).join(' | ')}`);
  });
});

test('只有单词子串碰巧相同不算完整规则镜像', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    const claudeFile = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, 'Rule\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), 'SuperRule\n', 'utf8');
    assert.ok(hasBlindPath(repo, 'kimi', claudeFile), `实际：${titles(repo, 'kimi').join(' | ')}`);
  });
});

test('规则已经由 provider 全局 AGENTS.md 送达时不重复告警', () => {
  withRepo((root) => {
    const claudeFile = path.join(root, 'CLAUDE.md');
    const globalAgents = path.join(root, 'provider-global-AGENTS.md');
    fs.writeFileSync(claudeFile, '# 已在全局生效\n', 'utf8');
    fs.writeFileSync(globalAgents, '# 已在全局生效\n', 'utf8');
    const missing = PI.findUnmirroredClaudeRules(
      [{ path: claudeFile, source: 'project', bytes: fs.statSync(claudeFile).size, imports: [] }],
      [{ path: globalAgents, source: 'user-global', bytes: fs.statSync(globalAgents).size }],
    );
    assert.deepStrictEqual(missing, []);
  });
});

test('CLAUDE.local.md 同样属于 Claude 实际注入链，不能漏检', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 共用规则\n', 'utf8');
    fs.writeFileSync(path.join(repo, 'CLAUDE.md'), '# 共用规则\n', 'utf8');
    const localFile = path.join(repo, 'CLAUDE.local.md');
    fs.writeFileSync(localFile, '# 只有 Claude 看见的本地规则\n', 'utf8');
    assert.ok(hasBlindPath(repo, 'kimi', localFile), `实际：${titles(repo, 'kimi').join(' | ')}`);
  });
});

test('CLAUDE.md 只有 @AGENTS.md 且目标已在 provider 链里，不误报', () => {
  withRepo((root) => {
    const repo = makeRepo(root, 'proj');
    fs.writeFileSync(path.join(repo, 'AGENTS.md'), '# 项目规则\n', 'utf8');
    const claudeFile = path.join(repo, 'CLAUDE.md');
    fs.writeFileSync(claudeFile, '<!-- Claude 入口 -->\n\n@AGENTS.md\n', 'utf8');
    for (const kind of ['kimi', 'codex']) assert.ok(!hasBlindPath(repo, kind, claudeFile), `${kind} 实际：${titles(repo, kind).join(' | ')}`);
  });
});

if (failed) process.exitCode = 1;
else console.log('All unreachable project rules tests passed.');
