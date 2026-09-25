'use strict';
// The Hub's one Chrome. It is the only place any web login lives: one profile per account
// identity (a person's login, e.g. 主 / 副), holding every site that person uses. Web tools
// open tabs in it instead of starting browsers of their own, and "检查登录" reads its cookie
// store — no page load, no extra process.
//
// Measured on this machine (2026-09-25): 4 ChatGPT pages as 4 Chromes = 2,749 MB / 40
// processes; as 4 tabs of one Chrome = 1,199 MB / 14 processes. One process with one
// debugging port serves several profiles, and their cookies stay fully separate.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// `cookie`: the cookie that carries the login; readable offline because Chrome does not
// encrypt cookie names or expiry. Sites without one keep their login in localStorage, which
// Chrome compresses on disk, so they can only be confirmed with the browser running.
const SITES = {
  chatgpt: { name: 'ChatGPT', url: 'https://chatgpt.com/', cookie: { host: 'chatgpt.com', name: /^__Secure-next-auth\.session-token(\.\d+)?$/ } },
  google: { name: 'Google', url: 'https://gemini.google.com/app', cookie: { host: 'google.com', name: /^__Secure-1PSID$/ } },
  claude: { name: 'Claude', url: 'https://claude.ai/', cookie: { host: 'claude.ai', name: /^sessionKey$/ } },
  doubao: { name: '豆包', url: 'https://www.doubao.com/chat/', cookie: { host: 'doubao.com', name: /^sessionid$/ } },
  deepseek: { name: 'DeepSeek', url: 'https://chat.deepseek.com/' },
  kimi: { name: 'Kimi', url: 'https://www.kimi.com/' },
  qwen: { name: '千问', url: 'https://www.qianwen.com/' },
};
const ALL_SITES = Object.keys(SITES);
// A cookie jar holds one login per site, so a second account on the same site needs a
// second identity. Everything else belongs in the main one.
const DEFAULT_IDENTITIES = [
  { id: 'main', label: '主', sites: ALL_SITES },
  { id: 'alt', label: '副', sites: ['chatgpt'] },
];
const OFFSCREEN = { left: -32000, top: -32000, width: 1280, height: 900 };
const ONSCREEN = { left: 120, top: 80, width: 1280, height: 900 };

