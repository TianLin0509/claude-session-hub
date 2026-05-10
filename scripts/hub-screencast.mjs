#!/usr/bin/env node
// CDP-based screen recording — captures Hub's rendered page directly via
// Page.startScreencast, totally bypassing window foreground / DPI / gdigrab issues.
//
// Usage:
//   node hub-screencast.mjs --duration 20 --fps 10 --out C:\temp\hub-rec\foo.gif [--width 1100]
//   --trigger-file <path>    optional JS file run via Runtime.evaluate at --trigger-after ms
//   --trigger-after 1500     ms after recording starts to fire the trigger

import http from 'node:http';
import path from 'node:path';
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\//, ''));
const wsPath = path.resolve(__dirname, '..', 'node_modules', 'ws');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const WebSocket = require(wsPath);

const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const k = process.argv[i];
  if (k.startsWith('--')) args[k.slice(2)] = process.argv[++i];
}

const HOST = process.env.HUB_CDP_HOST || '127.0.0.1';
const PORT = parseInt(process.env.HUB_CDP_PORT || '9221', 10);
const DURATION = parseFloat(args.duration || '15');
const FPS = parseInt(args.fps || '10', 10);
const OUT = args.out || `C:\\temp\\hub-rec\\screencast-${Date.now()}.gif`;
const WIDTH = parseInt(args.width || '1100', 10);
const FFMPEG = process.env.FFMPEG_PATH || (() => {
  const { glob } = { glob: null };
  // resolve from winget install
  const fs = require('node:fs');
  const base = `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages`;
  const pkgs = fs.readdirSync(base).filter(d => d.startsWith('Gyan.FFmpeg_'));
  for (const p of pkgs) {
    const builds = fs.readdirSync(path.join(base, p)).filter(d => d.startsWith('ffmpeg-'));
    for (const b of builds) {
      const exe = path.join(base, p, b, 'bin', 'ffmpeg.exe');
      if (fs.existsSync(exe)) return exe;
    }
  }
  throw new Error('ffmpeg not found');
})();

function fetchJson(p) {
  return new Promise((res, rej) => {
    http.get(`http://${HOST}:${PORT}${p}`, r => {
      let s = '';
      r.on('data', c => (s += c));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}

async function findHubMain() {
  const targets = await fetchJson('/json');
  return targets.find(t => t.type === 'page' && /index\.html/i.test(t.url || ''));
}

class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.ready = new Promise(r => this.ws.once('open', r));
    this.ws.on('message', buf => {
      const m = JSON.parse(buf.toString());
      if (m.id != null && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(JSON.stringify(m.error)));
        else resolve(m.result);
      } else if (m.method && this.eventHandlers.has(m.method)) {
        this.eventHandlers.get(m.method)(m.params);
      }
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(method, fn) { this.eventHandlers.set(method, fn); }
}

async function main() {
  const target = await findHubMain();
  if (!target) throw new Error('Hub main page not found at CDP');
  const cdp = new CDP(target.webSocketDebuggerUrl);
  await cdp.ready;
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');

  const frameDir = `C:\\temp\\hub-rec\\frames-${Date.now()}`;
  mkdirSync(frameDir, { recursive: true });
  let frameCount = 0;
  const startMs = Date.now();

  cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
    const t = Date.now() - startMs;
    if (t > DURATION * 1000) return; // ignore trailing frames
    const fname = path.join(frameDir, `f-${String(frameCount++).padStart(5, '0')}.png`);
    writeFileSync(fname, Buffer.from(data, 'base64'));
    await cdp.send('Page.screencastFrameAck', { sessionId });
  });

  // everyNthFrame: 60fps screen / target fps. e.g. fps=10 -> everyNth=6
  const everyNthFrame = Math.max(1, Math.round(60 / FPS));
  console.log(`[screencast] fps=${FPS}, everyNthFrame=${everyNthFrame}, duration=${DURATION}s, out=${OUT}`);

  // POLL MODE: loop captureScreenshot — captures full page-physical pixels (full 3800px wide),
  // unlike ffmpeg gdigrab which only sees window-outer logical pixels (cuts off third card on hi-DPI).
  const interval = 1000 / FPS;
  let triggerFired = false;
  const triggerAfterMs = parseInt(args['trigger-after'] || '1500', 10);

  while (Date.now() - startMs < DURATION * 1000) {
    const tickStart = Date.now();
    const elapsed = tickStart - startMs;

    // Fire trigger when its time arrives (only once)
    if (!triggerFired && args['trigger-file'] && elapsed >= triggerAfterMs) {
      triggerFired = true;
      const code = readFileSync(args['trigger-file'], 'utf8').replace(/^﻿/, '');
      console.log(`[screencast] firing trigger at t=${elapsed}ms`);
      cdp.send('Runtime.evaluate', {
        expression: `(async () => { return (${code}); })()`,
        returnByValue: true,
        awaitPromise: true,
      }).catch(e => console.error('trigger failed:', e.message));
    }

    try {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
      const fname = path.join(frameDir, `f-${String(frameCount++).padStart(5, '0')}.png`);
      writeFileSync(fname, Buffer.from(r.data, 'base64'));
    } catch (e) {
      console.error('capture frame failed:', e.message);
    }

    const used = Date.now() - tickStart;
    if (used < interval) await new Promise(r => setTimeout(r, interval - used));
  }
  cdp.ws.close();

  console.log(`[screencast] captured ${frameCount} frames in ${Date.now() - startMs}ms`);

  if (frameCount < 3) throw new Error('Too few frames captured');

  // ffmpeg: PNG sequence -> GIF (palette method)
  const inputPattern = path.join(frameDir, 'f-%05d.png');
  const tmpMp4 = OUT.replace(/\.gif$/i, '.mp4');
  console.log('[screencast] encoding mp4 -> gif...');
  const r1 = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'warning',
    '-framerate', String(FPS),
    '-i', inputPattern,
    '-vf', `scale=${WIDTH}:-2:flags=lanczos`,
    '-pix_fmt', 'yuv420p',
    tmpMp4,
  ], { stdio: 'inherit' });
  if (r1.status !== 0) throw new Error('ffmpeg mp4 failed');

  const r2 = spawnSync(FFMPEG, [
    '-y', '-loglevel', 'warning',
    '-i', tmpMp4,
    '-vf', `fps=${FPS},scale=${WIDTH}:-2:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5`,
    OUT,
  ], { stdio: 'inherit' });
  if (r2.status !== 0) throw new Error('ffmpeg gif failed');

  rmSync(frameDir, { recursive: true, force: true });
  if (!process.env.KEEP_MP4) rmSync(tmpMp4, { force: true });

  const { statSync } = await import('node:fs');
  const kb = (statSync(OUT).size / 1024).toFixed(1);
  console.log(`[screencast] DONE -> ${OUT} (${kb} KB)`);
}

main().catch(e => { console.error(e.stack || e.message); process.exit(1); });
