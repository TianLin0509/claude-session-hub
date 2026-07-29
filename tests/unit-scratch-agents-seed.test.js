'use strict';
// Claude Code walks the whole path up to <root>\CLAUDE.md, but Codex / Kimi /
// Gemini only read their own global AGENTS.md plus the one in cwd. Measured
// 2026-07-27: asking Codex inside C:\Vibe\_scratch\inbox-* about a rule that
// only exists in C:\Vibe\AGENTS.md returns NO-RULES, in both a git repo and a
// plain directory. Seeding a copy into every scratch is the only way those CLIs
// inherit the workspace boundary rules.

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { WorkspaceService } = require('../core/workspace-service.js');

function test(name, fn) {
  try {
    fn();
    console.log(`  OK ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    console.error(err.stack || err.message);
    process.exitCode = 1;
  }
}

function withRoot(fn, { withAgents = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-seed-'));
  try {
    if (withAgents) {
      fs.writeFileSync(path.join(root, 'AGENTS.md'), '# 约定\n\n- 工具装到 C:\\DevTools\n', 'utf8');
    }
    // 注册表也要隔离，否则每跑一次就往生产 workspaces.json 塞一条临时目录。
    fn(new WorkspaceService({
      workspaceRoot: root,
      getHubDataDir: () => path.join(root, 'hub-data'),
      initGit: () => true,
    }), root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

console.log('Running scratch AGENTS.md seeding tests...');

test('a new scratch workspace carries the root rules for non-Claude CLIs', () => {
  withRoot((service) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    const seeded = path.join(scratch.path, 'AGENTS.md');
    assert.ok(fs.existsSync(seeded), 'scratch must get its own AGENTS.md');
    const body = fs.readFileSync(seeded, 'utf8');
    assert.ok(body.includes('C:\\DevTools'), 'root rules must be present verbatim');
    assert.ok(body.startsWith('<!--'), 'a provenance header explains where the copy came from');
    assert.ok(body.includes('Codex / Kimi / Gemini'), 'header must say why the copy exists');
  });
});

test('seeding runs before git init so the file is part of the first commit surface', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'core', 'workspace-service.js'), 'utf8');
  const seedAt = src.indexOf('this.seedScratchAgentsFile(cwd);');
  const gitAt = src.indexOf('gitInitialized = !!this.initGit(cwd);');
  assert.ok(seedAt > 0 && gitAt > seedAt, 'seed must happen before initGit');
});

test('an existing AGENTS.md is never overwritten', () => {
  withRoot((service, root) => {
    const cwd = path.join(root, '_scratch', 'manual');
    fs.mkdirSync(cwd, { recursive: true });
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'project-owned\n', 'utf8');
    assert.strictEqual(service.seedScratchAgentsFile(cwd), false);
    assert.strictEqual(fs.readFileSync(path.join(cwd, 'AGENTS.md'), 'utf8'), 'project-owned\n');
  });
});

test('a root without AGENTS.md degrades to a no-op', () => {
  withRoot((service) => {
    const scratch = service.createScratchWorkspace({ label: '未命名任务' });
    assert.strictEqual(fs.existsSync(path.join(scratch.path, 'AGENTS.md')), false);
    assert.strictEqual(scratch.draft, true, 'workspace creation must still succeed');
  }, { withAgents: false });
});

if (!process.exitCode) console.log('All scratch AGENTS.md seeding tests passed.');
