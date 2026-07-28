'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { WorkspaceService, isPathInside, normalizeKey, safeSlug } = require('../core/workspace-service.js');

function run() {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-workspace-service-'));
  try {
    let serial = 0;
    const service = new WorkspaceService({
      getHubDataDir: () => path.join(tempRoot, 'hub-data'),
      isIsolatedHub: () => true,
      workspaceRoot: path.join(tempRoot, 'workspaces'),
      now: () => Date.UTC(2026, 6, 26, 3, 0, serial++),
      randomId: () => `id${serial}`,
      logger: { warn() {} },
    });

    const scratch = service.createScratchWorkspace();
    assert(fs.statSync(scratch.path).isDirectory());
    assert(fs.statSync(path.join(scratch.path, '.git')).isDirectory(), 'scratch workspace should be git-backed');
    assert.strictEqual(scratch.draft, true);
    assert.strictEqual(scratch.gitInitialized, true);

    const named = service.updateSuggestedName(scratch.path, '修复 AI Hub 工作区入口');
    assert.strictEqual(named.label, '修复 AI Hub 工作区入口');
    assert.strictEqual(named.suggestedName, '修复-AI-Hub-工作区入口');

    const category = path.join(service.getWorkspaceRoot(), 'Tools');
    fs.mkdirSync(category, { recursive: true });
    assert.strictEqual(service.getArchiveContext(scratch.path).required, true);
    assert.strictEqual(service.listArchiveCategories().some(item => item.name === 'Tools'), true);
    const archived = service.archiveDraft(scratch.path, { parent: category, folderName: named.suggestedName });
    assert.strictEqual(archived.draft, false);
    assert.strictEqual(fs.existsSync(scratch.path), false, 'archive should remove the scratch directory');
    assert.strictEqual(fs.existsSync(archived.path), true, 'archive should atomically move the workspace');
    assert.strictEqual(service.getArchiveContext(archived.path).required, false);

    const project = path.join(tempRoot, 'existing-project');
    fs.mkdirSync(project);
    service.touchWorkspace(project, { label: 'Existing', draft: false, select: true });
    const registry = service.listWorkspaces([project]);
    assert.strictEqual(registry.items.length, 2);
    assert.strictEqual(normalizeKey(registry.selectedPath), normalizeKey(project));
    assert.strictEqual(safeSlug('a<> b'), 'a-b');
    assert.strictEqual(isPathInside(category, archived.path), true);

    console.log('unit-workspace-service: PASS');
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

run();
