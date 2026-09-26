'use strict';
const path = require('path');
const { HubChrome } = require('./hub-chrome');
const { acquire } = require('./web-roundtable/store');

// Own the shared profile exclusively, inspecting one profile and one page at a time.
// An ordinary/user browser is never closed or repurposed for a background check.
async function inspectAccounts({ chrome, items, signal, onStage, onResult, fixture, createInspector = options => new HubChrome(options) }) {
  const release = await chrome.lifecycle(() => acquire('account-check', path.join(chrome.root, 'locks')));
  if (!release) throw Error('另一个 Hub 正在检查登录，请稍后再试');
  let inspector, owned = false, ownedWs;
  try {
    inspector = fixture ? null : createInspector({ root: chrome.root, env: chrome.env, executable: chrome.executable, identities: chrome.identities });
    if (inspector) inspector.inspectionOwner = true;
    if (!fixture && (await chrome.running() || chrome.profileHeld())) {
      throw Error('专属 Chrome 正在使用中。请关闭其中的网页窗口后重试；已有登录会保留。');
    }
    for (const identity of [...new Set(items.map(item => item.identity))]) {
      if (signal.aborted) break;
      const group = items.filter(item => item.identity === identity);
      onStage(group[0], '正在启动无头检查');
      try {
        if (inspector) {
          owned = true;
          inspector.lastLaunchPid = null;
          ownedWs = (await inspector.ensure({ headless: true, identityId: identity })).ws;
        }
        for (const item of group) {
          if (signal.aborted) break;
          onStage(item, '正在确认官网账号');
          let result;
          try {
            if (fixture) {
              await new Promise(resolve => setTimeout(resolve, Math.min(2000, Math.max(0, fixture.delayMs || 0))));
              result = { ...(fixture[identity]?.sites?.[item.site] || { state: 'unknown' }) };
              if (item.site === 'chatgpt' && result.state === 'signed_in') result.account = fixture[identity]?.account || '';
            } else if (item.site === 'chatgpt') {
              const account = await inspector.chatgptAccount(identity, { signal });
              result = account ? { state: 'signed_in', account } : await inspector.liveStatus(identity, item.site, { signal, timeoutMs: 6000 });
            } else result = await inspector.liveStatus(identity, item.site, { signal });
          } catch (e) {
            if (signal.aborted) break;
            result = { state: 'unknown', error: e.message };
          }
          if (!signal.aborted) await onResult(item, { ...result, live: true, verified: ['signed_in', 'signed_out', 'needs_attention'].includes(result.state), checkedAt: Date.now(), stale: false });
        }
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
  } finally { release(); }
}
module.exports = { inspectAccounts };
