'use strict';

function publicError(error) {
  const code = String(error && error.message || 'operation_failed');
  const known = new Set([
    'invalid_repo_root', 'invalid_file_path', 'invalid_review_decision', 'stale_hunk',
    'invalid_checkpoint_id', 'unsafe_restore_destination', 'restore_destination_exists',
    'review_state_corrupt', 'review_state_unreadable',
    'checkpoint_missing', 'checkpoint_corrupt', 'checkpoint_unreadable',
  ]);
  return known.has(code) ? code : 'operation_failed';
}

function registerWorkbenchOperationsIpc(ipcMain, deps = {}) {
  const service = deps.service;
  if (!service) throw new Error('workbench operations service is required');

  function handle(channel, method) {
    ipcMain.handle(channel, async (_event, payload = {}) => {
      try {
        return await service[method](payload || {});
      } catch (error) {
        deps.logger?.warn?.(`[workbench-operations] ${channel} failed:`, error && error.message);
        return { ok: false, error: publicError(error) };
      }
    });
  }

  handle('workbench:get-overview', 'overview');
  handle('workbench:get-diff', 'diff');
  handle('workbench:set-review-decision', 'setReviewDecision');
  handle('workbench:create-checkpoint', 'createCheckpoint');
  handle('workbench:restore-checkpoint', 'restoreCheckpoint');
  handle('workbench:get-line-provenance', 'lineProvenance');
  handle('workbench:get-timeline', 'timeline');
}

module.exports = {
  publicError,
  registerWorkbenchOperationsIpc,
};
