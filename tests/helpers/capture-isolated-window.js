'use strict';
const fs=require('fs');
const {promisify}=require('util');
const execFile=promisify(require('child_process').execFile);

// Diagnostic fallback for Chromium frame capture under Windows occlusion.
// Capture only the explicitly supplied, test-owned process's visible window.
async function captureIsolatedWindow(cdp,hub,target) {
  try {
    await cdp.send('Page.bringToFront');
    const shot=await cdp.send('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
    fs.writeFileSync(target,Buffer.from(shot.data,'base64'));
    return 'CDP';
  } catch(error) {
    if(process.platform!=='win32')throw error;
    console.warn('CDP screenshot failed; capturing isolated PID '+hub.pid+' via PrintWindow: '+error.message);
    const script=`
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public class HubTestWindow {
  public delegate bool Callback(IntPtr w, IntPtr p);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback f, IntPtr p);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr w, out uint p);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr w);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr w, out Rect r);
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr w, IntPtr dc, uint flags);
  public struct Rect { public int L,T,R,B; }
  public static IntPtr Find(uint pid) {
    IntPtr found=IntPtr.Zero;
    EnumWindows(delegate(IntPtr w,IntPtr p){uint id;GetWindowThreadProcessId(w,out id);if(id==pid&&IsWindowVisible(w)){found=w;return false;}return true;},IntPtr.Zero);
    return found;
  }
}
'@
$w=[HubTestWindow]::Find([uint32]$env:HUB_TEST_CAPTURE_PID)
if($w -eq [IntPtr]::Zero){throw 'test-owned visible window missing'}
$r=New-Object HubTestWindow+Rect
[void][HubTestWindow]::GetWindowRect($w,[ref]$r)
$bitmap=New-Object Drawing.Bitmap ($r.R-$r.L),($r.B-$r.T)
$graphics=[Drawing.Graphics]::FromImage($bitmap)
$dc=$graphics.GetHdc()
try {if(-not [HubTestWindow]::PrintWindow($w,$dc,2)){throw 'PrintWindow failed'}} finally {$graphics.ReleaseHdc($dc);$graphics.Dispose()}
try {$bitmap.Save($env:HUB_TEST_CAPTURE_PATH,[Drawing.Imaging.ImageFormat]::Png)} finally {$bitmap.Dispose()}
`;
    await execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{
      windowsHide:true,timeout:15000,env:{...process.env,HUB_TEST_CAPTURE_PID:String(hub.pid),HUB_TEST_CAPTURE_PATH:target},
    });
    if(!fs.existsSync(target)||fs.statSync(target).size<1024)throw new Error('isolated window screenshot missing');
    return 'PrintWindow';
  }
}
module.exports={captureIsolatedWindow};
