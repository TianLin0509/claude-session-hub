const fs = require('fs');

// Minimal cross-process file lock built on fs.openSync(path, 'wx').
// 'wx' = O_CREAT | O_EXCL: atomically fails with EEXIST if the file already
// exists, so two processes racing to create the same lock file get exactly
// one winner. Works on Windows + POSIX without any external dependency.
//
// Why not proper-lockfile from npm? CLAUDE.md forbids npm install in the
// main worktree, and the production hub worktree shares node_modules via
// junction — installing here would pollute production. The semantics we
// need (acquire/release + stale detection + retry + fallback on failure)
// are tiny enough to write inline.
//
// Usage:
//   const fd = acquireLock('/path/to/foo.lock');
//   if (fd != null) {
//     try { ...protected work... }
//     finally { releaseLock(fd, '/path/to/foo.lock'); }
//   } else {
//     // could not acquire within timeout; caller decides what to do
//     // (usually log + proceed without lock as a graceful fallback)
//   }

const DEFAULT_RETRIES = 20;
const DEFAULT_RETRY_DELAY_MS = 50;
const DEFAULT_STALE_MS = 10000; // a writer holding the lock > 10s is considered crashed

function _sleepBusy(ms) {
  // Sync busy wait — only used between retries, total bounded by retries*delay
  // (~1s). Saves us from making save() async-only.
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

function acquireLock(lockPath, opts = {}) {
  const retries = opts.retries ?? DEFAULT_RETRIES;
  const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;
  const staleMs = opts.staleMs ?? DEFAULT_STALE_MS;
  const owner = { pid: process.pid, mtime: Date.now() };

  let attempts = 0;
  // Cap stale-reap retries separately to avoid unbounded loop if a stale-detect
  // race keeps re-creating the lock under us.
  let staleReaped = 0;
  const STALE_REAP_LIMIT = 3;

  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try { fs.writeSync(fd, JSON.stringify(owner)); } catch { /* writing meta is best-effort */ }
      return fd;
    } catch (e) {
      if (e.code !== 'EEXIST') {
        // Permissions / FS error — bail to fallback path.
        return null;
      }
      // Stale lock detection: if the file is older than staleMs, the owner
      // probably crashed without releasing. Reap it and retry immediately
      // WITHOUT consuming a retry slot (otherwise stale + retries=0 deadlocks).
      let didReap = false;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          try { fs.unlinkSync(lockPath); didReap = true; } catch { /* another proc may have just released */ }
        }
      } catch { /* lock file vanished between EEXIST and statSync — race-friendly */ }

      if (didReap) {
        staleReaped++;
        if (staleReaped > STALE_REAP_LIMIT) return null;
        continue;
      }

      if (attempts >= retries) return null;
      attempts++;
      _sleepBusy(retryDelayMs);
    }
  }
}

function releaseLock(fd, lockPath) {
  if (fd != null) {
    try { fs.closeSync(fd); } catch { /* close errors don't block release */ }
  }
  try { fs.unlinkSync(lockPath); } catch { /* file may have been reaped as stale */ }
}

module.exports = { acquireLock, releaseLock };
