'use strict';
// Real isolated headless Chrome. DOM samples are fixtures, not provider login proof.
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { HubChrome } = require('../core/hub-chrome');
const { CDP } = require('../core/web-roundtable/cdp');
const { PROBE } = require('../core/account-browser');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-login-probe-'));
const out = path.resolve('artifacts/login-probe'); fs.mkdirSync(out, { recursive: true });
try { os.setPriority(0, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
(async () => {
  const hub = new HubChrome({ root });
  let cdp, page;
  const result = { passed: false, checks: [], boundary: 'isolated real headless Chrome; website DOM fixtures' };
  try {
    const ep = await hub.ensure({ headless: true });
    assert.equal(ep.headless, true);
    cdp = await CDP.connect(ep.ws, ep.port);
    const marker = await hub.page((await hub.marker('main', cdp)).targetId);
    await marker.evaluate('window.open=()=>null'); marker.close();
    const { targetId } = await hub.openTab('main', 'about:blank');
    result.checks.push('headless inspection creates its own tab even when window.open yields no popup');
    page = await hub.page(targetId);
    const frameId = (await page.call('Page.getFrameTree')).frameTree.frame.id;
    const set = html => page.call('Page.setDocumentContent', { frameId, html: '<!doctype html><meta charset="utf-8">' + html });
    const probe = host => page.evaluate(`((location)=>${PROBE})({hostname:${JSON.stringify(host)}})`);
    await set('<button aria-label="Open profile menu">Profile</button>');
    assert.equal((await probe('chatgpt.com')).profile, true);
    assert.equal((await probe('example.com')).profile, false, 'new provider-specific selector is host scoped');
    await set('<div contenteditable="true" data-composer-markdown></div><button>Log in</button>');
    assert.equal((await probe('chatgpt.com')).profile, false, 'guest composer does not prove login');
    assert.equal((await probe('chatgpt.com')).login, true);
    await set('<button aria-label="Open profile menu" style="display:none">Profile</button>');
    assert.equal((await probe('chatgpt.com')).profile, false, 'hidden old menu does not prove login');
    result.checks.push('current ChatGPT profile menu, guest and hidden menu, host boundary');
    await hub.place(cdp, targetId, { windowState: 'maximized' });
    assert.equal((await cdp.call('Browser.getWindowForTarget', { targetId })).bounds.windowState, 'maximized');
    result.checks.push('Chrome confirms maximized window bounds without a visible window');
    await hub.closeTab(targetId);
    result.passed = true;
  } catch (e) { result.error = e.stack; throw e; }
  finally { page?.close(); cdp?.close(); await hub.close(); fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); }
  console.log(JSON.stringify(result, null, 2));
})().catch(e => { console.error(e); process.exitCode = 1; });
