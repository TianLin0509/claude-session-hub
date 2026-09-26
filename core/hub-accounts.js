'use strict';
// Website observations and CLI credential metadata remain separate. Reading the page is
// passive; explicit checks may briefly open one shared Chrome, never the image worker pool.
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
    try { const value = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8')); return value && value.identities && typeof value.identities === 'object' ? value : { identities: {} }; } catch { return { identities: {} }; }
  }
  writeCache(cache) {
    fs.mkdirSync(this.chrome.root, { recursive: true });
    const file = this.cacheFile(), tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
    fs.renameSync(tmp, file);
  }
  // Opening the page costs nothing: cookies from disk (or from the running browser), plus
  // whatever the last explicit check learned about sites that need a live page.
  async state() {
    if (this.checking) return this.checking;
    if (!this.reading) this.reading = this.compose(false).finally(() => { this.reading = null; });
    return this.reading;
  }
  // A user-requested check can inspect live-only sites even after the login window closes.
  // Its temporary browser is released only if no other task has opened a business page.
  async check() {
    if (!this.checking) this.checking = (async () => {
      const fixture = this.fixture();
      const started = !fixture && !(await this.chrome.running()) && !this.chrome.profileHeld();
      try {
        if (started) await this.chrome.lifecycle(() => this.chrome.ensure());
        return await this.compose(true);
      } finally {
        if (started) await this.chrome.closeIfIdle();
      }
    })().finally(() => { this.checking = null; });
    return this.checking;
  }
  // Isolated test Hubs may script the web half of a check (which sites a browser would show
  // as logged in). Honoured only with an isolated home, exactly like the old account fixture.
  fixture() {
    const file = this.env.CLAUDE_HUB_HOME_DIR && this.env.HUB_ACCOUNTS_FIXTURE;
    if (!file) return null;
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return e.code === 'ENOENT' ? null : {}; }
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
        if (['needs_browser', 'cookie_present'].includes(s.state) && prev.sites?.[key]?.checkedAt && prev.sites[key].verified) {
          s = { ...prev.sites[key], expiresAt: s.expiresAt, stale: true, live: false };
        }
        if (s.live) s = { ...s, checkedAt: this.now(), stale: false, verified: true };
        return { key, name: SITES[key].name, url: SITES[key].url, ...s };
      });
      const chatgpt = sites.find(s => s.key === 'chatgpt');
      const account = chatgpt?.state === 'signed_out' ? '' : status.account || prev.account || '';
      identities.push({ id: identity.id, label: identity.label, account, accountStale: !status.account && !!account, sites });
      cache.identities[identity.id] = { account, sites: Object.fromEntries(sites.map(s => [s.key, s])) };
    }
    if (live) { cache.checkedAt = this.now(); this.writeCache(cache); }
    const clis = cliAuthStatus({ env: this.env, config: this.getConfig(), now: this.now() }).map(cli => ({ ...cli, identity: this.owner(cli, identities) }));
    if (live) await this.resumeWaiting(identities);
    const loginOpen = !running && !fixture && this.chrome.profileHeld();
    const tools = require('./hub-browser-tool').integrationStatus(this.chrome.root);
    return { chrome: { running, loginOpen, root: this.chrome.root }, identities, clis, tools, checkedAt: live ? this.now() : cache.checkedAt || 0 };
  }
  // Match a unique full email; a provider name or a single available identity is not proof.
  owner(cli, identities) {
    if (!cli.account) return '';
    const matches = identities.filter(i => i.account && i.account.toLowerCase() === cli.account.toLowerCase());
    return matches.length === 1 ? matches[0].id : '';
  }
  // Roundtable tasks run in the main identity, so only its logins can release them.
  async resumeWaiting(identities) {
    if (!this.recovery) return;
    for (const identity of identities.filter(i => i.id === this.chrome.identities[0].id)) {
      for (const site of identity.sites) {
        const provider = ROUNDTABLE_PROVIDER[site.key];
        if (!provider || site.state !== 'signed_in' || !site.live || site.stale) continue;
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
      const missing = st ? id.sites.filter(k => !['signed_in', 'cookie_present'].includes(st.sites[k]?.state)) : [];
      sites = missing.length ? missing : id.sites;
    }
    await this.chrome.openLogin(id.id, sites);
    return { identity: id.id, sites };
  }
}

module.exports = { HubAccounts, ROUNDTABLE_PROVIDER };
