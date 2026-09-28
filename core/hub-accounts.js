'use strict';
const fs = require('fs'), path = require('path');
const { HubChrome, SITES } = require('./hub-chrome');
const { cliAuthStatus } = require('./cli-auth');
const { readPreferences, updatePreferences } = require('./hub-account-preferences');
const { inspectAccounts } = require('./hub-login-check');
const ROUNDTABLE_PROVIDER = { chatgpt: 'chatgpt', google: 'gemini', deepseek: 'deepseek', doubao: 'doubao', kimi: 'kimi', qwen: 'qwen' };

class HubAccounts {
  constructor({ hubChrome, getConfig = () => require('./hub-config').getConfig(), env = process.env, recovery, now = Date.now, inspect = inspectAccounts, getToolCatalog } = {}) {
    this.chrome = hubChrome || new HubChrome({ env });
    Object.assign(this, { getConfig, env, recovery, now, inspect, getToolCatalog });
    this.checking = null; this.progress = null; this.lastState = null;
    this.setup = new (require('./hub-browser-setup').HubBrowserSetup)({ root: this.chrome.root, env });
  }
  cacheFile() { return path.join(this.chrome.root, 'last-check.json'); }
  async toolAccounts(refresh = false) {
    if (!this.getToolCatalog) throw Error('工具目录服务未连接，请重新打开新版 Hub');
    const catalog = await this.getToolCatalog(refresh);
    return require('./tool-accounts').buildToolAccounts(catalog, { root: this.chrome.root,
      homeDir: this.env.CLAUDE_HUB_HOME_DIR || require('os').homedir(), env: this.env });
  }
  async external({ service, action }) {
    const external = require('./external-accounts');
    const research = external.RESEARCH_SITES.includes(service);
    if (!['github', 'yuque'].includes(service) && !research) throw Error('外部服务标识无效');
    external.externalSite(service);
    if (!['open', 'check', 'authorize'].includes(action)) throw Error('外部账号操作无效');
    if (this.checking || this.startingCheck || this.setup.flight) throw Error('请等待账号检查或工具接入完成');
    // 初心投研的投研站点：检查登录看专属 Chrome 里那一个登录 cookie
    if (research && action === 'check') {
      const status = await this.chrome.siteCookieStatus(service, 'main');
      external.writeExternalState(this.chrome.root, service, { ...status, checkedAt: this.now() });
      return { message: external.externalSite(service).name + '：' + status.message };
    }
    if (action !== 'open' && service !== 'github') throw Error('此服务请在专属 Chrome 中确认登录');
    const fixture = this.fixture();
    if (fixture?.recordOpens) {
      fs.appendFileSync(path.join(this.env.CLAUDE_HUB_HOME_DIR, 'external-open.jsonl'), JSON.stringify({ service, action, identity: 'main' }) + '\n');
      if (action === 'check') external.writeExternalState(this.chrome.root, service, { state: 'signed_in', account: 'fixture-github', source: 'fixture', checkedAt: this.now() });
    } else if (action === 'open') await this.chrome.openWebsite('main', service);
    else if (action === 'check') {
      const isolated = this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR;
      if (isolated) throw Error('隔离实例不会核对或修改真实 GitHub 授权');
      external.writeExternalState(this.chrome.root, service, await external.githubStatus(this.env));
    } else {
      if (this.env.CLAUDE_HUB_HOME_DIR || this.env.CLAUDE_HUB_DATA_DIR) throw Error('隔离实例不会启动真实 GitHub 授权');
      const browser = '"' + process.execPath + '" "' + path.resolve(__dirname, '../scripts/open-hub-github-auth.js') + '"';
      await require('./account-adapters').openTerminal(external.githubCommand(this.env), ['auth', 'login', '--hostname', 'github.com', '--web', '--git-protocol', 'https', '--skip-ssh-key'],
        { ...this.env, GH_BROWSER: browser, ELECTRON_RUN_AS_NODE: '1' });
    }
    let usageWarning = '';
    if (action === 'open') try { require('./hub-account-activity').recordActivity(this.chrome.root, { site: service, outcome: 'opened', at: this.now() }); }
    catch { usageWarning = '；使用记录未保存'; }
    return { message: (action === 'check' ? 'GitHub 授权检查已完成，结果显示在外部服务中' : action === 'authorize' ? '已打开 GitHub 官方授权窗口，请按提示完成授权后检查' : '已在专属 Chrome 打开 ' + external.externalSite(service).name) + usageWarning };
  }
  // 本机初心投研取投研站点的 cookie（经 Hub 本机接口、带令牌）。只允许 RESEARCH_SITES。
  async exportResearchCookies(service) {
    const external = require('./external-accounts');
    if (!external.RESEARCH_SITES.includes(service)) throw Error('这个网站的登录不允许导出');
    if (this.checking || this.startingCheck) throw Error('Hub 正在检查账号登录，稍后再同步');
    const cookies = await this.chrome.exportCookies(service, 'main');
    const site = external.externalSite(service);
    const signed = cookies.some(c => site.cookie.name.test(c.name) && c.value);
    external.writeExternalState(this.chrome.root, service, { state: signed ? 'signed_in' : 'signed_out',
      message: signed ? '专属 Chrome 里已登录' : '专属 Chrome 里还没登录', checkedAt: this.now() });
    return { site: service, signedIn: signed, cookies };
  }
  readCache() {
    try {
      const value = JSON.parse(fs.readFileSync(this.cacheFile(), 'utf8'));
      if (!value?.identities || typeof value.identities !== 'object') throw Error('invalid');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return { identities: {} }; throw Error('登录检查记录无法读取，请保留 last-check.json 并检查文件'); }
  }
  writeCache(cache) {
    fs.mkdirSync(this.chrome.root, { recursive: true });
    const file = this.cacheFile(), tmp = file + '.' + require('crypto').randomUUID() + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8'); fs.renameSync(tmp, file);
  }
  fixture() {
    const file = this.env.CLAUDE_HUB_HOME_DIR && this.env.HUB_ACCOUNTS_FIXTURE;
    if (!file) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  }
  async state() {
    if (this.checking && this.lastState) return this.publicState();
    if (this.lastState && this.progress?.finishedAt && this.now() - this.progress.finishedAt < 30000) return this.publicState();
    if (!this.reading) this.reading = this.compose().then(value => { this.lastState = value; return this.publicState(); }).finally(() => { this.reading = null; });
    return this.reading;
  }
  async passiveState() { return this.publicState(await this.compose({ passive: true })); }
  publicState(value = this.lastState) { return JSON.parse(JSON.stringify({ ...value,
    ...(this.setup.progress?.status === 'complete' ? { tools: require('./hub-browser-tool').integrationStatus(this.chrome.root) } : {}),
    activity: require('./hub-account-activity').readActivity(this.chrome.root, this.env),
    progress: this.progress, setupProgress: this.setup.progress })); }
  async compose({ passive = false } = {}) {
    const cache = this.readCache(), preferences = readPreferences(this.chrome.root);
    const running = passive ? null : await this.chrome.running(), identities = [];
    for (const identity of this.chrome.identities) {
      let status;
      try { status = passive ? { sites: {} } : await this.chrome.loginStatus(identity.id, { live: false }); }
      catch (e) { status = { sites: {}, error: e.message }; }
      const prev = cache.identities[identity.id] || {};
      const sites = identity.sites.filter(key => identity.id === 'main' || preferences.sites[key]?.secondary).map(key => {
        let observed = status.sites?.[key] || { state: 'unknown', error: status.error };
        const prior = prev.sites?.[key];
        if (prior?.checkedAt && observed.state !== 'signed_out') observed = { ...prior, stale: true, live: false };
        return { key, name: SITES[key].name, url: SITES[key].url, ...observed };
      });
      const chatgpt = sites.find(s => s.key === 'chatgpt');
      const account = chatgpt?.state === 'signed_out' ? '' : status.account || prev.account || '';
      identities.push({ id: identity.id, label: identity.label, account, accountStale: !status.account && !!account, sites });
    }
    const clis = cliAuthStatus({ env: this.env, config: this.getConfig(), now: this.now() }).map(cli => ({ ...cli, identity: this.owner(cli, identities) }));
    return { chrome: { running, loginOpen: passive ? null : !running && this.chrome.profileHeld(), root: this.chrome.root }, identities, clis, preferences,
      tools: require('./hub-browser-tool').integrationStatus(this.chrome.root), checkedAt: cache.checkedAt || 0 };
  }
  async startCheck({ identity, site } = {}) {
    if (this.setup.flight) throw Error('正在接入网页工具，请等待完成后检查');
    if (this.checking) return this.publicState();
    if (this.startingCheck) return this.startingCheck;
    this.startingCheck = (async () => {
      await this.state();
      const items = this.lastState.identities.flatMap(i => i.sites.map(s => ({ identity: i.id, site: s.key, state: 'queued' })))
        .filter(item => (!identity || item.identity === identity) && (!site || item.site === site));
      if (!items.length) throw Error('没有可检查的账号');
      this.abort = new AbortController();
      // Only observations produced by this run may release waiting website tasks.
      for (const row of this.lastState.identities) for (const observed of row.sites) {
        observed.live = false;
        if (observed.checkedAt) observed.stale = true;
      }
      this.progress = { id: require('crypto').randomUUID(), status: 'running', done: 0, total: items.length, startedAt: this.now(), current: null, stage: '准备检查', items };
      const progress = this.progress;
      this.checking = Promise.resolve().then(() => this.inspect({ chrome: this.chrome, items, signal: this.abort.signal, fixture: this.fixture(),
        onStage: (item, stage) => { progress.current = item ? { identity: item.identity, site: item.site } : null; progress.stage = stage; if (item) item.state = 'checking'; },
        onResult: async (item, result) => {
          const checked = { ...result, checkedAt: this.now() };
          const cache = this.readCache();
          const entry = cache.identities[item.identity] ||= { sites: {} };
          entry.sites ||= {}; entry.sites[item.site] = checked;
          if (item.site === 'chatgpt') {
            if (checked.state === 'signed_out') entry.account = '';
            else if (checked.account) entry.account = checked.account;
          }
          cache.checkedAt = this.now(); this.writeCache(cache);
          const row = this.lastState.identities.find(i => i.id === item.identity);
          const at = row.sites.findIndex(s => s.key === item.site);
          row.sites[at] = { key: item.site, name: SITES[item.site].name, url: SITES[item.site].url, ...checked };
          if (item.site === 'chatgpt') { row.account = entry.account || ''; row.accountStale = !!row.account && !checked.account; }
          item.state = checked.state; item.reason = checked.reason || ''; item.error = checked.error || ''; progress.done++;
          this.lastState.checkedAt = cache.checkedAt;
        },
      })).then(async () => {
        progress.status = this.abort.signal.aborted ? 'cancelled' : 'complete';
        progress.stage = progress.status === 'cancelled' ? '已取消，已完成的结果已保留' : '检查完成';
        await this.resumeWaiting(this.lastState.identities);
      }).catch(e => { progress.status = 'failed'; progress.error = e.message; progress.stage = '检查未完成'; })
        .finally(() => { progress.current = null; progress.finishedAt = this.now(); this.checking = null; });
      return this.publicState();
    })().finally(() => { this.startingCheck = null; });
    return this.startingCheck;
  }
  async check(options = {}) { await this.startCheck(options); await this.checking; return this.publicState(); }
  cancelCheck() { this.abort?.abort(); if (this.checking) this.progress.stage = '正在取消并释放检查资源'; return this.publicState(); }
  owner(cli, identities) {
    if (!cli.account || !cli.site) return '';
    const matches = identities.filter(i => {
      const site = i.sites.find(s => s.key === cli.site);
      const account = site?.state === 'signed_out' ? '' : site?.account || (cli.site === 'chatgpt' ? i.account : '');
      return account && account.toLowerCase() === cli.account.toLowerCase();
    });
    return matches.length === 1 ? matches[0].id : '';
  }
  async resumeWaiting(identities) {
    if (!this.recovery) return;
    for (const identity of identities.filter(i => i.id === 'main')) for (const site of identity.sites) {
      const provider = ROUNDTABLE_PROVIDER[site.key];
      if (!provider || site.state !== 'signed_in' || !site.live || site.stale) continue;
      try { await this.recovery.resume({ managedBrowser: true, provider }); }
      catch (e) { if (this.progress) (this.progress.warnings ||= []).push((site.name || site.key) + '：任务恢复失败，' + e.message); }
    }
  }
  async preference(options) {
    if (this.checking) throw Error('请等检查结束再调整账号');
    await this.chrome.lifecycle(() => updatePreferences(this.chrome.root, options));
    this.lastState = null;
    return this.passiveState();
  }
  async open({ identity, site, login = false }) {
    if (this.checking || this.startingCheck) throw Error('请等待检查结束或取消检查后打开网页');
    if (!SITES[site]) throw Error('请选择 AI 网页');
    const prefs = readPreferences(this.chrome.root).sites[site];
    identity ||= prefs.preferred;
    if (identity === 'alt' && !prefs.secondary) throw Error('请先添加第二个账号');
    this.chrome.identity(identity);
    const fixture = this.fixture();
    if (fixture?.recordOpens) {
      fs.appendFileSync(path.join(this.env.CLAUDE_HUB_HOME_DIR, 'accounts-open.jsonl'), JSON.stringify({ identity, site, url: SITES[site].url }) + '\n');
    } else if (login) await this.chrome.openLogin(identity, [site]);
    else await this.chrome.openWebsite(identity, site);
    this.lastState = null;
    let usageWarning = '';
    try { require('./hub-account-activity').recordActivity(this.chrome.root, { identity, site, outcome: 'opened', at: this.now() }); }
    catch { usageWarning = '；使用记录未保存'; }
    return { identity, site, message: '已在 AI Hub 专属 Chrome 打开 ' + SITES[site].name + usageWarning };
  }
  async login({ identity = 'main', site } = {}) {
    if (site) return this.open({ identity, site, login: true });
    await this.chrome.openLogin(identity, this.lastState?.identities.find(i => i.id === identity)?.sites.map(s => s.key));
    return { identity };
  }
}
module.exports = { HubAccounts, ROUNDTABLE_PROVIDER };
