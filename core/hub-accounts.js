'use strict';
// Everything the account page shows, from two sources only: the Hub Chrome's cookie store
// (web logins) and the CLIs' own token files. Two actions: 登录 and 检查登录.
const fs = require('fs');
const path = require('path');
const { HubChrome, SITES } = require('./hub-chrome');
const { cliAuthStatus } = require('./cli-auth');

// Website tasks that wait for a login are resumed once the check proves it. Roundtable
// providers are named after the site, except Gemini, whose login is the Google one.
const ROUNDTABLE_PROVIDER = { chatgpt: 'chatgpt', google: 'gemini', deepseek: 'deepseek', doubao: 'doubao', kimi: 'kimi', qwen: 'qwen' };

class HubAccounts {
  constructor({ hubChrome, getConfig = () => require('./hub-config').getConfig(), env = process.env, recovery, now = Date.now } = {}) {
    this.chrome = hubChrome || new HubChrome({ env });
    this.getConfig = getConfig;
    this.env = env;
    this.now = now;
    this.recovery = recovery;
    this.checking = null;
  }
  cacheFile() { return path.join(this.chrome.root, 'last-check.json'); }
  readCache() {
    try { return JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')); } catch { return { identities: {} }; }
  }
  writeCache(cache) {
    fs.mkdirSync(this.chrome.root, { recursive: true });
    const file = this.cacheFile(), tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, file);
  }
  // Opening the page costs nothing: cookies from disk (or from the running browser), plus
  // whatever the last explicit check learned about sites that need a live page.
  async state() { return this.compose(false); }
  // 检查登录: the same, plus a live look at localStorage sites and each identity's ChatGPT
  // account — only when the browser is already running. It never starts Chrome.
  async check() {
    if (!this.checking) this.checking = this.compose(true).finally(() => { this.checking = null; });
    return this.checking;
  }
  // Isolated test Hubs may script the web half of a check (which sites a browser would show
  // as logged in). Honoured only with an isolated home, exactly like the old account fixture.
  fixture() {
    const file = this.env.CLAUDE_HUB_HOME_DIR && this.env.HUB_ACCOUNTS_FIXTURE;
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return {}; }
  }
  async compose(live) {
    const cache = this.readCache();
    const fixture = this.fixture();
    const running = fixture ? !!fixture.running : await this.chrome.running();
    const identities = [];
    for (const identity of this.chrome.identities) {
      let status;
      try {
        status = fixture
          ? { account: fixture[identity.id]?.account || '', sites: Object.fromEntries(identity.sites.map(k => [k, fixture[identity.id]?.sites?.[k] || { state: 'signed_out' }])) }
          : await this.chrome.loginStatus(identity.id, { live });
      }
      catch (e) { status = { sites: Object.fromEntries(identity.sites.map(k => [k, { state: 'unknown', error: e.message }])) }; }
      const prev = cache.identities[identity.id] || {};
      const sites = identity.sites.map(key => {
        let s = status.sites[key];
        // A live-only site keeps its last live answer until a new check replaces it.
        if (s.state === 'needs_browser' && prev.sites?.[key]?.checkedAt) s = { ...prev.sites[key], stale: true };
        if (s.live || s.state === 'signed_in' || s.state === 'signed_out') s = { ...s, checkedAt: s.checkedAt || this.now() };
        return { key, name: SITES[key].name, url: SITES[key].url, ...s };
      });
      const account = status.account || prev.account || '';
      identities.push({ id: identity.id, label: identity.label, account, sites });
      cache.identities[identity.id] = { account, sites: Object.fromEntries(sites.map(s => [s.key, s])) };
    }
    if (live) this.writeCache(cache);
    const clis = cliAuthStatus({ env: this.env, config: this.getConfig(), now: this.now() }).map(cli => ({ ...cli, identity: this.owner(cli, identities) }));
    if (live) await this.resumeWaiting(identities);
    const loginOpen = !running && !fixture && this.chrome.profileHeld();
    return { chrome: { running, loginOpen, root: this.chrome.root }, identities, clis, checkedAt: live ? this.now() : cache.checkedAt || 0 };
  }
  // A CLI belongs under the identity that holds the web login it is authorised from. Codex is
  // matched by account because the same site (ChatGPT) is signed in twice.
  owner(cli, identities) {
    if (cli.kind === 'codex') return identities.find(i => i.account && cli.account && i.account.toLowerCase() === cli.account.toLowerCase())?.id || '';
    const holding = identities.filter(i => i.sites.some(s => s.key === cli.site));
    return (holding.find(i => i.sites.find(s => s.key === cli.site)?.state === 'signed_in') || holding[0])?.id || '';
  }
  // Roundtable tasks run in the main identity, so only its logins can release them.
  async resumeWaiting(identities) {
    if (!this.recovery) return;
    for (const identity of identities.filter(i => i.id === this.chrome.identities[0].id)) {
      for (const site of identity.sites) {
        const provider = ROUNDTABLE_PROVIDER[site.key];
        if (!provider || site.state !== 'signed_in') continue;
        try { await this.recovery.resume({ managedBrowser: true, provider }); } catch { /* shown on the task itself */ }
      }
    }
  }
  // 登录: a window in the identity, one tab per site. With no site given, open the sites
  // that are not signed in (all of them if every one already is).
  async login({ identity = 'main', site } = {}) {
    const id = this.chrome.identity(identity);
    let sites = site ? [site] : undefined;
    if (!sites) {
      const st = await this.chrome.loginStatus(id.id, { live: false }).catch(() => null);
      const missing = st ? id.sites.filter(k => st.sites[k]?.state !== 'signed_in') : [];
      sites = missing.length ? missing : id.sites;
    }
    await this.chrome.openLogin(id.id, sites);
    return { identity: id.id, sites };
  }
}

module.exports = { HubAccounts, ROUNDTABLE_PROVIDER };