function defaultRoot(env = process.env) {
  if (env.HUB_CHROME_ROOT) return path.resolve(env.HUB_CHROME_ROOT);
  // An isolated Hub must never drive the production Chrome or its logins.
  if (env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR) {
    return path.join(path.resolve(env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR), 'hub-chrome');
  }
  return 'C:\\VibeData\\HubChrome';
}
function chromeExecutable(env = process.env) {
  const candidates = [
    path.join(env.PROGRAMFILES || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google/Chrome/Application/chrome.exe'),
    path.join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ];
  const found = candidates.find(p => fs.existsSync(p));
  if (!found) throw new Error('未找到 Chrome 或 Edge 浏览器');
  return found;
}
// Chrome stores expiry as microseconds since 1601-01-01 (0 = "until the browser closes").
// That overflows a JS number, so the query divides by 1000 first; this takes milliseconds.
function chromeTimeToMs(msSince1601) {
  const n = Number(msSince1601);
  return n ? n - 11644473600000 : 0;
}
function hostMatches(hostKey, host) {
  const h = String(hostKey || '').replace(/^\./, '');
  return h === host || h.endsWith('.' + host);
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

class HubChrome {
  constructor({ root, env = process.env, spawnImpl = spawn, identities = DEFAULT_IDENTITIES, executable, now = Date.now } = {}) {
    this.root = root || defaultRoot(env);
    this.env = env;
    this.spawn = spawnImpl;
    this.identities = identities;
    this.executable = executable || (() => chromeExecutable(env));
    this.now = now;
    this.starting = null;
    this.contexts = new Map();
  }
  identity(id) {
    const found = this.identities.find(i => i.id === id);
    if (!found) throw new Error('未知的账号身份：' + id);
    return found;
  }
  site(key) {
    if (!SITES[key]) throw new Error('未知的网站：' + key);
    return SITES[key];
  }

  // ---- offline: answer "is this identity logged in to that site" from disk alone ----
  cookieRows(identity) {
    const db = path.join(this.root, identity.id, 'Network', 'Cookies');
    if (!fs.existsSync(db)) return null;
    // Chrome may hold the file open; read a private copy so a running browser is never touched.
    const copy = path.join(os.tmpdir(), `hub-chrome-cookies-${process.pid}-${crypto.randomUUID()}.db`);
    try { fs.copyFileSync(db, copy); }
    catch (e) {
      // Only a running Chrome holds this file; with no debugging endpoint that is the
      // ordinary-mode window opened for a login.
      if (e.code === 'EBUSY' || e.code === 'EPERM') throw Object.assign(new Error('登录窗口开着'), { loginOpen: true });
      throw e;
    }
    try {
      const { DatabaseSync } = require('node:sqlite');
      const conn = new DatabaseSync(copy, { readOnly: true });
      try {
        return conn.prepare('SELECT host_key AS host, name, expires_utc / 1000 AS expires FROM cookies').all()
          .map(r => ({ host: r.host, name: r.name, expiresAt: chromeTimeToMs(r.expires) }));
      } finally { conn.close(); }
    } finally {
      try { fs.unlinkSync(copy); } catch { /* temp copy; leaving it behind only costs disk */ }
    }
  }
  // While Chrome runs it holds the cookie file exclusively, so ask the identity's own marker
  // page instead: Network.getCookies from a page returns that profile's cookies, httpOnly too.
  async liveCookieRows(identity) {
    const { cdp } = await this.browser();
    let page;
    try {
      const mark = await this.marker(identity.id, cdp);
      page = await this.page(mark.targetId);
      const urls = [...new Set(identity.sites.map(k => this.site(k)).map(s => s.cookie ? 'https://' + s.cookie.host : s.url))];
      const { cookies } = await page.call('Network.getCookies', { urls });
      return cookies.map(c => ({ host: c.domain, name: c.name, expiresAt: c.expires > 0 ? Math.round(c.expires * 1000) : 0 }));
    } finally { page?.close(); cdp.close(); }
  }
  // The one "检查登录". Reads the file when Chrome is closed (no process started at all) and
  // the live store when it is open; the answer has the same shape either way.
  // Sites without a login cookie get a quick look in a background tab, but only when Chrome
  // is already running — checking never starts the browser.
  async loginStatus(identityId, { live = true } = {}) {
    const identity = this.identity(identityId);
    const running = await this.running();
    const loginOpen = () => ({ identity: identity.id, running: false, loginOpen: true, sites: Object.fromEntries(identity.sites.map(k => [k, { state: 'login_open' }])) });
    // A Chrome holds the profile but offers no debugging port: that is the login window.
    // Its cookies cannot be read until the person closes it.
    if (!running && this.profileHeld()) return loginOpen();
    let rows;
    try { rows = running ? await this.liveCookieRows(identity) : this.cookieRows(identity); }
    catch (e) { if (e.loginOpen) return loginOpen(); throw e; }
    const status = { ...this.statusFromRows(identity, rows), running };
    if (running && live) {
      const pending = Object.entries(status.sites).filter(([, v]) => v.state === 'needs_browser').map(([k]) => k);
      const results = await Promise.all(pending.map(k => this.liveStatus(identityId, k).catch(() => ({ state: 'unknown' }))));
      pending.forEach((k, i) => { status.sites[k] = { ...results[i], live: true }; });
    }
    if (running && status.sites.chatgpt?.state === 'signed_in') {
      status.account = await this.chatgptAccount(identityId).catch(() => '');
    }
    return status;
  }
  // Which ChatGPT account this identity is signed in as, from the site's own session
  // endpoint. Only the email leaves the page; the session's token is never read here.
  async chatgptAccount(identityId) {
    const { targetId } = await this.openTab(identityId, 'https://chatgpt.com/');
    let page;
    try {
      page = await this.page(targetId);
      for (const end = Date.now() + 15000; Date.now() < end;) {
        const email = await page.evaluate(`(async()=>{if(location.hostname!=='chatgpt.com')return '';try{const r=await fetch('/api/auth/session',{credentials:'include'});if(!r.ok)return '';const j=await r.json();return (j&&j.user&&j.user.email)||'';}catch{return ''}})()`).catch(() => '');
        if (email) return String(email).slice(0, 120);
        await sleep(800);
      }
      return '';
    } finally { page?.close(); await this.closeTab(targetId); }
  }
  offlineStatus(identityId) {
    const identity = this.identity(identityId);
    return this.statusFromRows(identity, this.cookieRows(identity));
  }
  statusFromRows(identity, rows) {
    const now = this.now();
    const sites = {};
    for (const key of identity.sites) {
      const rule = this.site(key).cookie;
      if (!rule) { sites[key] = { state: 'needs_browser' }; continue; }
      const hits = (rows || []).filter(r => hostMatches(r.host, rule.host) && rule.name.test(r.name) && (!r.expiresAt || r.expiresAt > now));
      sites[key] = hits.length
        ? { state: 'signed_in', expiresAt: hits.some(r => !r.expiresAt) ? 0 : Math.max(...hits.map(r => r.expiresAt)) }
        : { state: 'signed_out' };
    }
    return { identity: identity.id, profileExists: rows !== null, sites };
  }

  // ---- the running browser ----
  async endpoint() {
    let lines;
    try { lines = fs.readFileSync(path.join(this.root, 'DevToolsActivePort'), 'utf8').trim().split('\n'); }
    catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    const port = Number(lines[0]);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return null;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      const info = await r.json();
      // The port file outlives the browser; only trust it if the socket path matches too.
      if (new URL(info.webSocketDebuggerUrl).pathname !== String(lines[1] || '').trim()) return null;
      return { port, ws: info.webSocketDebuggerUrl };
    } catch { return null; }
  }
  // Chrome drops about:/data: URLs given on its command line, so each identity's marker is
  // a small local page. It doubles as a note to anyone who finds the window.
  markerUrl(identityId) {
    const file = path.join(this.root, `identity-${identityId}.html`);
    return require('url').pathToFileURL(file).href;
  }
  writeMarker(identityId) {
    const identity = this.identity(identityId);
    fs.mkdirSync(this.root, { recursive: true });
    const file = path.join(this.root, `identity-${identityId}.html`);
    const html = `<!doctype html><meta charset="utf-8"><title>AI Hub 浏览器 · ${identity.label}</title>`
      + `<body style="font:15px system-ui;padding:40px;color:#333">这是 AI Hub 的浏览器（身份：${identity.label}）。`
      + `Hub 的网页工具都在这里工作，请不要关闭这个窗口。</body>`;
    if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== html) fs.writeFileSync(file, html, 'utf8');
  }
  launchArgs(identityId, { debug = true, visible = false, url, urls } = {}) {
    return [
      '--user-data-dir=' + this.root,
      '--profile-directory=' + identityId,
      ...(debug ? ['--remote-debugging-port=0'] : []),
      '--no-first-run', '--no-default-browser-check',
      ...(visible ? [] : ['--window-position=-32000,-32000', '--window-size=1280,900']),
      '--new-window', ...(urls && urls.length ? urls : [url || this.markerUrl(identityId)]),
    ];
  }
  launch(identityId, options) {
    this.writeMarker(identityId);
    return new Promise((resolve, reject) => {
      const child = this.spawn(this.executable(), this.launchArgs(identityId, options), { env: this.env, detached: true, stdio: 'ignore', windowsHide: false });
      child.once('error', reject);
      child.once('spawn', () => { child.unref(); resolve(); });
    });
  }
  // Chrome holds <profile>/lockfile exclusively for as long as it runs, so a failed open
  // answers "is a Chrome on this profile" without scanning processes (a scan also fails
  // whenever any unrelated chrome.exe hides its command line). Whether that Chrome is ours in
  // debugging mode or an ordinary login window is told by the debugging endpoint.
  profileHeld() {
    // Chrome lets others read the file but not write it; only a write open reveals the hold.
    try { fs.closeSync(fs.openSync(path.join(this.root, 'lockfile'), 'r+')); return false; }
    catch (e) {
      if (e.code === 'ENOENT') return false;
      if (e.code === 'EBUSY' || e.code === 'EPERM' || e.code === 'EACCES') return true;
      throw e;
    }
  }
  async owners() {
    if (!this.profileHeld()) return [];
    return [{ automated: !!(await this.endpoint()) }];
  }
  async ensure() {
    const existing = await this.endpoint();
    if (existing) return existing;
    if (!this.starting) {
      this.starting = (async () => {
        // A launch would be handed to that ordinary window and never expose a debugging port.
        if ((await this.owners()).some(o => !o.automated)) throw new Error('Hub 浏览器正开着登录窗口；关掉那个窗口后，网页工具就能继续用它');
        this.contexts.clear();
        await this.launch(this.identities[0].id);
        for (const end = Date.now() + 20000; Date.now() < end;) {
          const ep = await this.endpoint();
          if (ep) return ep;
          await sleep(250);
        }
        throw new Error('Hub 浏览器没有在 20 秒内就绪');
      })().finally(() => { this.starting = null; });
    }
    return this.starting;
  }
  async browser() {
    const ep = await this.ensure();
    const { CDP } = require('./web-roundtable/cdp');
    return { ep, cdp: await CDP.connect(ep.ws, ep.port) };
  }
  async running() { return !!(await this.endpoint()); }

  // Each profile appears to CDP as its own browser context, but Target.createTarget can
  // only place a tab in whichever profile Chrome currently treats as default (the one used
  // last) — naming any other profile fails, omitting it lands in the wrong identity. So a
  // tab is always opened *from inside* its identity: every identity keeps one marker page,
  // parked off screen, and new tabs are window.open()ed by that page.
  async marker(identityId, cdp) {
    this.identity(identityId);
    const find = async () => {
      const { targetInfos } = await cdp.call('Target.getTargets');
      return targetInfos.find(t => t.type === 'page' && t.url === this.markerUrl(identityId));
    };
    let target = await find();
    if (!target) {
      await this.launch(identityId);   // Chrome hands this to the running process
      for (const end = Date.now() + 15000; !target && Date.now() < end;) { await sleep(250); target = await find(); }
      if (!target) throw new Error(`没能在 Hub 浏览器里打开身份「${this.identity(identityId).label}」`);
      await this.place(cdp, target.targetId, OFFSCREEN).catch(() => {});
    }
    return target;
  }
  async context(identityId, cdp) { return (await this.marker(identityId, cdp)).browserContextId; }
  async place(cdp, targetId, bounds) {
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.call('Browser.setWindowBounds', { windowId, bounds });
  }
  async pagesIn(cdp, browserContextId) {
    const { targetInfos } = await cdp.call('Target.getTargets');
    return targetInfos.filter(t => t.type === 'page' && t.browserContextId === browserContextId);
  }
  async waitNewPage(cdp, browserContextId, before, url) {
    for (const end = Date.now() + 15000; Date.now() < end;) {
      const fresh = (await this.pagesIn(cdp, browserContextId)).filter(t => !before.has(t.targetId));
      const hit = fresh.find(t => t.url === url || t.url.startsWith(url)) || fresh[0];
      if (hit) return hit;
      await sleep(200);
    }
    throw new Error('Hub 浏览器没有打开新标签页');
  }
  // A tab in the given identity. `visible` is a login: a normal Chrome window on screen and in
  // front, opened by Chrome's own "open in this profile" path. Otherwise the tab gets a window
  // of its own parked off screen — its own window so it stays the active, unthrottled tab.
  async openTab(identityId, url, { visible = false } = {}) {
    const { ep, cdp } = await this.browser();
    try {
      const mark = await this.marker(identityId, cdp);
      const ctx = mark.browserContextId;
      const before = new Set((await this.pagesIn(cdp, ctx)).map(t => t.targetId));
      if (visible) {
        await this.launch(identityId, { visible: true, url });
      } else {
        const page = await this.page(mark.targetId);
        try {
          await page.call('Runtime.evaluate', { expression: `window.open(${JSON.stringify(url)},'_blank','popup=1,noopener');true`, userGesture: true, returnByValue: true });
        } finally { page.close(); }
      }
      const target = await this.waitNewPage(cdp, ctx, before, url);
      await this.place(cdp, target.targetId, visible ? ONSCREEN : OFFSCREEN).catch(() => {});
      if (visible) await cdp.call('Target.activateTarget', { targetId: target.targetId }).catch(() => {});
      return { targetId: target.targetId, port: ep.port, browserContextId: ctx };
    } finally { cdp.close(); }
  }
  async page(targetId) {
    const ep = await this.endpoint();
    if (!ep) throw new Error('Hub 浏览器未在运行');
    const tabs = await (await fetch(`http://127.0.0.1:${ep.port}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
    const tab = tabs.find(t => t.id === targetId);
    if (!tab) throw new Error('标签页已关闭');
    const { CDP } = require('./web-roundtable/cdp');
    return CDP.connect(tab.webSocketDebuggerUrl, ep.port);
  }
  async closeTab(targetId) {
    const ep = await this.endpoint();
    if (!ep) return;
    await fetch(`http://127.0.0.1:${ep.port}/json/close/${encodeURIComponent(targetId)}`, { signal: AbortSignal.timeout(3000) }).catch(() => {});
  }
  // 登录 always happens in an ordinary Chrome on the same profile. Google refuses to sign in
  // (and so does every site using "Continue with Google") while the browser runs with a
  // debugging port — observed 2026-09-25 in this Hub Chrome, as the Gemini flow found before.
  // Cookies live in the profile, so the next debugging-mode start sees the login.
  async openLogin(identityId, siteKeys) {
    const identity = this.identity(identityId);
    const keys = [].concat(siteKeys || identity.sites).filter(Boolean);
    for (const k of keys) if (!identity.sites.includes(k)) throw new Error(`身份「${identity.label}」不负责 ${this.site(k).name}`);
    const urls = keys.map(k => this.site(k).url);
    if ((await this.owners()).some(o => o.automated)) {
      const busy = await this.workTabs();
      if (busy > 0) throw new Error(`有 ${busy} 个网页任务正在用 Hub 浏览器，等它们结束再登录（Google 不允许在被程序控制的浏览器里登录）`);
      await this.close();
      for (let i = 0; i < 40 && (await this.owners()).length; i++) await sleep(250);
      if ((await this.owners()).length) throw new Error('Hub 浏览器没能及时退出，请稍后再点登录');
    }
    await this.launch(identityId, { debug: false, visible: true, urls });
    return { identity: identity.id, sites: keys, mode: 'ordinary' };
  }
  // Tools park their tabs off screen; a page on screen is a person's. Counting the former
  // tells whether closing the browser would cut a task short.
  async workTabs() {
    const ep = await this.endpoint();
    if (!ep) return 0;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    try {
      const markers = new Set(this.identities.map(i => this.markerUrl(i.id)));
      const pages = (await cdp.call('Target.getTargets')).targetInfos.filter(t => t.type === 'page' && !markers.has(t.url));
      let n = 0;
      for (const p of pages) {
        const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId: p.targetId });
        const { bounds } = await cdp.call('Browser.getWindowBounds', { windowId });
        if (bounds.left < -1000) n++;
      }
      return n;
    } finally { cdp.close(); }
  }
  // Sites that keep their login in localStorage can only be read from a live page.
  async liveStatus(identityId, siteKey, { timeoutMs = 15000 } = {}) {
    if (!(await this.running())) return { state: 'needs_browser' };
    const site = this.site(siteKey);
    const { PROBE } = require('./account-browser');
    const { targetId } = await this.openTab(identityId, site.url);
    let page;
    try {
      page = await this.page(targetId);
      const host = new URL(site.url).hostname;
      for (const end = Date.now() + timeoutMs; Date.now() < end;) {
        const r = await page.evaluate(PROBE).catch(() => null);
        if (r && r.host === host) {
          if (r.challenge) return { state: 'needs_attention', reason: 'challenge' };
          if (r.login) return { state: 'signed_out' };
          if (r.profile) return { state: 'signed_in' };
        }
        await sleep(400);
      }
      return { state: 'unknown' };
    } finally {
      page?.close();
      await this.closeTab(targetId);
    }
  }
  async close() {
    const ep = await this.endpoint();
    if (!ep) return;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    try { await cdp.call('Browser.close'); } catch { /* the socket drops as the browser exits */ } finally { cdp.close(); }
    this.contexts.clear();
  }
}

module.exports = { HubChrome, SITES, DEFAULT_IDENTITIES, defaultRoot, chromeExecutable, chromeTimeToMs, hostMatches };
