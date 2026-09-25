'use strict';
// Compatibility transport for the existing image queue and company bridge. Each lane
// keeps its own page; jobs, idempotency keys and bridge cursors remain in their tools.
const fs = require('fs');
const path = require('path');
const { HubChrome, defaultRoot } = require('./hub-chrome');

function argumentsOf(argv) {
  const args = [...argv];
  const session = args.indexOf('--session');
  if (session >= 0) args.splice(session, 2);
  const json = args.indexOf('--json');
  if (json >= 0) args.splice(json, 1);
  return args;
}
function validateBinding(binding, env = process.env) {
  if (!binding || !['images', 'bridge'].includes(binding.tool) || !['main', 'alt'].includes(binding.identity)
      || !/^[a-z0-9_-]{1,64}$/.test(binding.id) || !path.isAbsolute(binding.root) || !path.isAbsolute(binding.playwright)) {
    throw Error('Invalid Hub browser binding');
  }
  if ((env.CLAUDE_HUB_DATA_DIR || env.CLAUDE_HUB_HOME_DIR || env.HUB_CHROME_ROOT)
      && path.resolve(defaultRoot(env)).toLowerCase() !== path.resolve(binding.root).toLowerCase()) {
    throw Error('Isolated Hub cannot access another browser root');
  }
}
function save(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value), 'utf8');
  fs.renameSync(tmp, file);
}
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function integrationStatus(root) {
  const manifest = read(path.join(root, 'tool-bindings.json'));
  const tools = Array.isArray(manifest?.tools) ? manifest.tools : [];
  return ['images', 'bridge'].map(tool => {
    const entries = tools.filter(t => t && t.tool === tool);
    const connected = entries.filter(t => {
      if (typeof t.config !== 'string' || typeof t.entry !== 'string') return false;
      const config = read(t.config);
      return config?.cli_entry === t.entry && fs.existsSync(t.entry);
    });
    return { tool, name: tool === 'images' ? '网页生图' : '公司中转', state: connected.length && connected.length === entries.length ? 'connected' : entries.length ? 'changed' : 'pending',
      identities: ['main', 'alt'].map(identity => ({ identity, count: connected.filter(t => t.identity === identity).length })).filter(i => i.count) };
  });
}

class BrowserTool {
  constructor(binding, { env = process.env, hub, chromium } = {}) {
    validateBinding(binding, env);
    this.binding = binding;
    this.hub = hub || new HubChrome({ root: binding.root, env });
    this.chromium = chromium;
    this.file = path.join(binding.root, 'tool-pages', binding.id + '.json');
  }
  async target() {
    const record = read(this.file), ep = await this.hub.endpoint();
    if (!record || !ep || record.browserWs !== ep.ws || record.identity !== this.binding.identity) return null;
    const { CDP } = require('./web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    try {
      const { targetInfos } = await cdp.call('Target.getTargets');
      const marker = targetInfos.find(t => t.url === this.hub.markerUrl(this.binding.identity));
      const target = targetInfos.find(t => t.targetId === record.targetId && t.type === 'page');
      return marker && target && target.browserContextId === marker.browserContextId ? { ...record, ep } : null;
    } finally { cdp.close(); }
  }
  async open(url = 'about:blank') {
    const existing = await this.target();
    if (existing) return { targetId: existing.targetId, reused: true };
    const tab = await this.hub.openTab(this.binding.identity, url);
    const ep = await this.hub.endpoint();
    try { save(this.file, { targetId: tab.targetId, browserWs: ep.ws, identity: this.binding.identity }); }
    catch (e) { await this.hub.closeTab(tab.targetId); throw e; }
    return { targetId: tab.targetId, reused: false };
  }
  async withPage(fn) {
    const target = await this.target();
    if (!target) throw Error('No browser session: owned Hub page is not open');
    const chromium = this.chromium || require(this.binding.playwright).chromium;
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${target.ep.port}`);
    try {
      for (const context of browser.contexts()) for (const page of context.pages()) {
        const cdp = await context.newCDPSession(page);
        let info;
        try { info = await cdp.send('Target.getTargetInfo'); } finally { await cdp.detach(); }
        if (info.targetInfo.targetId === target.targetId) return await fn(page);
      }
      throw Error('No browser session: owned Hub page is not visible to the runtime');
    } finally {
      // For a CDP connection Playwright close disconnects its transport, not Chrome.
      await browser.close();
    }
  }
  async execute(argv) {
    const [command, ...args] = argumentsOf(argv);
    if (command === 'open') return this.open(args.find(a => !a.startsWith('--')) || 'about:blank');
    if (command === 'close') {
      const target = await this.target();
      if (target) await this.hub.closeTab(target.targetId);
      fs.rmSync(this.file, { force: true });
      if (target) await this.hub.closeIfIdle();
      return { closed: !!target };
    }
    // Never import another tool's cookies into a shared identity. Chrome owns its login.
    if (command === 'state-load') return { managedBy: 'hub-chrome', imported: false };
    if (command === 'state-save') {
      const file = path.resolve(args[0]);
      // Preserve old standalone snapshots. The bridge atomically saves through .new.
      if (!fs.existsSync(file)) {
        if (file.endsWith('.new') && fs.existsSync(file.slice(0, -4))) fs.copyFileSync(file.slice(0, -4), file);
        else save(file, { cookies: [], origins: [], managedBy: 'hub-chrome' });
      }
      return { managedBy: 'hub-chrome', exported: false };
    }
    if (command === 'goto') return this.withPage(async page => { await page.goto(args[0], { waitUntil: 'domcontentloaded' }); return { url: page.url() }; });
    if (command === 'run-code') {
      const at = args.indexOf('--filename');
      if (at < 0 || !args[at + 1]) throw Error('run-code requires a local filename');
      const source = require('./chatgpt-selector-compat').adaptSource(fs.readFileSync(args[at + 1], 'utf8'));
      // Trusted local tool code, identical authority to the original Playwright CLI.
      const fn = new Function('return (' + source + '\n)')();
      return this.withPage(fn);
    }
    throw Error('Unsupported Hub browser command: ' + command);
  }
}
async function main(binding, argv = process.argv.slice(2)) {
  try { const result = await new BrowserTool(binding).execute(argv); process.stdout.write(JSON.stringify({ result: result ?? null }) + '\n'); }
  catch (e) {
    // Native tools classify these categories; never print evaluated code or page contents.
    const category = /No browser session/.test(e.message) ? 'No browser session'
      : /IMAGE_TOOL_UNAVAILABLE/.test(e.message) ? 'IMAGE_TOOL_UNAVAILABLE'
      : /strict mode violation/.test(e.message) ? 'strict mode violation'
      : /Target.*closed/.test(e.message) ? 'Target closed'
      : /Timeout|timeout/.test(e.message) ? 'Timeout' : 'Hub browser operation failed';
    process.stdout.write(JSON.stringify({ isError: true, error: category }) + '\n'); process.exitCode = 1;
  }
}
module.exports = { BrowserTool, main, argumentsOf, validateBinding, save, read, integrationStatus };
