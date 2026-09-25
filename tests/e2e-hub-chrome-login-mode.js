'use strict';
// Real Chrome, throw-away profile. The login path Google accepts: an ordinary Chrome (no
// debugging port) on the Hub profile, which the user closes when done — after which the
// Hub can take the profile back in debugging mode.
const fs = require('fs'), os = require('os'), path = require('path'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { HubChrome } = require('../core/hub-chrome');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-chrome-login-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const checks = [];
// What a person does: close every window of that Chrome (the X button sends WM_CLOSE).
function closeWindowsLikeAPerson(pid) {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    `$ids=@(${pid})+(Get-CimInstance Win32_Process -Filter "ParentProcessId=${pid}").ProcessId;` +
    `Add-Type -Namespace W -Name U -MemberDefinition '[DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f,System.IntPtr l);public delegate bool EnumProc(System.IntPtr h,System.IntPtr l);[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(System.IntPtr h,out uint p);[DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);[DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h,uint m,System.IntPtr w,System.IntPtr l);';` +
    `$hs=New-Object System.Collections.ArrayList;[W.U]::EnumWindows({param($h,$l);$p=0;[void][W.U]::GetWindowThreadProcessId($h,[ref]$p);if($p -eq ${pid} -and [W.U]::IsWindowVisible($h)){[void]$hs.Add($h)};$true},[IntPtr]::Zero)|Out-Null;` +
    `foreach($h in $hs){[void][W.U]::PostMessage($h,0x10,[IntPtr]::Zero,[IntPtr]::Zero)};"closed $($hs.Count)"`], { encoding: 'utf8' });
}
(async () => {
  const hub = new HubChrome({ root });
  try {
    // Start the way tools do (debugging mode), then ask for a login.
    await hub.ensure();
    assert.ok((await hub.owners()).every(o => o.automated));
    await hub.openLogin('main', ['chatgpt', 'google']);
    let owners = await hub.owners();
    for (let i = 0; i < 40 && !(owners.length === 1 && !owners[0].automated); i++) { await sleep(250); owners = await hub.owners(); }
    assert.equal(owners.length, 1); assert.equal(owners[0].automated, false, 'the login window runs without a debugging port');
    assert.equal(await hub.endpoint(), null);
    checks.push('点登录：原来的调试模式浏览器退出，同一目录改以普通模式（无调试端口）打开登录页');

    const st = await hub.loginStatus('main');
    assert.equal(st.loginOpen, true); assert.equal(st.sites.chatgpt.state, 'login_open');
    await assert.rejects(hub.ensure(), /正开着登录窗口/);
    checks.push('登录窗口开着时：检查登录如实说"登录窗口开着"；网页工具不会去抢这个浏览器，而是给出明确提示');

    const pid = Number(execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object{$_.CommandLine -like '*${path.basename(root)}*' -and $_.CommandLine -notlike '*--type=*'}|Select-Object -First 1).ProcessId`], { encoding: 'utf8' }).trim());
    assert.ok(pid > 0, 'found the ordinary Chrome');
    closeWindowsLikeAPerson(pid);
    for (let i = 0; i < 60 && (await hub.owners()).length; i++) await sleep(250);
    assert.equal((await hub.owners()).length, 0, 'closing the windows ends that Chrome');
    checks.push('用户关掉登录窗口后，这个 Chrome 进程真的退出（没有留在后台）');

    await hub.ensure();
    assert.ok(await hub.endpoint(), 'the Hub takes the profile back in debugging mode');
    assert.equal((await hub.loginStatus('main', { live: false })).loginOpen, undefined);
    checks.push('之后网页工具需要时，Hub 能重新以调试模式启动同一个浏览器');
    console.log(JSON.stringify({ passed: true, checks }, null, 1));
  } catch (e) { console.error('FAIL', e.stack); process.exitCode = 1; }
  finally {
    try { await hub.close(); } catch {}
    try { execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'"|Where-Object{$_.CommandLine -like '*${path.basename(root)}*'}|ForEach-Object{Stop-Process -Id $_.ProcessId -Force -EA SilentlyContinue}`]); } catch {}
    await sleep(1500);
    try { execFileSync('cmd.exe', ['/c', 'rmdir', '/S', '/Q', root]); } catch {}
  }
})();
