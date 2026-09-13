'use strict';
const fs = require('node:fs');
const path = require('node:path');
// One directory watcher per Hub, shared by workflow dispatch and its read model.
// A low-frequency reconciliation in each consumer covers dropped watch events.
const roots = new Map();
function subscribeTaskDirectory(dataDir, callback, logger = console) {
  const root = path.resolve(dataDir, 'task-docs');
  let entry = roots.get(root);
  if (!entry) {
    entry = { callbacks: new Set(), watcher: null, timer: null, ids: new Set(), retryAt: 0 };
    roots.set(root, entry);
    const notify = id => {
      entry.ids.add(id);
      if (entry.timer) return;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        const ids = [...entry.ids]; entry.ids.clear();
        for (const fn of entry.callbacks) for (const changed of ids) {
          try { fn(changed); } catch (error) { logger.error('[task-directory] change handler failed:', error); }
        }
      }, 60);
      entry.timer.unref?.();
    };
    entry.ensure = () => {
      if (entry.watcher || Date.now() < entry.retryAt) return;
      try {
        fs.mkdirSync(root, { recursive: true });
        entry.watcher = fs.watch(root, { recursive: true, persistent: false }, (_event, name) => {
          notify(name ? String(name).split(/[\\/]/)[0] : null);
        });
        entry.watcher.on('error', error => {
          logger.warn('[task-directory] watcher unavailable; periodic reconciliation retained:', error.message);
          entry.watcher?.close(); entry.watcher = null; entry.retryAt = Date.now() + 30_000; notify(null);
        });
      } catch (error) { entry.retryAt = Date.now() + 30_000; logger.warn('[task-directory] watch failed; periodic reconciliation retained:', error.message); }
    };
    entry.ensure();
  }
  entry.callbacks.add(callback);
  return {
    ensure: entry.ensure,
    dispose() {
      entry.callbacks.delete(callback);
      if (entry.callbacks.size) return;
      entry.watcher?.close(); clearTimeout(entry.timer); roots.delete(root);
    },
  };
}
module.exports = { subscribeTaskDirectory };
