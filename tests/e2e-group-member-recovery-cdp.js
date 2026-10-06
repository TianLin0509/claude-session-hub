'use strict';
// Real isolated Hub, roster recovery and CLI resume; local CLI fixtures only.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify;
async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-group-recovery-'));
  const data = path.join(root, 'data'), home = path.join(root, 'home'), work = path.join(root, 'work'), bin = path.join(root, 'bin');
  const second = path.join(root, 'codex-second'), claude = path.join(home, '.claude');
  const out = path.resolve('artifacts', '20261006-group-member-recovery-codex1-' + Date.now());
  for (const dir of [data, home, work, bin, out, second, claude, path.join(data, 'meetings'), path.join(data, 'diagnostics')]) fs.mkdirSync(dir, { recursive: true });
  const mid = randomUUID(), ids = [randomUUID(), randomUUID(), randomUUID()], natives = ids.map(() => randomUUID());
  const slots = [{ kind: 'claude', memberId: 'm1', model: 'claude-haiku-4-5-20251001' },
    { kind: 'codex', memberId: 'm2', model: 'gpt-6.1-sol', mcpProfile: 'none' },
    { kind: 'claude', memberId: 'm3', model: 'claude-haiku-4-5-20251001' }];
  const now = Date.now();
  const meeting = { schemaVersion: 2, id: mid, title: '恢复测试群', groupChat: true, mode: 'free', scene: 'general',
    subSessions: [], slotSpecs: slots, participants: [2], workspace: work, createdAt: now - 100000, lastMessageTime: now - 1000, updatedAt: now };
  fs.writeFileSync(path.join(data, 'state.json'), j({ version: 1, sessions: [], meetings: [meeting] }));
  fs.writeFileSync(path.join(data, 'meetings', mid + '.json'), j({ ...meeting, subSessions: ids, updatedAt: now - 5000 }));
  fs.writeFileSync(path.join(data, 'diagnostics', 'session-manifest-11111.json'), j({ pid: 11111, writtenAt: now - 2000,
    sessions: ids.map((id, i) => ({ id, kind: slots[i].kind, title: '成员 ' + (i + 1), meetingId: mid, nativeId: natives[i] })) }));
  for (const i of [0, 2]) {
    const dir = path.join(claude, 'projects', work.replace(/[^A-Za-z0-9]/g, '-')); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, natives[i] + '.jsonl'), j({ type: 'user', uuid: randomUUID(), sessionId: natives[i], cwd: work,
      timestamp: new Date(now - 1000).toISOString(), message: { role: 'user', content: '已有问题' } }) + '\n');
  }
  fs.mkdirSync(path.join(second, 'sessions'), { recursive: true });
  fs.writeFileSync(path.join(second, 'sessions', 'rollout-test-' + natives[1] + '.jsonl'), j({ type: 'session_meta', payload: { id: natives[1], cwd: work } }) + '\n');
  fs.writeFileSync(path.join(data, 'config.json'), j({ runtime: { agent: 'pty' }, providers: { codex: {
    backend: 'subscription', subscription_profile: 'second', subscription_profiles: [{ id: 'default', home: path.join(root, 'codex-default') }, { id: 'second', home: second }],
  } } }));
  const cli = path.join(bin, 'fixture.js');
  fs.writeFileSync(cli, `if(process.argv.includes('--version')) console.log('codex-cli 0.0.0');else{console.log('RECOVERY_CLI_READY '+JSON.stringify(process.argv.slice(2)));process.stdin.resume();setInterval(()=>{},1000);}`);
  for (const name of ['claude', 'codex']) fs.writeFileSync(path.join(bin, name + '.cmd'), `@echo off\r\n"${process.execPath}" "${cli}" %*\r\n`);
  const accounts = path.join(bin, 'accounts.js'); fs.writeFileSync(accounts, "console.log(JSON.stringify({state:'signed_in',accounts:[]}));");
  let hub, client;
  const report = { passed: false, checks: [], boundary: 'Real isolated Hub UI and PTY resume with synthetic CLI/history fixtures' };
  const until = async (expr, label) => { const end = Date.now() + 30000; while (Date.now() < end) { if (await client.eval(expr)) return; await _waitMs(100); } throw Error('timeout: ' + label); };
  const launch = async () => {
    const port = await new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
    hub = await launchIsolatedHub({ dataDir: data, port, label: 'group recovery', extraEnv: { CLAUDE_HUB_E2E: '1',
      CLAUDE_HUB_AGENT_RUNTIME: 'pty', CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: claude, CODEX_HOME: second,
      CLAUDE_HUB_ACCOUNT_FIXTURE: accounts, AI_HUB_WORKSPACE_ROOT: root, PATH: bin + path.delimiter + process.env.PATH } });
    client = await connectFirstPage(hub);
    client.ws.on('message', raw => { const msg = JSON.parse(raw); if (msg.method === 'Runtime.exceptionThrown') (report.browserErrors ||= []).push(msg.params.exceptionDetails); });
    await client.send('Runtime.enable');
    await until('!!window.__hubE2E', 'renderer');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 950, deviceScaleFactor: 1, mobile: false });
    await until("document.body.innerText.includes('选择协作方式')", 'startup home rendered');
  };
  const click = async selector => {
    const point = await client.eval(`(()=>{const e=document.querySelector(${j(selector)});if(!e)throw Error('Missing '+${j(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    for (const type of ['mousePressed', 'mouseReleased']) await client.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 });
  };
  try {
    await launch();
    assert.deepEqual(await client.eval(`meetings[${j(mid)}].subSessions`), ids);
    assert.deepEqual(await client.eval(`meetings[${j(mid)}].participants`), [2]);
    report.checks.push('empty room recovers three exact members and keeps participation choices');
    await click(`#session-list .session-item[data-meeting-id="${mid}"] .sl-title`);
    await until(`activeMeetingId===${j(mid)}`, 'group opens');
    await until(`${j(ids)}.every(id=>sessions.get(id)?.status!=='dormant')`, 'all members resume by sidebar click');
    for (let i = 0; i < ids.length; i++) {
      const sid = ids[i];
      await until(`ipcRenderer.invoke('debug:get-session-buffer',${j(sid)}).then(value=>JSON.stringify(value).includes('RECOVERY_CLI_READY'))`, 'CLI resumed ' + i);
      const text = j(await client.eval(`ipcRenderer.invoke('debug:get-session-buffer',${j(sid)})`));
      assert(text.includes(natives[i]), 'CLI resumes original native thread ' + i);
    }
    report.checks.push('physical group click resumes all three original native IDs, including second-account Codex');
    const shot = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, 'restored-group.png'), Buffer.from(shot.data, 'base64'));
    // Kill only our recorded test member's PTY. Verify its ancestry against
    // the exact Hub PID we launched before simulating an external termination.
    const manifestFile = path.join(data, 'diagnostics', `session-manifest-${hub.pid}.json`);
    let victim;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && !victim) {
      if (fs.existsSync(manifestFile)) {
        const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
        assert.equal(manifest.pid, hub.pid);
        victim = manifest.sessions.find(s => s.id === ids[0] && s.ptyPid > 0);
      }
      if (!victim) await _waitMs(200);
    }
    assert(victim, 'test PTY PID recorded');
    const lineage = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-Command',
      `$chain=@();$nextPid=${Number(victim.ptyPid)};for($i=0;$i -lt 12 -and $nextPid -gt 0;$i++){$p=Get-CimInstance Win32_Process -Filter "ProcessId = $nextPid";if(!$p){break};$chain+= [int]$p.ProcessId;$nextPid=[int]$p.ParentProcessId};ConvertTo-Json -InputObject @($chain)`],
      { encoding: 'utf8', windowsHide: true }));
    assert(lineage.includes(hub.pid), 'PTY must belong to this isolated test Hub');
    execFileSync('taskkill.exe', ['/PID', String(victim.ptyPid), '/T', '/F'], { windowsHide: true, stdio: 'pipe' });
    await until(`sessions.get(${j(ids[0])})?.status==='dormant'`, 'unexpected exit becomes dormant');
    assert.deepEqual(await client.eval(`meetings[${j(mid)}].subSessions`), ids);
    await client.eval('persistWorkscene(true)');
    report.checks.push('unexpected member PTY exit preserves group roster and resumable card');
    await client.close(); client = null; await gracefulQuit(hub); hub = null;
    await launch();
    assert.deepEqual(await client.eval(`meetings[${j(mid)}].subSessions`), ids);
    for (const id of ids) assert(await client.eval(`sessions.has(${j(id)})`));
    report.checks.push('real Hub restart retains all recovered members');
    report.passed = true;
  } catch (error) { report.error = error.stack; if (hub) report.log = hub.log().slice(-30);
    if (client) report.screen = await client.eval('document.body.innerText.slice(-4500)');
    console.error(error.stack); process.exitCode = 1; }
  finally { if (client) await client.close(); if (hub) await gracefulQuit(hub); fs.writeFileSync(path.join(out, 'evidence.json'), j(report)); console.log(out, report); }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
