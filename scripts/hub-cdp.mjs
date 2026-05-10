#!/usr/bin/env node
// Tiny CDP client for driving the running Hub Electron via remote-debugging-port.
// Uses Hub's own node_modules/ws — no extra deps.
//
// Usage:
//   node hub-cdp.mjs targets
//   node hub-cdp.mjs eval "document.title"
//   node hub-cdp.mjs click "button.btn-roundtable"
//   node hub-cdp.mjs type "你好"
//   node hub-cdp.mjs key Enter
//   node hub-cdp.mjs wait "selector"          # wait until selector exists (timeout 10s)
//   node hub-cdp.mjs snapshot                 # dump body innerText (truncated)
//
// Env: HUB_CDP_HOST (default 127.0.0.1), HUB_CDP_PORT (default 9221).

import http from 'node:http';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
// Resolve ws from Hub's node_modules
const wsPath = path.resolve(__dirname, '..', 'node_modules', 'ws');
const { default: WebSocket } = await import(path.join(wsPath, 'wrapper.mjs')).catch(async () => {
  // Fallback: ws is CommonJS, need createRequire
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  return { default: require(wsPath) };
});

const HOST = process.env.HUB_CDP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.HUB_CDP_PORT || '9221', 10);

function fetchJson(p) {
  return new Promise((resolve, reject) => {
    http.get(`http://${HOST}:${PORT}${p}`, res => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function findHubMain() {
  const targets = await fetchJson('/json');
  // Hub main window: type=page, url is the renderer (file:// ... index.html)
  return targets.find(t => t.type === 'page' && /index\.html/i.test(t.url || ''));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.ready = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
    });
    this.ws.on('message', buf => {
      const m = JSON.parse(buf.toString());
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(`CDP error: ${JSON.stringify(m.error)}`));
        else resolve(m.result);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  async eval(expression, opts = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      ...opts,
    });
    if (r.exceptionDetails) {
      const txt = r.exceptionDetails.exception?.description || r.exceptionDetails.text;
      throw new Error(`Eval threw: ${txt}`);
    }
    return r.result?.value;
  }
  close() { this.ws.close(); }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);

  if (cmd === 'targets') {
    console.log(JSON.stringify(await fetchJson('/json'), null, 2));
    return;
  }

  const target = await findHubMain();
  if (!target) {
    console.error(`No Hub main page (type=page, url ~ index.html) at ${HOST}:${PORT}`);
    console.error('All targets:');
    console.error(JSON.stringify(await fetchJson('/json'), null, 2));
    process.exit(2);
  }

  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Runtime.enable');

  try {
    switch (cmd) {
      case 'eval': {
        let code;
        if (rest[0] === '--file' && rest[1]) {
          const { readFileSync } = await import('node:fs');
          code = readFileSync(rest[1], 'utf8').replace(/^﻿/, ''); // strip BOM
        } else if (rest[0] === '--stdin') {
          // read all of stdin
          code = await new Promise(r => {
            let s = '';
            process.stdin.setEncoding('utf8');
            process.stdin.on('data', c => (s += c));
            process.stdin.on('end', () => r(s));
          });
        } else {
          code = rest.join(' ');
        }
        const v = await cdp.eval(`(async () => { return (${code}); })()`);
        console.log(JSON.stringify(v, null, 2));
        break;
      }
      case 'click': {
        const sel = rest[0];
        await cdp.eval(
          `(() => {
            const el = document.querySelector(${JSON.stringify(sel)});
            if (!el) throw new Error('selector not found: ' + ${JSON.stringify(sel)});
            el.scrollIntoView({block:'center', behavior:'instant'});
            const r = el.getBoundingClientRect();
            const cx = r.left + r.width/2, cy = r.top + r.height/2;
            const opts = {bubbles:true, cancelable:true, view:window, button:0, clientX:cx, clientY:cy};
            el.dispatchEvent(new MouseEvent('mousedown', opts));
            el.dispatchEvent(new MouseEvent('mouseup', opts));
            el.dispatchEvent(new MouseEvent('click', opts));
            return {tag: el.tagName, text: (el.textContent||'').slice(0,80)};
          })()`,
        );
        console.log('clicked:', sel);
        break;
      }
      case 'type': {
        // For PTY/xterm typing we send keyboard events; for normal inputs, set value.
        const text = rest.join(' ');
        await cdp.eval(
          `(() => {
            const ae = document.activeElement;
            // Strategy: dispatch keydown/keypress/keyup + input event for each char.
            for (const ch of ${JSON.stringify(text)}) {
              const ev = (type) => new KeyboardEvent(type, {key: ch, bubbles:true, cancelable:true});
              ae.dispatchEvent(ev('keydown'));
              ae.dispatchEvent(ev('keypress'));
              if (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA') {
                ae.value += ch;
                ae.dispatchEvent(new Event('input', {bubbles:true}));
              }
              ae.dispatchEvent(ev('keyup'));
            }
            return ae.tagName;
          })()`
        );
        console.log('typed:', text.length, 'chars');
        break;
      }
      case 'key': {
        const key = rest[0];
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key });
        await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key });
        console.log('key:', key);
        break;
      }
      case 'wait': {
        const sel = rest[0];
        const timeoutMs = parseInt(rest[1] || '10000', 10);
        const deadline = Date.now() + timeoutMs;
        let found = false;
        while (Date.now() < deadline) {
          found = await cdp.eval(`!!document.querySelector(${JSON.stringify(sel)})`);
          if (found) break;
          await new Promise(r => setTimeout(r, 200));
        }
        if (!found) { console.error('timeout waiting for', sel); process.exit(3); }
        console.log('found:', sel);
        break;
      }
      case 'snapshot': {
        const text = await cdp.eval(`(document.body.innerText || '').slice(0, 4000)`);
        console.log(text);
        break;
      }
      case 'screenshot': {
        // CDP-native screenshot — bypasses gdigrab/window/foreground/DPI issues entirely.
        const out = rest[0] || `C:\\temp\\hub-rec\\cdp-${Date.now()}.png`;
        await cdp.send('Page.enable');
        const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
        const { writeFileSync } = await import('node:fs');
        writeFileSync(out, Buffer.from(r.data, 'base64'));
        console.log('saved:', out);
        break;
      }
      case 'mouseclick': {
        // Real CDP mouse event at coordinates — for cases where dispatchEvent doesn't reach handlers
        const x = parseFloat(rest[0]);
        const y = parseFloat(rest[1]);
        for (const type of ['mousePressed', 'mouseReleased']) {
          await cdp.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
        }
        console.log('mouseclick:', x, y);
        break;
      }
      case 'sendtext': {
        // Native CDP text insertion at active focus (works for xterm via Input.insertText)
        const text = rest.join(' ');
        await cdp.send('Input.insertText', { text });
        console.log('sendtext:', text.length, 'chars');
        break;
      }
      default:
        console.error('Usage: node hub-cdp.mjs <targets|eval|click|type|sendtext|key|wait|snapshot|mouseclick>');
        process.exit(1);
    }
  } finally {
    cdp.close();
  }
}

main().catch(e => {
  console.error(e.stack || e.message);
  process.exit(1);
});
