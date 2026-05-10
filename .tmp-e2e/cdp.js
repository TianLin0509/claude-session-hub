'use strict';
// Minimal CDP driver over the project's `ws` package. No playwright/puppeteer needed.
// Usage: node cdp.js <command> [args...]
// Commands:
//   ping
//   eval "<JS expression>"        -> Runtime.evaluate, prints awaited value as JSON
//   shot <abs-path>               -> Page.captureScreenshot (full viewport) saved to file
//   click <selector>              -> dispatch synthetic click via JS
//   type  <selector> <text>       -> set input value + dispatch input event
//   waitfor <selector> <ms>       -> poll until selector exists, timeout in ms
//   waittext <substr> <ms>        -> poll until document.body.innerText contains substr
//   scroll <selector> <top>       -> set scrollTop on first matching element
//   getscroll <selector>          -> read scrollTop of first matching element
//
// Page target is the renderer index.html.

const path = require('path');
const fs   = require('fs');
const http = require('http');
const WS   = require('ws');

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9245;

function httpGet(p) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: CDP_HOST, port: CDP_PORT, path: p, method: 'GET' }, (res) => {
      let buf = '';
      res.setEncoding('utf8');
      res.on('data', (c) => buf += c);
      res.on('end', () => resolve(buf));
    });
    req.on('error', reject);
    req.end();
  });
}

async function pickPageTarget() {
  const json = JSON.parse(await httpGet('/json'));
  const page = json.find(t => t.type === 'page' && /renderer\/index\.html/.test(t.url || ''));
  if (!page) throw new Error('no renderer index.html page found in CDP /json');
  return page;
}

class CDPSession {
  constructor(ws) {
    this.ws = ws;
    this.next = 1;
    this.pending = new Map();
    this.events = [];
    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      if (msg.id != null) {
        const p = this.pending.get(msg.id);
        if (p) {
          this.pending.delete(msg.id);
          if (msg.error) p.reject(new Error(`CDP ${p.method} failed: ${JSON.stringify(msg.error)}`));
          else p.resolve(msg.result);
        }
      } else if (msg.method) {
        this.events.push(msg);
      }
    });
  }
  send(method, params = {}) {
    const id = this.next++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}

async function open() {
  const target = await pickPageTarget();
  const ws = new WS(target.webSocketDebuggerUrl, { perMessageDeflate: false });
  await new Promise((res, rej) => {
    ws.once('open', res);
    ws.once('error', rej);
  });
  const sess = new CDPSession(ws);
  await sess.send('Runtime.enable');
  await sess.send('Page.enable');
  return sess;
}

async function evalJS(sess, expr, awaitPromise = true, returnByValue = true) {
  const r = await sess.send('Runtime.evaluate', {
    expression: expr,
    awaitPromise,
    returnByValue,
    userGesture: true,
  });
  if (r.exceptionDetails) {
    const ex = r.exceptionDetails;
    throw new Error(`Eval threw: ${ex.text || ''} ${ex.exception ? JSON.stringify(ex.exception.description || ex.exception.value) : ''}`);
  }
  return r.result ? r.result.value : undefined;
}

async function cmdPing() {
  const sess = await open();
  const v = await evalJS(sess, 'navigator.userAgent');
  console.log('userAgent:', v);
  console.log('title:', await evalJS(sess, 'document.title'));
  console.log('readyState:', await evalJS(sess, 'document.readyState'));
  sess.close();
}

async function cmdEval(expr) {
  const sess = await open();
  const v = await evalJS(sess, `(async () => { return (${expr}); })()`, true, true);
  process.stdout.write(JSON.stringify(v, null, 2) + '\n');
  sess.close();
}

async function cmdShot(absPath) {
  const sess = await open();
  // capture the viewport (no fullPage so it matches what the user would see)
  const r = await sess.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, Buffer.from(r.data, 'base64'));
  console.log('SAVED:', absPath);
  sess.close();
}

async function cmdClick(selector) {
  const sess = await open();
  const ok = await evalJS(sess, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    const rect = el.getBoundingClientRect();
    el.scrollIntoView({ block: 'center' });
    el.click();
    return { ok: true, rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height } };
  })()`);
  console.log(JSON.stringify(ok));
  sess.close();
}

async function cmdType(selector, text) {
  const sess = await open();
  const r = await evalJS(sess, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    el.focus();
    el.value = ${JSON.stringify(text)};
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, value: el.value };
  })()`);
  console.log(JSON.stringify(r));
  sess.close();
}

async function cmdWaitFor(selector, msStr) {
  const ms = parseInt(msStr, 10) || 5000;
  const sess = await open();
  const start = Date.now();
  let found = false;
  while (Date.now() - start < ms) {
    found = await evalJS(sess, `!!document.querySelector(${JSON.stringify(selector)})`);
    if (found) break;
    await new Promise(r => setTimeout(r, 200));
  }
  console.log(JSON.stringify({ selector, found, elapsed: Date.now() - start }));
  sess.close();
  if (!found) process.exit(1);
}

async function cmdWaitText(substr, msStr) {
  const ms = parseInt(msStr, 10) || 5000;
  const sess = await open();
  const start = Date.now();
  let found = false;
  while (Date.now() - start < ms) {
    found = await evalJS(sess, `(document.body && document.body.innerText || '').includes(${JSON.stringify(substr)})`);
    if (found) break;
    await new Promise(r => setTimeout(r, 250));
  }
  console.log(JSON.stringify({ substr, found, elapsed: Date.now() - start }));
  sess.close();
  if (!found) process.exit(1);
}

async function cmdScroll(selector, topStr) {
  const top = parseInt(topStr, 10) || 0;
  const sess = await open();
  const r = await evalJS(sess, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    el.scrollTop = ${top};
    return { ok: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  })()`);
  console.log(JSON.stringify(r));
  sess.close();
}

async function cmdGetScroll(selector) {
  const sess = await open();
  const r = await evalJS(sess, `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { ok: false, reason: 'not-found' };
    return { ok: true, scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight };
  })()`);
  console.log(JSON.stringify(r));
  sess.close();
}

async function main() {
  const [, , cmd, ...args] = process.argv;
  switch ((cmd || '').toLowerCase()) {
    case 'ping':       return cmdPing();
    case 'eval':       return cmdEval(args.join(' '));
    case 'shot':       return cmdShot(args[0]);
    case 'click':      return cmdClick(args[0]);
    case 'type':       return cmdType(args[0], args.slice(1).join(' '));
    case 'waitfor':    return cmdWaitFor(args[0], args[1]);
    case 'waittext':   return cmdWaitText(args[0], args[1]);
    case 'scroll':     return cmdScroll(args[0], args[1]);
    case 'getscroll':  return cmdGetScroll(args[0]);
    default:
      console.error('Unknown command:', cmd);
      process.exit(2);
  }
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
