'use strict';
// Real Chrome, isolated profile: a person's handoff pauses and detaches automation, opens an
// on-screen window with no debugger on it, and ends when the person closes that window.
// Run: node tests/e2e-web-risk-handoff-real-chrome.js   (shows one Chrome window briefly)
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { HubChrome } = require('../core/hub-chrome');
const { BrowserTool } = require('../core/hub-browser-tool');
const guard = require('../core/web-risk-guard');
const { execFileSync } = require('child_process');

function windowRectOf(title) {
  // Browser-independent evidence: where Windows actually placed the window with this title.
  const ps = `Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class WR { public delegate bool P(IntPtr h, IntPtr l);
 [DllImport("user32.dll")] public static extern bool EnumWindows(P p, IntPtr l);
 [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out R r);
 public struct R { public int L, T, Rt, B; } }
'@
$out = @(); [WR]::EnumWindows({ param($h,$l) $t = New-Object Text.StringBuilder 400; [void][WR]::GetWindowText($h,$t,400)
 if ([WR]::IsWindowVisible($h) -and $t.ToString().StartsWith('${title}')) { $r = New-Object WR+R; [void][WR]::GetWindowRect($h,[ref]$r); $script:out += "$($r.L),$($r.T),$($r.Rt),$($r.B)" }; $true }, [IntPtr]::Zero) | Out-Null
$out -join ';'`;
  return execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8', windowsHide: true }).trim();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-risk-e2e-'));
  const env = { ...process.env, HUB_CHROME_ROOT: root };
  const hub = new HubChrome({ root, env });
  // The same Playwright the production image lanes are bound to (tool-bindings.json).
  const playwright = process.env.HUB_E2E_PLAYWRIGHT || 'C:/DevTools/playwright-cli-0.1.19/node_modules/playwright/index.js';
  const binding = { id: 'images-e2e', tool: 'images', identity: 'main', root, playwright };
  const tool = new BrowserTool(binding, { env, hub });
  const evidence = {};
  try {
    await hub.ensure({ identityId: 'main' });
    const lane = await tool.open('about:blank');
    evidence.laneTab = lane.targetId;

    // A lane holds a whole-browser Playwright connection, as the image daemon does.
    const { chromium } = require(playwright);
    const ep = await hub.endpoint();
    const automation = await chromium.connectOverCDP(`http://127.0.0.1:${ep.port}`, { noDefaults: true });

    const handed = await tool.execute(['human-open', 'https://example.com/']);
    evidence.handoff = handed;
    assert.equal(handed.handoff, true);
    const lease = guard.handoff(root);
    assert.ok(lease?.targetId, 'lease records the person window');

    // Transports refuse while the person has the browser.
    await assert.rejects(tool.execute(['goto', 'https://example.com/']), /Human handoff/);
    evidence.refusedDuringHandoff = true;

    // The person window is on screen (Windows' own coordinates), not parked at -32000.
    await sleep(1500);
    const rects = windowRectOf('Example Domain');
    evidence.personWindowRects = rects;
    assert.ok(rects, 'person window is visible');
    const [l, tp] = rects.split(';')[0].split(',').map(Number);
    assert.ok(l > -100 && tp > -100, 'person window is on screen: ' + rects);

    // Once automation connections are gone, nothing is attached to the person's page.
    await automation.close();
    const { CDP } = require('../core/web-roundtable/cdp');
    const cdp = await CDP.connect(ep.ws, ep.port);
    const info = (await cdp.call('Target.getTargets')).targetInfos.find(t => t.targetId === lease.targetId);
    evidence.personPageAttached = info.attached;
    assert.equal(info.attached, false, 'no debugger on the person page');

    // The person closes their window: the handoff ends and automation resumes.
    await cdp.call('Target.closeTarget', { targetId: lease.targetId });
    cdp.close();
    await sleep(800);
    assert.equal(await guard.settleHandoff(hub), null);
    assert.equal(guard.handoff(root), null);
    const after = await tool.execute(['goto', 'https://example.com/']);
    evidence.resumedGoto = after.url;
    assert.match(after.url, /example\.com/);
    console.log(JSON.stringify({ ok: true, evidence }, null, 2));
  } catch (e) {
    console.log(JSON.stringify({ ok: false, error: e.message, evidence }, null, 2));
    process.exitCode = 1;
  } finally {
    try { await hub.close(); } catch {}
    try { fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); } catch {} // Chrome may still hold files briefly
  }
})();
