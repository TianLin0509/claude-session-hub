'use strict';

const os = require('os');
const { Terminal } = require('@xterm/headless');
const { SerializeAddon } = require('@xterm/addon-serialize');

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;
const DEFAULT_SCROLLBACK = 10000;
const COMPACT_THRESHOLD_BYTES = 2 * 1024 * 1024;

// Headless xterm buffers are deliberately short-lived. A populated 10k-line
// terminal can use tens of MB; keeping one per live Hub session would defeat
// the renderer's four-terminal cache. Serialize/compaction jobs share one
// global lane so several noisy sessions cannot create large parsers at once.
const compactionJobs = [];
let compactionRunning = false;

async function drainCompactions() {
  if (compactionRunning) return;
  compactionRunning = true;
  try {
    while (compactionJobs.length) {
      const job = compactionJobs.shift();
      try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
    }
  } finally {
    compactionRunning = false;
  }
}

function runCompaction(operation) {
  return new Promise((resolve, reject) => {
    compactionJobs.push({ operation, resolve, reject });
    void drainCompactions();
  });
}

function clampInt(value, fallback, min) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(min, Math.floor(n)) : fallback;
}

function writeTerminal(terminal, text) {
  return new Promise((resolve) => terminal.write(text, resolve));
}

function terminalOptions(cols, rows, scrollback) {
  return {
    cols,
    rows,
    scrollback,
    allowProposedApi: true,
    ...(process.platform === 'win32' ? {
      windowsPty: {
        backend: 'conpty',
        buildNumber: parseInt(os.release().split('.').pop(), 10) || 0,
      },
    } : {}),
  };
}

function cloneCoalescedOperations(operations) {
  const result = [];
  let writeParts = [];
  const flushWrites = () => {
    if (!writeParts.length) return;
    result.push({ type: 'write', data: writeParts.join('') });
    writeParts = [];
  };
  for (const operation of operations) {
    if (operation.type === 'write') {
      writeParts.push(operation.data);
      continue;
    }
    flushWrites();
    if (operation.type === 'resize') {
      result.push({ type: 'resize', cols: operation.cols, rows: operation.rows });
    }
  }
  flushWrites();
  return result;
}

// Main-process terminal state without a permanently resident framebuffer.
//
// `_base` is a self-contained VT sequence produced by SerializeAddon; `_tail`
// contains complete raw PTY chunks that arrived after that exact sequence.
// Replaying base+tail can never start in the middle of an ANSI instruction,
// which is the defect in the old 1MB byte-tail restore. At snapshot time (or
// after 2MB of new output) we briefly replay into headless xterm, serialize a
// fresh base, then dispose the terminal and keep only strings in memory.
class TerminalSnapshot {
  constructor(opts = {}) {
    this._scrollback = clampInt(opts.scrollback, DEFAULT_SCROLLBACK, 0);
    this._cols = clampInt(opts.cols, DEFAULT_COLS, 2);
    this._rows = clampInt(opts.rows, DEFAULT_ROWS, 1);
    this._baseCols = this._cols;
    this._baseRows = this._rows;
    this._base = '';
    this._tail = [];
    this._tailBytes = 0;
    this._operations = [];
    this._draining = false;
    this._seq = 0;
    this._disposed = false;
  }

  _append(operation) {
    return new Promise((resolve, reject) => {
      this._operations.push({ operation, resolve, reject });
      void this._drain();
    });
  }

  async _drain() {
    if (this._draining) return;
    this._draining = true;
    try {
      while (this._operations.length) {
        const job = this._operations.shift();
        try { job.resolve(await job.operation()); } catch (error) { job.reject(error); }
      }
    } finally {
      this._draining = false;
    }
  }

