'use strict';

const fs = require('fs');
const { StringDecoder } = require('string_decoder');

class JsonlTail {
  constructor(filepath, onLine) {
    this._filepath = filepath;
    this._onLine = onLine;
    this._offset = 0;
    this._buf = '';
    this._decoder = new StringDecoder('utf8');
    this._watcher = null;
    this._pollTimer = null;
    this._closed = false;
    this._reading = false;
  }

  async start() {
    if (this._closed) return;
    try { await this._drain(); } catch {}

    try {
      this._watcher = fs.watch(this._filepath, { persistent: false }, () => {
        this._drain().catch(() => {});
      });
      this._watcher.on('error', () => {});
    } catch {
      // fs.watch can fail on network drives / exotic filesystems; polling below is the fallback.
    }

    this._pollTimer = setInterval(() => {
      this._drain().catch(() => {});
    }, 500);
    this._pollTimer.unref?.();
  }

  async _drain() {
    if (this._closed || this._reading) return;
    this._reading = true;
    try {
      const stat = await fs.promises.stat(this._filepath);
      if (stat.size <= this._offset) return;
      const fh = await fs.promises.open(this._filepath, 'r');
      try {
        const len = stat.size - this._offset;
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, this._offset);
        this._offset = stat.size;
        this._buf += this._decoder.write(buf);
        const lines = this._buf.split('\n');
        this._buf = lines.pop() || '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let obj;
          try { obj = JSON.parse(trimmed); } catch { continue; }
          try { this._onLine(obj); } catch (e) { console.warn('[jsonl-tail] onLine 回调抛出异常（该行已丢弃，不重试）:', e && e.message, '| file:', this._filepath); }
        }
      } finally {
        await fh.close();
      }
    } catch {
      // Transient IO errors such as rotation/deletion are retried on the next tick.
    } finally {
      this._reading = false;
    }
  }

  close() {
    this._closed = true;
    try { this._watcher?.close(); } catch {}
    try { clearInterval(this._pollTimer); } catch {}
    this._watcher = null;
    this._pollTimer = null;
    this._decoder.end();
  }
}

module.exports = { JsonlTail };
