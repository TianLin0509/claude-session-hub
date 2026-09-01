'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const inspector = require('../core/memory-inspector.js');

function fixture() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memory-provider-'));
  const homeDir = path.join(temp, 'home');
  const workspaceRoot = path.join(temp, 'AIWork');
  const hubDataDir = path.join(temp, 'hub-data');
  for (const dir of [
    path.join(homeDir, '.codex', 'memories'),
    path.join(homeDir, '.claude'),
    path.join(homeDir, '.claude-deepseek'),
    path.join(homeDir, '.kimi-code'),
    path.join(homeDir, '.gemini'),
    workspaceRoot,
    hubDataDir,
  ]) fs.mkdirSync(dir, { recursive: true });

  fs.writeFileSync(path.join(workspaceRoot, '.aiwork-root'), 'marker\n');
  fs.writeFileSync(path.join(workspaceRoot, '.vibe-root'), 'marker\n');
  fs.writeFileSync(path.join(workspaceRoot, 'AGENTS.md'), '# ROOT AGENTS\n');
  fs.writeFileSync(path.join(workspaceRoot, 'CLAUDE.md'), '# ROOT CLAUDE\n');
  fs.writeFileSync(path.join(workspaceRoot, 'GEMINI.md'), '# ROOT GEMINI\n');
  fs.writeFileSync(path.join(homeDir, '.codex', 'AGENTS.md'), '# CODEX GLOBAL\n');
  fs.writeFileSync(path.join(homeDir, '.codex', 'config.toml'), [
    'project_root_markers = [".vibe-root"]',
    '[features]',
    'memories = true',
  ].join('\n'));
  fs.writeFileSync(path.join(homeDir, '.codex', 'memories', 'memory_summary.md'), '# CODEX MEMORY\n');
  fs.writeFileSync(path.join(homeDir, '.claude', 'CLAUDE.md'), '# CLAUDE GLOBAL\n');
  fs.writeFileSync(path.join(homeDir, '.claude-deepseek', 'CLAUDE.md'), '# LEGACY DS GLOBAL\n');
  fs.writeFileSync(path.join(homeDir, '.kimi-code', 'AGENTS.md'), '# KIMI GLOBAL\n');
  fs.writeFileSync(path.join(homeDir, '.gemini', 'GEMINI.md'), '# GEMINI GLOBAL\n');
  return { temp, homeDir, workspaceRoot, hubDataDir };
}

function paths(rows) {
  return rows.map(row => path.resolve(row.path).toLowerCase());
}

test('Codex 当前会话只列 Codex 指令链并展示独立 local memories', () => {
  const fx = fixture();
  try {
    const data = inspector.getSessionFiles({
      cwd: fx.workspaceRoot,
      kind: 'codex',
      homeDir: fx.homeDir,
      workspaceRoot: fx.workspaceRoot,
    });
    assert.equal(data.codexFamily, true);
    assert.equal(data.claudeFamily, false);
    assert.deepEqual(paths(data.files), [
      path.join(fx.homeDir, '.codex', 'AGENTS.md').toLowerCase(),
      path.join(fx.workspaceRoot, 'AGENTS.md').toLowerCase(),
    ]);
    assert.equal(new Set(paths(data.files)).size, data.files.length, 'flat root 不得重复列同一文件');
    assert.equal(data.memory[0].status, 'enabled');
    assert.deepEqual(data.memoryFiles.map(row => row.label), ['memory_summary.md']);
    assert.match(data.memoryNote, /后台生成/);
  } finally {
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('Claude 当前会话只列 CLAUDE.md 链，不混入其它 provider', () => {
  const fx = fixture();
  try {
    const data = inspector.getSessionFiles({
      cwd: fx.workspaceRoot,
      kind: 'claude',
      homeDir: fx.homeDir,
      workspaceRoot: fx.workspaceRoot,
    });
    assert.equal(data.claudeFamily, true);
    assert.equal(data.codexFamily, false);
    assert.deepEqual(paths(data.files), [
      path.join(fx.homeDir, '.claude', 'CLAUDE.md').toLowerCase(),
      path.join(fx.workspaceRoot, 'CLAUDE.md').toLowerCase(),
    ]);
    assert.ok(data.files.every(row => !/AGENTS|GEMINI/.test(row.path)));
    assert.equal(data.memory[0].root, '.claude');
  } finally {
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('当前 DeepSeek 走 Codex profile；只有 legacy DeepSeek 走 Claude bucket', () => {
  const fx = fixture();
  try {
    const profile = path.join(fx.temp, 'deepseek-codex-profile');
    fs.mkdirSync(path.join(profile, 'sessions'), { recursive: true });
    fs.writeFileSync(path.join(profile, 'config.toml'), 'project_root_markers = [".vibe-root"]\n');

    const current = inspector.getSessionFiles({
      cwd: fx.workspaceRoot,
      kind: 'deepseek',
      runtimeKind: 'deepseek',
      codexSessionsRoot: path.join(profile, 'sessions'),
      codexProfile: 'deepseek-api',
      meetingId: 'm1',
      homeDir: fx.homeDir,
      workspaceRoot: fx.workspaceRoot,
    });
    assert.equal(current.codexFamily, true);
    assert.equal(current.claudeFamily, false);
    assert.equal(current.memory[0].status, 'disabled');
    assert.match(current.memoryNote, /群聊会额外注入/);

    const legacy = inspector.getSessionFiles({
      cwd: fx.workspaceRoot,
      kind: 'deepseek',
      runtimeKind: 'deepseek-legacy',
      homeDir: fx.homeDir,
      workspaceRoot: fx.workspaceRoot,
    });
    assert.equal(legacy.claudeFamily, true);
    assert.equal(legacy.codexFamily, false);
    assert.equal(legacy.memory[0].root, '.claude-deepseek');
    assert.ok(paths(legacy.files).includes(path.join(fx.homeDir, '.claude-deepseek', 'CLAUDE.md').toLowerCase()));
  } finally {
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});

test('总览同时给出 Claude 规范库与主 Codex local memories，且标明整理覆盖边界', () => {
  const fx = fixture();
  try {
    const overview = inspector.getOverview({
      homeDir: fx.homeDir,
      workspaceRoot: fx.workspaceRoot,
      flatRoot: true,
      hubDataDir: fx.hubDataDir,
      consolidationConfig: {},
    });
    assert.equal(overview.codexMemory.useMemories, true);
    assert.equal(overview.codexMemory.totalFiles, 1);
    assert.equal(overview.consolidation.coverage.includesNormalSessions, false);
    assert.match(overview.consolidation.coverage.label, /seed/);
  } finally {
    fs.rmSync(fx.temp, { recursive: true, force: true });
  }
});
