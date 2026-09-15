'use strict';
// Real isolated Hub + native child transport; no renderer state injection and
// no shortened polling intervals. Mutable upstream fixture supplies quota only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { getFreePort, waitFor, click } = require('./helpers/usage-refresh-fixture');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-claude-quota-auto-'));
const out = path.resolve('artifacts/claude-quota-auto', String(Date.now()));
fs.mkdirSync(out, { recursive: true });
const workspace = path.join(root, 'workspace'), data = path.join(root, 'data'), file = path.join(root, 'quota.json');
fs.mkdirSync(workspace); fs.mkdirSync(data);
fs.writeFileSync(path.join(data, 'prepared-projects.json'), JSON.stringify({ schemaVersion: 1, projects: [], migrations: [] }));
const resets = new Date(Date.now() + 3600000).toISOString();
function quota(pct) { fs.writeFileSync(file, JSON.stringify({ five_hour: { utilization: pct, resets_at: resets },
  seven_day: { utilization: 17, resets_at: new Date(Date.now() + 3 * 86400000).toISOString() } })); }
quota(56);
const evidence = { checks: [], passed: false }, j = JSON.stringify;
async function main() {
  let hub, c;
  const check = (name, value) => { assert.ok(value, name); evidence.checks.push(name); console.log('PASS', name); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await getFreePort(), windowMode: 'hidden', label: 'claude-quota-auto',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CODEX_HOME: path.join(root, 'codex'),
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.resolve('tests/fixtures/claude-stream.js'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: 'hold', CLAUDE_HUB_FIXTURE_USAGE_FILE: file,
        AI_HUB_WORKSPACE_ROOT: root, DEEPSEEK_API_KEY: '' } });
    c = await connectFirstPage(hub);
    await waitFor(c, '!!window.__hubE2E && !!window.WorkspaceController', 30000);
    const session = await c.eval(`window.WorkspaceController.createSession('claude', {cwd:${j(workspace)},opts:{mcpProfile:'lean'}}).then(s=>({id:s.id}))`);
    await waitFor(c, 'accountUsageController.getSnapshot().claude?.usage5h?.pct===56', 30000);
    check('connected ordinary session publishes quota automatically without a refresh click',
      await c.eval('document.querySelector(".sidebar-quota-provider[data-provider=claude]").innerText.includes("44%")'));
    await waitFor(c, '!!document.querySelector(".floating-input-box")', 30000);
    await c.eval("document.querySelector('.floating-input-box').focus()");
    await c.send('Input.insertText', { text: '自动额度验收' });
    await c.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await c.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await waitFor(c, `sessions.get(${j(session.id)})?.nativeRuntime?.submission?.sendStatus==='accepted'`, 30000);
    quota(61);
    await waitFor(c, 'accountUsageController.getSnapshot().claude?.usage5h?.pct===61', 75000);
    check('working session updates sidebar automatically', await c.eval('document.querySelector(".sidebar-quota-provider[data-provider=claude]").innerText.includes("39%")'));
    // A second update with unchanged running state proves timer polling rather
    // than a lucky lifecycle-triggered refresh.
    quota(62);
    await waitFor(c, 'accountUsageController.getSnapshot().claude?.usage5h?.pct===62', 75000);
    check('unchanged running state polls again on the real one-minute schedule', true);
    const before = await c.eval('accountUsageController.getSnapshot().claude.lastSeen');
    fs.writeFileSync(file, JSON.stringify({ error: 'fixture quota unavailable' }));
    await click(c, '.sidebar-quota-provider[data-provider=claude]');
    await waitFor(c, '!!accountUsageController.getSnapshot().refresh.providers.claude.error', 20000);
    check('failed request preserves quota and observation time', await c.eval(`accountUsageController.getSnapshot().claude.usage5h.pct===62 && accountUsageController.getSnapshot().claude.lastSeen===${before}`));
    quota(63);
    await waitFor(c, 'accountUsageController.getSnapshot().claude?.usage5h?.pct===63', 80000);
    check('background polling recovers after failure without another click',
      await c.eval('!accountUsageController.getSnapshot().refresh.providers.claude.error'));
    await click(c, '.floating-input-stop');
    await waitFor(c, `sessions.get(${j(session.id)})?.nativeRuntime?.state==='interrupted'`, 20000);
    await click(c, '.btn-close-session');
    await waitFor(c, `sessions.get(${j(session.id)})?.status==='dormant'`, 20000);
    quota(64);
    const group = await c.eval(`ipcRenderer.invoke('create-meeting',${j({ title: '额度自动刷新群聊', groupChat: true, scene: 'general', workspace,
      slots: [{ kind: 'claude', cwd: workspace, mcpProfile: 'lean' }] })})`);
    await waitFor(c, `!!document.querySelector('[data-meeting-id="${group.id}"]')`, 20000);
    await click(c, `[data-meeting-id="${group.id}"]`);
    await waitFor(c, '!!document.querySelector("#mr-input-box")', 20000);
    await c.eval('document.querySelector("#mr-input-box").focus()');
    await c.send('Input.insertText', { text: '群聊额度验收' });
    await click(c, '#mr-send-btn');
    await waitFor(c, 'accountUsageController.getSnapshot().claude?.usage5h?.pct===64', 75000);
    check('group member refreshes quota while ordinary session is dormant', await c.eval(`activeMeetingId===${j(group.id)}`));
    const screenshot = await c.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'group-quota.png'), Buffer.from(screenshot.data, 'base64'));
    evidence.requests = fs.readFileSync(file + '.requests', 'utf8').trim().split('\n').map(JSON.parse);
    evidence.passed = true;
  } finally {
    if (c) {
      fs.writeFileSync(path.join(out, 'last-state.json'), JSON.stringify(await c.eval('({sessions:[...sessions.values()],body:document.body.innerText})'), null, 2));
      const shot = await c.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(out, 'last.png'), Buffer.from(shot.data, 'base64'));
      await c.close();
    }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify({ out, ...evidence }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
