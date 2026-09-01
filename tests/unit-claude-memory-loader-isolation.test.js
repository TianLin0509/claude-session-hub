'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const loader = require('../core/claude-memory-loader.js');

function seedHome(root, marker) {
  const memoryDir = loader.resolveClaudeMemoryDir(root);
  fs.mkdirSync(memoryDir, { recursive: true });
  fs.writeFileSync(path.join(memoryDir, 'MEMORY.md'), `# ${marker}\n`, 'utf8');
  return memoryDir;
}

test('DeepSeek 注入文件严格读取显式隔离 home，不读取生产 home', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memory-loader-home-'));
  try {
    const productionLike = path.join(temp, 'production-home');
    const isolated = path.join(temp, 'isolated-home');
    const hubDataDir = path.join(temp, 'hub-data');
    seedHome(productionLike, 'PRODUCTION_SENTINEL');
    const isolatedMemoryDir = seedHome(isolated, 'ISOLATED_SENTINEL');

    loader.invalidateCache();
    const target = loader.ensureClaudeMemoryFile(hubDataDir, { homeDir: isolated });
    const text = fs.readFileSync(target, 'utf8');
    assert.match(text, /ISOLATED_SENTINEL/);
    assert.doesNotMatch(text, /PRODUCTION_SENTINEL/);
    assert.ok(text.includes(isolatedMemoryDir));
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('缓存键包含 source path，切换 home 不会复用上一家的注入文件', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memory-loader-cache-'));
  try {
    const firstHome = path.join(temp, 'first-home');
    const secondHome = path.join(temp, 'second-home');
    const hubDataDir = path.join(temp, 'hub-data');
    seedHome(firstHome, 'FIRST_SENTINEL');
    seedHome(secondHome, 'SECOND_SENTINEL');

    loader.invalidateCache();
    const target = loader.ensureClaudeMemoryFile(hubDataDir, { homeDir: firstHome });
    assert.match(fs.readFileSync(target, 'utf8'), /FIRST_SENTINEL/);
    loader.ensureClaudeMemoryFile(hubDataDir, { homeDir: secondHome });
    const switched = fs.readFileSync(target, 'utf8');
    assert.match(switched, /SECOND_SENTINEL/);
    assert.doesNotMatch(switched, /FIRST_SENTINEL/);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('未显式传 home 时遵守 CLAUDE_HUB_HOME_DIR', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-memory-loader-env-'));
  const previous = process.env.CLAUDE_HUB_HOME_DIR;
  try {
    const isolated = path.join(temp, 'isolated-home');
    const hubDataDir = path.join(temp, 'hub-data');
    seedHome(isolated, 'ENV_ISOLATED_SENTINEL');
    process.env.CLAUDE_HUB_HOME_DIR = isolated;
    loader.invalidateCache();
    const target = loader.ensureClaudeMemoryFile(hubDataDir);
    assert.match(fs.readFileSync(target, 'utf8'), /ENV_ISOLATED_SENTINEL/);
  } finally {
    if (previous === undefined) delete process.env.CLAUDE_HUB_HOME_DIR;
    else process.env.CLAUDE_HUB_HOME_DIR = previous;
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