  async _compact() {
    if (this._disposed) return;
    if (this._tail.length === 0) return;
    const operations = this._tail;
    const hasWrites = operations.some((operation) => operation.type === 'write');
    if (!this._base && !hasWrites) {
      this._tail = [];
      this._tailBytes = 0;
      this._baseCols = this._cols;
      this._baseRows = this._rows;
      return;
    }

    await runCompaction(async () => {
      if (this._disposed) return;
      const terminal = new Terminal(terminalOptions(this._baseCols, this._baseRows, this._scrollback));
      const addon = new SerializeAddon();
      terminal.loadAddon(addon);
      try {
        if (this._base) await writeTerminal(terminal, this._base);
        for (const operation of operations) {
          if (operation.type === 'resize') {
            if (terminal.cols !== operation.cols || terminal.rows !== operation.rows) {
              terminal.resize(operation.cols, operation.rows);
            }
          } else if (operation.type === 'write') {
            await writeTerminal(terminal, operation.data);
          }
        }
        if (this._disposed) return;
        // SerializeAddon returns a large cons-string assembled from many tiny
        // fragments. Keeping that rope retained hundreds of MB of intermediate
        // strings across sessions even after xterm.dispose(). Round-trip through
        // Buffer once so the long-lived snapshot is one flat UTF-8 string.
        this._base = Buffer.from(
          addon.serialize({ scrollback: this._scrollback }),
          'utf8',
        ).toString('utf8');
        this._tail = [];
        this._tailBytes = 0;
        this._baseCols = this._cols;
        this._baseRows = this._rows;
      } finally {
        // xterm does not guarantee that Terminal.dispose() releases addon-owned
        // serialization state immediately. Disposing both avoids retaining the
        // large scrollback cell graph after compaction.
        try { addon.dispose(); } catch {}
        try { terminal.dispose(); } catch {}
      }
    });
  }

  write(data, seq) {
    if (this._disposed || data == null || data === '') return;
    const text = String(data);
    const outputSeq = Number(seq);
    void this._append(async () => {
      if (this._disposed) return;
      this._tail.push({ type: 'write', data: text });
      this._tailBytes += Buffer.byteLength(text, 'utf8');
      if (Number.isFinite(outputSeq)) this._seq = Math.max(this._seq, outputSeq);
      if (this._tailBytes >= COMPACT_THRESHOLD_BYTES) await this._compact();
    });
  }

  resize(cols, rows) {
    if (this._disposed) return;
    const nextCols = clampInt(cols, this._cols, 2);
    const nextRows = clampInt(rows, this._rows, 1);
    void this._append(async () => {
      if (this._disposed || (nextCols === this._cols && nextRows === this._rows)) return;
      // Record geometry changes in the same ordered operation log as PTY data.
      // Replaying them at compaction preserves xterm reflow semantics without
      // constructing a large headless terminal for every resize event.
      this._tail.push({ type: 'resize', cols: nextCols, rows: nextRows });
      this._cols = nextCols;
      this._rows = nextRows;
    });
  }

  snapshot() {
    if (this._disposed) return Promise.resolve(null);
    // Queueing is still the exact seq barrier used by renderer hydrate, but do
    // not force a headless-xterm compaction here. A group of resumed sessions
    // can each have megabytes of TUI history; serializing all of them through
    // the global compaction lane made every newly opened PTY remain blank until
    // the earlier sessions finished replaying.
    //
    // `_base` is already self-contained. `_tail` stores complete ordered write
    // chunks plus geometry changes, so the renderer can replay it losslessly.
    // Adjacent writes are joined to keep IPC payloads small. Threshold-driven
    // background compaction still bounds long-lived memory use.
    return this._append(async () => {
      if (this._disposed) return null;
      const operations = cloneCoalescedOperations(this._tail);
      const hasResize = operations.some((operation) => operation.type === 'resize');
      if (!hasResize) {
        const writes = operations
          .filter((operation) => operation.type === 'write')
          .map((operation) => operation.data);
        return {
          text: [this._base, ...writes].join(''),
          operations: null,
          seq: this._seq,
          source: 'ordered-vt-fast-snapshot',
          cols: this._cols,
          rows: this._rows,
          baseCols: this._baseCols,
          baseRows: this._baseRows,
        };
      }
      return {
        text: this._base,
        operations,
        seq: this._seq,
        source: 'ordered-vt-operations-snapshot',
        cols: this._cols,
        rows: this._rows,
        baseCols: this._baseCols,
        baseRows: this._baseRows,
      };
    });
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    this._base = '';
    this._tail = [];
    this._tailBytes = 0;
  }
}

module.exports = {
  COMPACT_THRESHOLD_BYTES,
  DEFAULT_SCROLLBACK,
  TerminalSnapshot,
};
