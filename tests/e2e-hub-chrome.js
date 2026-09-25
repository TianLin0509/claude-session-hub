'use strict';
// Real Chrome, throw-away user-data-dir. Proves the Hub Chrome contract end to end:
// one process serves both identities, their cookies never mix, tabs land in the chosen
// identity off screen, and "check login" answers from disk once the browser is closed.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { HubChrome } = require('../core/hub-chrome');
const { CDP } = require('../core/web-roundtable/cdp');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chrome-e2e-'));
const tag = path.basename(root);
const checks = [];
async function browserCdp(hub) { const ep = await hub.endpoint(); return CDP.connect(ep.ws, ep.port); }
(async () => {
  const hub = new HubChrome({ root, env: { ...process.env, HUB_CHROME_ROOT: root } });
  try {
    assert.equal(await hub.running(), false);
    assert.deepEqual(hub.offlineStatus('main').sites.chatgpt, { state: 'signed_out' }, 'a profile never used has no login');

    await hub.ensure();
    const cdp = await browserCdp(hub);
    const mainCtx = await hub.context('main', cdp), altCtx = await hub.context('alt', cdp);
    assert.notEqual(mainCtx, altCtx, 'each identity is its own browser context');
    const procs = (await cdp.call('SystemInfo.getProcessInfo')).processInfo;
    assert.equal(procs.filter(p => p.type === 'browser').length, 1, 'both identities run inside one browser process');
    checks.push('一个 Chrome 进程同时承载两个身份，各是独立的 browser context');

    const in30d = Math.floor(Date.now() / 1000) + 30 * 86400;
    // Browser-level Storage.* only accepts contexts created over CDP, not profiles; a page
    // session writes into whatever profile its tab belongs to, which is what we want to prove.
    // The hard case: Chrome treats the most recently used profile (alt) as its default, and
    // a naive Target.createTarget would drop the tab there. It must still land in main.
    const { defaultBrowserContextId } = await cdp.call('Target.getBrowserContexts');
    assert.equal(defaultBrowserContextId, altCtx, 'precondition: main is not the default context');
    const seed = await hub.openTab('main', 'https://example.com/');
    assert.equal(seed.browserContextId, mainCtx);
    assert.equal((await cdp.call('Target.getTargets')).targetInfos.find(t => t.targetId === seed.targetId).browserContextId, mainCtx, 'a main tab lands in main even when alt is Chrome default');
    const mainPage = await hub.page(seed.targetId);
    for (const c of [
      { name: '__Secure-next-auth.session-token', url: 'https://chatgpt.com', domain: '.chatgpt.com', httpOnly: true },
      { name: '__Secure-1PSID', url: 'https://google.com', domain: '.google.com' },
    ]) await mainPage.call('Network.setCookie', { ...c, value: 'fixture', path: '/', secure: true, expires: in30d });
    mainPage.close(); await hub.closeTab(seed.targetId);
    const peek = await hub.openTab('alt', 'https://example.com/');
    const altPage = await hub.page(peek.targetId);
    const altCookies = (await altPage.call('Network.getCookies', { urls: ['https://chatgpt.com', 'https://google.com'] })).cookies;
    altPage.close(); await hub.closeTab(peek.targetId);
    assert.equal(altCookies.length, 0, 'the other identity must not see the login');
    checks.push('Chrome 把副身份当默认时，工具要的主身份标签仍准确落在主身份里');
    checks.push('主身份的登录 cookie 对副身份不可见');

    const { targetId } = await hub.openTab('alt', 'https://example.com/');
    const { targetInfos } = await cdp.call('Target.getTargets');
    assert.equal(targetInfos.find(t => t.targetId === targetId).browserContextId, altCtx, 'tab opened in the requested identity');
    const { windowId } = await cdp.call('Browser.getWindowForTarget', { targetId });
    const { bounds } = await cdp.call('Browser.getWindowBounds', { windowId });
    assert.ok(bounds.left < -1000 && bounds.windowState === 'normal', 'work tabs are off screen, not minimized: ' + JSON.stringify(bounds));
    await hub.closeTab(targetId);
    checks.push('工具标签开在指定身份里，窗口在屏幕外且不是最小化（不会被节流）');

    const login = await hub.openLogin('main', 'chatgpt');
    const lw = await cdp.call('Browser.getWindowForTarget', { targetId: login.targetId });
    const lb = (await cdp.call('Browser.getWindowBounds', { windowId: lw.windowId })).bounds;
    assert.ok(lb.left >= 0 && lb.top >= 0, 'a login window is on screen: ' + JSON.stringify(lb));
    checks.push('「登录」打开的窗口在屏幕内');
    cdp.close();

    await hub.close();
    for (let i = 0; i < 40 && (await hub.running()); i++) await new Promise(r => setTimeout(r, 250));
    assert.equal(await hub.running(), false);
    const main = hub.offlineStatus('main'), alt = hub.offlineStatus('alt');
    assert.equal(main.sites.chatgpt.state, 'signed_in');
    assert.ok(Math.abs(main.sites.chatgpt.expiresAt - in30d * 1000) < 2000, 'expiry read from disk');
    assert.equal(main.sites.google.state, 'signed_in');
    assert.equal(main.sites.deepseek.state, 'needs_browser', 'localStorage sites say so instead of guessing');
    assert.equal(alt.sites.chatgpt.state, 'signed_out');
    checks.push('浏览器关闭后，直接读磁盘就能答出各站登录状态与到期时间');

    console.log(JSON.stringify({ passed: true, checks }, null, 1));
  } catch (e) {
    console.error('FAIL', e.stack);
    process.exitCode = 1;
  } finally {
    try { await hub.close(); } catch {}
    try {
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object{$_.CommandLine -like '*${tag}*'}|ForEach-Object{Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue}`]);
    } catch {}
    await new Promise(r => setTimeout(r, 1500));
    try { execFileSync('cmd.exe', ['/c', 'rmdir', '/S', '/Q', root]); } catch {}
  }
})();
