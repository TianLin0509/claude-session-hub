'use strict';
// Windows 原生命中测试（WM_NCHITTEST）。
//
// 为什么需要它：`-webkit-app-region: drag` 的效果不在 DOM 里，而在 Windows
// 怎么回答「屏幕上这个点属于窗口的哪一部分」。落在拖动区里的元素，系统答
// HTCAPTION(2)「这是标题栏」，于是按下去是拖窗口，click 根本不会到达页面；
// 标注了 no-drag 的元素答 HTCLIENT(1)「这是客户区」，点击才正常派发。
//
// 而 DOM 的 element.click() / dispatchEvent 完全绕过这一层，所以只用它们写的
// 测试对这类问题是**瞎的** —— 2026-09-08 T6 评审就是这么逮到会话标题漏标
// no-drag 的：CDP 用例全绿，真鼠标点下去却打不开重命名。
//
// 用法：
//   const { hitTestScreenPoint } = require('./helpers/native-hit-test.js');
//   const code = hitTestScreenPoint(windowTitle, screenX, screenY);  // 1=客户区 2=标题栏

const { execFileSync } = require('child_process');

const HIT_NAMES = Object.freeze({
  0: 'HTNOWHERE',
  1: 'HTCLIENT',
  2: 'HTCAPTION',
  '-1': 'HTTRANSPARENT',
});

// 找到某个 PID 的主窗口，向它发 WM_NCHITTEST，返回命中码。
// 用 SendMessage 而不是真的移动鼠标：真移鼠标会抢用户的输入焦点，
// 而且在没有前台焦点时结果不可靠（评审第一次尝试就卡在这上面）。
// 取窗口句柄的方式换过两版，都因为「找不到就静默跳过」而白跑：
//   1) Get-Process 的 MainWindowHandle —— Electron 的窗口它常年报 0；
//   2) 按 PID 枚举 —— spawn 出来的 pid 和真正持有窗口的进程未必是同一个。
// 现在按**窗口标题精确匹配**：Hub 的标题里带着自己的 PID 和版本号
// （"AI 群聊 Hub：PID 1234 v1.6.94"），调用方把主进程报上来的真实标题传进来，
// 这是这个仓库里最可靠的一条窗口身份线索。
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
# 参数走环境变量，不走命令行：
#   1) powershell.exe -Command "<脚本>" 后面跟的 -Foo bar 不会绑定到 param()，
#      PowerShell 会把 -Foo 当成一条命令去执行（这个坑让前三次尝试全部静默
#      报「找不到窗口」，而真正的原因是参数压根没传进来）；
#   2) 窗口标题里有中文，经命令行 argv 转一手会变成 ????。
$TitleNeedle = $env:HITTEST_TITLE
$X = [int]$env:HITTEST_X
$Y = [int]$env:HITTEST_Y
Add-Type -Namespace NativeHit -Name Win -MemberDefinition @'
[DllImport("user32.dll")]
public static extern IntPtr SendMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
[DllImport("user32.dll")]
public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
[DllImport("user32.dll")]
public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")]
public static extern bool IsWindowVisible(IntPtr hWnd);
[DllImport("user32.dll", CharSet = CharSet.Unicode)]
public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);
public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
'@
# Hub 的窗口标题里就带着自己的 PID（"AI 群聊 Hub：PID 1234 v1.6.94"），
# 这是它本来就有的身份标记，比 MainWindowHandle 可靠得多 —— 后者对 Electron
# 常年报 0，据此判「没有窗口」会把整条验证悄悄跳过。
$found = [IntPtr]::Zero
$cb = [NativeHit.Win+EnumWindowsProc]{
  param($hWnd, $lParam)
  $sb = New-Object System.Text.StringBuilder 512
  [void][NativeHit.Win]::GetWindowText($hWnd, $sb, $sb.Capacity)
  if ($sb.ToString() -eq $TitleNeedle) {
    $script:found = $hWnd
    return $false
  }
  return $true
}
[void][NativeHit.Win]::EnumWindows($cb, [IntPtr]::Zero)
if ($found -eq [IntPtr]::Zero) { Write-Output 'NOWINDOW'; exit 0 }
$WM_NCHITTEST = 0x0084
$lParam = [IntPtr](($Y -shl 16) -bor ($X -band 0xFFFF))
$r = [NativeHit.Win]::SendMessage($found, $WM_NCHITTEST, [IntPtr]::Zero, $lParam)
Write-Output ([int]$r)
`;

// windowTitle 用主进程报上来的**真实标题**（debug:window-shape 里那一条），
// 不自己按 PID 拼 —— 拼出来的字符串和窗口实际叫什么之间没有任何保证。
function hitTestScreenPoint(windowTitle, x, y) {
  const out = execFileSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command', PS_SCRIPT,
  ], {
    encoding: 'utf8',
    timeout: 20000,
    env: {
      ...process.env,
      HITTEST_TITLE: String(windowTitle),
      HITTEST_X: String(Math.round(x)),
      HITTEST_Y: String(Math.round(y)),
    },
  }).trim();
  // 找不到窗口时返回 null，调用方必须把它当**验证没做成**处理，
  // 不能当成通过 —— 这个 helper 存在的意义就是不让这类检查静默消失。
  if (out === 'NOWINDOW') return null;
  const code = Number(out);
  return Number.isFinite(code) ? code : null;
}

function hitName(code) {
  return HIT_NAMES[String(code)] || `HT(${code})`;
}

module.exports = { hitTestScreenPoint, hitName, HIT_NAMES };
