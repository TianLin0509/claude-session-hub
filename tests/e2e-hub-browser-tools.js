'use strict';
const fs = require('fs'), path = require('path'), os = require('os'), assert = require('assert/strict');
const { promisify } = require('util');
const execFile = promisify(require('child_process').execFile);
const { BrowserTool } = require('../core/hub-browser-tool');
const { HubChrome } = require('../core/hub-chrome');
const { CDP } = require('../core/web-roundtable/cdp');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-shared-tools-'));
const playwright = require.resolve('playwright', { paths: [process.env.HUB_TEST_PLAYWRIGHT || 'C:/DevTools/playwright-cli-0.1.19/node_modules'] });
const env = { ...process.env, HUB_CHROME_ROOT: root };
const hub = new HubChrome({ root, env });
const bindings = Array.from({ length: 4 }, (_, i) => ({ id: 'images-' + i, tool: 'images', identity: 'main', root, playwright }))
  .concat([{ id: 'images-alt', tool: 'images', identity: 'alt', root, playwright }, { id: 'bridge', tool: 'bridge', identity: 'main', root, playwright }]);
const entry = path.resolve(__dirname, '../core/hub-browser-tool.js');
async function command(binding, args) {
  const file = path.join(root, binding.id + '.cjs');
  fs.writeFileSync(file, `require(${JSON.stringify(entry)}).main(${JSON.stringify(binding)});`);
  const { stdout } = await execFile(process.execPath, [file, '--session', 'same-legacy-name', '--json', ...args], { env, timeout: 60000, windowsHide: true });
  return JSON.parse(stdout).result;
}
(async () => {
  try {
    await hub.ensure();
    const opened = await Promise.all(bindings.map(b => command(b, ['open', 'about:blank', '--headed'])));
    assert.equal(new Set(opened.map(o => o.targetId)).size, 6, 'each concurrent lane gets its own page');
    const ep = await hub.endpoint(), cdp = await CDP.connect(ep.ws, ep.port);
    assert.equal((await cdp.call('SystemInfo.getProcessInfo')).processInfo.filter(p => p.type === 'browser').length, 1);
    const script = path.join(root, 'fixture.js');
    fs.writeFileSync(script, 'async page => { await page.setContent("<input id=prompt><button id=send>Send</button>"); await page.locator("#prompt").fill("isolated fixture"); return await page.locator("#prompt").inputValue(); }');
    assert.deepEqual(await Promise.all(bindings.map(b => command(b, ['run-code', '--filename', script]))), bindings.map(() => 'isolated fixture'));
    // Actual old/new selector shapes, including the image mode moving outside the editor.
    const modern = `<div data-composer-body><div contenteditable="true" data-composer-markdown></div><button aria-label="Open profile menu"></button><button aria-label="Add files and more"></button><button aria-label="Remove Create image">Create image</button><button aria-label="Send">Send</button></div><div data-menu-row-content><span>Create image</span></div>`;
    fs.writeFileSync(script, `async page => { await page.setContent(${JSON.stringify(modern)}); const composer=page.locator('#prompt-textarea'); await composer.fill('fixture only'); return {text:await composer.innerText(),send:await page.getByTestId('send-button').count(),mode:await composer.locator('[data-inline-selection-pill][data-system-hint-type="picture_v2"]').count(),tool:await page.locator('[role="menu"], [role="group"]').getByText(/^Create image$/).count()}; }`);
    assert.deepEqual(await command(bindings[0], ['run-code', '--filename', script]), { text: 'fixture only', send: 1, mode: 1, tool: 1 });
    // A close/disconnect only affects the named lane, never the shared process or bridge.
    await command(bindings[0], ['close']);
    assert.equal(await hub.running(), true);
    for (const b of bindings.slice(1)) assert.ok(await new BrowserTool(b, { env }).target());
    const main = new BrowserTool(bindings[1], { env }), alt = new BrowserTool(bindings[4], { env });
    const mainTarget = await main.target(), altTarget = await alt.target();
    const p = await hub.page(mainTarget.targetId);
    await p.call('Network.setCookie', { name: 'identity-fixture', value: 'main', url: 'https://example.com/' }); p.close();
    const a = await hub.page(altTarget.targetId);
    assert.equal((await a.call('Network.getCookies', { urls: ['https://example.com/'] })).cookies.length, 0); a.close();
    // Tampering with a saved lane target cannot redirect an alt tool into main.
    const altFile = path.join(root, 'tool-pages', 'images-alt.json');
    const altRecord = JSON.parse(fs.readFileSync(altFile));
    fs.writeFileSync(altFile, JSON.stringify({ ...altRecord, targetId: mainTarget.targetId }));
    assert.equal(await alt.target(), null);
    fs.writeFileSync(altFile, JSON.stringify(altRecord));
    await assert.rejects(hub.openLogin('main', ['google']), /网页任务正在用/);
    cdp.close();
    for (const b of bindings) await command(b, ['close']);
    const report = { passed: true, checks: ['6 concurrent pages / 1 Chrome browser process', '4 main image lanes + alt identity + bridge', 'real Playwright run-code transport', 'closing one lane preserves all others', 'cookies separated by identity', 'target identity mismatch rejected', 'login cannot close active tool pages'], root };
    const out = path.resolve('artifacts/shared-browser-tools'); fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } finally { await hub.close(); }
})().catch(e => { console.error(e.stack); process.exitCode = 1; });
