'use strict';
const path = require('path');
const { HubChrome } = require('./hub-chrome');
const { acquire } = require('./web-roundtable/store');
const restrictedCheck = () => ({ state: 'needs_attention', reason: 'headless_challenge',
  error: '官网安全验证拦截了后台检查，不代表登录失效。可打开网页确认，无需因此重新登录。' });

// One site on one identity: the ChatGPT session endpoint names the account; other sites are
// read from the page itself. `browser` is the running Hub Chrome or the headless inspector.
async function checkSite(browser, item, signal) {
  if (item.site === 'chatgpt') {
    const account = await browser.chatgptAccount(item.identity, { signal });
    return account ? { state: 'signed_in', account } : browser.liveStatus(item.identity, item.site, { signal, timeoutMs: 6000 });
  }
  return browser.liveStatus(item.identity, item.site, { signal });
}
async function runItems(browser, items, signal, onStage, onResult, fixture) {
  for (const item of items) {
    if (signal.aborted) break;
    onStage(item, '正在确认官网账号');
    let result;
    try {
      if (fixture) {
        await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, fixture.delayMs || 0))));
        result = { ...(fixture[item.identity]?.sites?.[item.site] || { state: 'unknown' }) };
        if (item.site === 'chatgpt' && result.state === 'signed_in') result.account = fixture[item.identity]?.account || '';
      } else result = await checkSite(browser, item, signal);
    } catch (e) {
      if (signal.aborted) break;
      // A person took the browser over: stop here, nothing is concluded about the login.
      if (e.code === 'HUB_HUMAN_HANDOFF') break;
      result = ['HUB_LOGIN_CHECK_RESTRICTED', 'HUB_SITE_CHALLENGED'].includes(e.code) ? restrictedCheck() : { state: 'unknown', error: e.message };
    }
    if (result?.state === 'needs_attention' && result.reason === 'challenge') result = restrictedCheck();
    if (!signal.aborted) await onResult(item, { ...result, live: true, verified: ['signed_in', 'signed_out', 'needs_attention'].includes(result.state), checkedAt: Date.now(), stale: false });
  }
}

// Two ways to look, chosen by what the Hub Chrome is doing right now:
// - running with tools (debugging mode): one background tab at a time in that browser. Tools
//   and a person's windows carry on; nothing is closed.
// - not running: a headless Chrome owned exclusively for the check, one profile at a time.
//   Anyone who needs the browser meanwhile (a click on 打开, a tool) asks it to yield.
// A person's ordinary window holds the profile without a debugging port: nothing can be read.
async function inspectAccounts({ chrome, items, signal, onStage, onResult, fixture, createInspector = options => new HubChrome(options) }) {
  if (fixture) {
    if (fixture.shared) return runItems(null, items, signal, onStage, onResult, fixture);
  } else {
    const ep = await chrome.endpoint();
    if (ep && !ep.headless) return runItems(chrome, items, signal, onStage, onResult, null);
    if (!ep && chrome.profileHeld()) throw Error('专属 Chrome 的普通窗口开着，关掉后再确认登录；已有登录会保留。');
  }
  const release = await chrome.lifecycle(() => acquire('account-check', path.join(chrome.root, 'locks')));
  if (!release) throw Error('另一个 Hub 正在检查登录，请稍后再试');
  chrome.clearYield?.();
  // A yield request aborts the run like a cancel; completed results are kept.
  const local = new AbortController(), stop = () => local.abort();
  signal.addEventListener('abort', stop, { once: true });
  const poll = setInterval(() => { if (chrome.yieldRequested?.()) local.abort(); }, 300);
  let inspector, owned = false, ownedWs, shared = false;
  try {
    inspector = fixture ? null : createInspector({ root: chrome.root, env: chrome.env, executable: chrome.executable, identities: chrome.identities });
    if (inspector) inspector.inspectionOwner = true;
    if (!fixture) {
      const ep = await chrome.endpoint();
      // A tool started the browser while this check waited for the lease: look in there.
      if (ep && !ep.headless) shared = true;
      // Left behind by an earlier check that never finished: ours to close if it is empty.
      else if (ep?.headless && !(await chrome.workTabs())) await chrome.close();
      else if (ep || chrome.profileHeld()) throw Error('专属 Chrome 正在使用中。请关闭其中的网页窗口后重试；已有登录会保留。');
    }
    for (const identity of shared ? [] : [...new Set(items.map(item => item.identity))]) {
      if (local.signal.aborted) break;
      const group = items.filter(item => item.identity === identity);
      onStage(group[0], '正在启动无头检查');
      try {
        if (inspector) {
          owned = true;
          inspector.lastLaunchPid = null;
          ownedWs = (await inspector.ensure({ headless: true, identityId: identity })).ws;
        }
        await runItems(inspector, group, local.signal, onStage, onResult, fixture);
      } finally {
        if (owned) {
          onStage(null, '正在释放检查资源');
          const endpoint = await inspector.endpoint();
          // The inspection lease excludes other Hub tools. Popups created by a checked
          // site belong to this inspection too; they must not keep a headless Chrome alive.
          if (endpoint?.headless && (!ownedWs || endpoint.ws === ownedWs)) await inspector.close();
          else if (!endpoint && inspector.lastLaunchPid) {
            // Failed startup: terminate only the exact child this inspector just spawned.
            try { process.kill(inspector.lastLaunchPid); } catch (e) { if (e.code !== 'ESRCH') throw e; }
          } else if (ownedWs && endpoint) throw Error('检查期间浏览器身份发生变化，未关闭其他浏览器');
          owned = false;
          ownedWs = null;
        }
      }
    }
  } finally {
    clearInterval(poll); signal.removeEventListener('abort', stop);
    chrome.clearYield?.();
    release();
  }
  if (shared) return runItems(chrome, items, signal, onStage, onResult, null);
  if (local.signal.aborted && !signal.aborted) return { yielded: true };
}
module.exports = { inspectAccounts, restrictedCheck };
