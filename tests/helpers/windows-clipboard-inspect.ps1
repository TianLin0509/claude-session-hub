# Read-only native format metadata. Never prints the user's clipboard contents.
param([string]$ExpectedFile = '')
$ErrorActionPreference = 'Stop'
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class HubClipboardProbe {
 [DllImport("user32.dll")] public static extern bool OpenClipboard(IntPtr h);
 [DllImport("user32.dll")] public static extern bool CloseClipboard();
 [DllImport("user32.dll")] public static extern IntPtr GetClipboardData(uint f);
 [DllImport("user32.dll")] public static extern uint EnumClipboardFormats(uint f);
 [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
 [DllImport("user32.dll")] public static extern IntPtr GetClipboardOwner();
 [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
 [DllImport("kernel32.dll")] public static extern uint GetACP();
 [DllImport("kernel32.dll")] public static extern IntPtr GlobalLock(IntPtr h);
 [DllImport("kernel32.dll")] public static extern bool GlobalUnlock(IntPtr h);
 [DllImport("kernel32.dll")] public static extern UIntPtr GlobalSize(IntPtr h);
 public static byte[] Read(uint f) {
   var h=GetClipboardData(f); if(h==IntPtr.Zero) return null;
   var p=GlobalLock(h); if(p==IntPtr.Zero) return null;
   try {var n=(int)GlobalSize(h).ToUInt64();var b=new byte[n];Marshal.Copy(p,b,0,n);return b;} finally {GlobalUnlock(h);}
 }
}
'@
if (-not [HubClipboardProbe]::OpenClipboard([IntPtr]::Zero)) { throw 'Clipboard busy' }
try {
 $formats = @(); $f = [uint32]0
 while (($f = [HubClipboardProbe]::EnumClipboardFormats($f)) -ne 0) { $formats += $f }
 $unicodeBytes = [HubClipboardProbe]::Read(13)
 $ansiBytes = [HubClipboardProbe]::Read(1)
 $localeBytes = [HubClipboardProbe]::Read(16)
 $unicode = if ($unicodeBytes) { [Text.Encoding]::Unicode.GetString($unicodeBytes).Split([char]0)[0] } else { '' }
 $locale = if ($localeBytes) { [BitConverter]::ToUInt32($localeBytes,0) } else { 0 }
 $ansiCP = if ($locale) { [Globalization.CultureInfo]::GetCultureInfo([int]$locale).TextInfo.ANSICodePage } else { [HubClipboardProbe]::GetACP() }
 $ansi = if ($ansiBytes) { [Text.Encoding]::GetEncoding($ansiCP).GetString($ansiBytes).Split([char]0)[0] } else { '' }
 $gbk = if ($ansiBytes) { [Text.Encoding]::GetEncoding(936).GetString($ansiBytes).Split([char]0)[0] } else { '' }
 $western = if ($ansiBytes) { [Text.Encoding]::GetEncoding(1252).GetString($ansiBytes).Split([char]0)[0] } else { '' }
 $expected = if ($ExpectedFile) { [IO.File]::ReadAllText($ExpectedFile, [Text.Encoding]::UTF8) } else { $null }
 $ownerPid = [uint32]0
 [void][HubClipboardProbe]::GetWindowThreadProcessId([HubClipboardProbe]::GetClipboardOwner(), [ref]$ownerPid)
 [ordered]@{ formats=$formats; sequence=[HubClipboardProbe]::GetClipboardSequenceNumber(); ownerPid=$ownerPid; systemACP=[HubClipboardProbe]::GetACP(); locale=$locale; localeACP=$ansiCP; unicodeLength=$unicode.Length; ansiMatchesUnicode=($ansi -eq $unicode); gbkMatchesUnicode=($gbk -eq $unicode); westernMatchesUnicode=($western -eq $unicode); matchesExpected=($null -ne $expected -and $unicode -eq $expected) } | ConvertTo-Json -Compress
} finally { [void][HubClipboardProbe]::CloseClipboard() }
