'use strict';
const fs = require('fs'), os = require('os'), path = require('path');
const { execFileSync } = require('child_process');
const { CodexAppServerClient, resolveNativeCommand } = require('../main/codex-app-server-client');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-window-check-'));
const out = path.resolve(__dirname, '../output/playwright/session-polish');
fs.mkdirSync(out, { recursive: true });
const ps = path.join(root, 'windows.ps1');
fs.writeFileSync(ps, `Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public class HubWindowProbe {
 public delegate bool Callback(IntPtr h, IntPtr p);
 [DllImport("user32.dll")] public static extern bool EnumWindows(Callback cb, IntPtr p);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h,StringBuilder s,int n);
 public static string Scan() {
  var rows=new System.Collections.Generic.List<string>();
  EnumWindows((h,p)=>{if(IsWindowVisible(h)){var s=new StringBuilder(1024);GetWindowText(h,s,1024);if(s.ToString().IndexOf("codex",StringComparison.OrdinalIgnoreCase)>=0)rows.Add(h.ToInt64().ToString());}return true;},IntPtr.Zero);
  return string.Join(",", rows);
 }
}
'@
[HubWindowProbe]::Scan()
`);
const scan = () => execFileSync('powershell.exe', ['-NoProfile', '-File', ps], { windowsHide: true, encoding: 'utf8' }).trim().split(',').filter(Boolean);
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  const env = { ...process.env, CODEX_HOME: path.join(root, 'codex'), CLAUDE_HUB_DATA_DIR: path.join(root, 'data') };
  delete env.CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE;
  fs.mkdirSync(env.CODEX_HOME, { recursive: true });
  const native = resolveNativeCommand(env);
  const shim = fs.readFileSync(path.join(env.APPDATA, 'npm/codex.cmd'), 'utf8');
  const script = shim.match(/"([^"\r\n]*[\\/]bin[\\/]codex(?:-managed)?\.js)"/i)[1];
  const result = { command: native.command, checks: [] };
  for (const [name, launch] of [['old-wrapper', { command: path.resolve(__dirname, '../node_modules/electron/dist/electron.exe'), args: [script], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }], ['native-hidden', native]]) {
    const before = new Set(scan());
    const client = new CodexAppServerClient({ launch, cwd: root, timeoutMs: 20000 });
    try {
      await client.start();
      await delay(1000);
      const newWindows = scan().filter(id => !before.has(id));
      result.checks.push({ name, initialized: true, newVisibleCodexWindows: newWindows.length });
    } finally { client.close(); await delay(1200); }
  }
  fs.writeFileSync(path.join(out, 'native-window-proof.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (result.checks[0].newVisibleCodexWindows < 1 || result.checks[1].newVisibleCodexWindows !== 0) process.exitCode = 1;
})().catch(error => { console.error(error); process.exitCode = 1; });
