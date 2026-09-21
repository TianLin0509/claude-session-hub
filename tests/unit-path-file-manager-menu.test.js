'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { createPathLinkContextMenuController } = require('../renderer/path-link-context-menu');
const { _normalizeLocalPathForOpen } = require('../renderer/path-candidates');

function fixture(openFileManager) {
  const manager = { style: {} }, copy = { dataset: {} }, notices = [];
  const menuEl = { style: {}, querySelectorAll: () => [], querySelector: s => s.includes('open-file-manager') ? manager : copy, getBoundingClientRect: () => ({ right: 10, bottom: 10 }) };
  const controller = createPathLinkContextMenuController({
    document: { body: { appendChild: e => notices.push(e) }, createElement: () => ({ style: {}, dataset: {}, setAttribute() {} }) },
    window: { innerWidth: 100, innerHeight: 100, setTimeout: () => 1, clearTimeout() {} }, menuEl,
    getSessionCwd: () => 'C:\\wrong-session', getActiveSessionId: () => 'old', getActiveCwd: () => 'C:\\group-workspace',
    normalizeLocalPathForOpen: _normalizeLocalPathForOpen, openFileManager,
    requestAnimationFrameFn: fn => fn(),
  });
  return { controller, manager, notices };
}
test('file manager resolves group relative paths, explicit owner cwd and encoded file URLs', async () => {
  const calls = [];
  const { controller, manager } = fixture(async (...args) => { calls.push(args); return { ok: true }; });
  controller.open('./报告 with spaces.md', 0, 0);
  await controller.runAction('open-file-manager');
  assert.deepEqual(calls.pop(), ['C:\\group-workspace\\报告 with spaces.md', 'C:\\group-workspace']);
  controller.open('./child/report.md', 0, 0, 'C:\\owner');
  await controller.runAction('open-file-manager');
  assert.deepEqual(calls.pop(), ['C:\\owner\\child\\report.md', 'C:\\owner']);
  const target = 'C:\\group-workspace\\报告 with spaces.md';
  controller.open(pathToFileURL(target).href, 0, 0);
  await controller.runAction('open-file-manager');
  assert.equal(calls.pop()[0], target);
  controller.open('https://example.com/report.md', 0, 0);
  assert.equal(manager.disabled, true);
  await controller.runAction('open-file-manager');
  assert.equal(calls.length, 0, 'remote URLs cannot be treated as local paths');
});
test('file manager failures are visible and never fall back to external open', async () => {
  const { controller, notices } = fixture(async () => ({ ok: false, error: 'missing directory' }));
  controller.open('C:\\missing\\report.md', 0, 0);
  await controller.runAction('open-file-manager');
  assert.equal(notices[0].dataset.state, 'error');
  assert.match(notices[0].textContent, /missing directory/);
});
