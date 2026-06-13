'use strict';

// E2E 远程模式：CDP 驱动公共库（连公司侧 Hub 的 renderer，模拟真人 UI 操作）

const http = require('http');
const WebSocket = require('ws');

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor() { this.ws = null; this.id = 0; this.pending = new Map(); }

  async connect(port) {
    const targets = await getJson(`http://127.0.0.1:${port}/json/list`);
    const page = targets.find((t) => t.type === 'page' && /index\.html/.test(t.url || ''));
    if (!page) throw new Error(`no index.html page target on :${port}; targets=${targets.map(t => t.url).join(',')}`);
    this.ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result);
      }
      // 自动接受 window.confirm/alert（需先 Page.enable + autoAcceptDialogs()）
      if (msg.method === 'Page.javascriptDialogOpening' && this._autoAccept) {
        console.log(`[cdp] auto-accept dialog: ${(msg.params.message || '').slice(0, 80).replace(/\n/g, ' ')}`);
        this.send('Page.handleJavaScriptDialog', { accept: true }).catch(() => {});
      }
    });
  }

  async autoAcceptDialogs() {
    await this.send('Page.enable');
    this._autoAccept = true;
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }
      }, 30000);
    });
  }

  // 执行 JS 表达式，返回值（returnByValue）
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(`page JS error: ${r.exceptionDetails.text} ${(r.exceptionDetails.exception || {}).description || ''}`);
    return r.result ? r.result.value : undefined;
  }

  // 轮询等待页面条件为真
  async waitFor(expr, timeoutMs, label) {
    const t0 = Date.now();
    for (;;) {
      const v = await this.eval(expr);
      if (v) return v;
      if (Date.now() - t0 > timeoutMs) throw new Error(`waitFor timeout (${label || expr})`);
      await new Promise((r) => setTimeout(r, 600));
    }
  }

  async screenshot(file) {
    const fs = require('fs');
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }

  close() { try { this.ws.close(); } catch {} }
}

module.exports = { Cdp };
