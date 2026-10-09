'use strict';
// 公司 Code Agent 的信任框（2026-10-07 公司第二轮录屏的版式）用 opentui 风格的字节画出来：
// 每个格子单独定位、单独上色，先画整帧，再只重画高亮变化的格子。
// 旧的字节重放拼不出整行；终端模拟器还原屏幕后必须能认出来并给出正确按键。
const assert = require('assert');
const { createTrustScreen, detectTrustDialogInLines, detectClaudeTrustDialog } = require('../core/claude-trust-dialog.js');

const SCREEN = [
  '   Accessing workspace:                                                                 ✕',
  '',
  '    C:\\Users\\<USER>\\AppData\\Local\\Temp\\hub-acceptance-x\\work-a',
  "    Quick safety check: Is this a project you created or one you trust? If not, review what's in this folder first.",
  '    CodeAgent will load .cac contents (skill, mcp, hook, command, etc.) and be able to read, edit, and execute files',
  '',
  '    ⚠ This folder runs commands to mint HTTP headers (headersHelper), declared in .mcp.json.',
  '    No additional risks detected.',
  '',
  '    > Yes, I trust this folder',
  '      No, exit',
  '',
  '   ────────────────────────────────────────────────────────────',
  '   Select option ↑ ↓ | Scroll risks Ctrl+↑ ↓ | Confirm Enter | No, exit Esc',
];

// 逐格输出：每个字符前都带绝对定位和真彩色前景/背景，与 opentui 的整帧输出同形。
function cellFrame(lines, top = 3) {
  let out = '\x1b[?2026h';
  lines.forEach((line, r) => {
    [...line].forEach((ch, c) => {
      out += `\x1b[${top + r};${c + 1}H\x1b[38;2;${200 + (c % 50)};200;200m\x1b[48;2;12;12;12m${ch}`;
    });
  });
  return out + '\x1b[0m\x1b[?2026l';
}

(async () => {
  const screen = createTrustScreen();
  assert.ok(screen, '终端模拟器可用');
  // 先是 PowerShell 和启动命令，再是整帧（分成多块到达），模拟真实的 PTY 分片。
  screen.write('PS C:\\work> codeagent --disable-update --skip-safe-check --model GLM-5.2-WX-Auto\r\n');
  const frame = cellFrame(SCREEN);
  for (let i = 0; i < frame.length; i += 1777) screen.write(frame.slice(i, i + 1777));
  const dialog = detectTrustDialogInLines(await screen.lines());
  assert.ok(dialog, '认出信任框');
  assert.deepStrictEqual(dialog.keys, ['\r'], '默认高亮在 Yes：直接回车');

  // 字节重放版本在逐格上色时同样要能工作，否则说明 fixture 不够「opentui」。
  // （不强求：这里只记录它是否认得出，供对照。）
  const legacy = detectClaudeTrustDialog(frame);
  console.log('  旧的字节重放能否认出：', legacy ? '能' : '不能');

  // 高亮被移到 No：只重画两行的前缀格子。必须先上移再回车。
  const yesRow = 3 + SCREEN.indexOf('    > Yes, I trust this folder');
  screen.write(`\x1b[${yesRow};5H\x1b[48;2;12;12;12m `);
  screen.write(`\x1b[${yesRow + 1};5H\x1b[48;2;12;12;12m>`);
  const moved = detectTrustDialogInLines(await screen.lines());
  assert.ok(moved, '高亮移动后仍认得出');
  assert.deepStrictEqual(moved.keys, ['\x1b[A', '\r'], '高亮在 No：先上移一行再回车');

  // 普通输入框画面不能误判。
  const idle = createTrustScreen();
  idle.write(cellFrame(['│ > Anything I can assist you with? (Ctrl+J 换行)', '│ Bypass (Cycle shift+tab) | GLM-5.2-WX-Auto']));
  assert.strictEqual(detectTrustDialogInLines(await idle.lines()), null, '输入框不是信任框');
  // 回答里提到 trust 也不能误判（没有确认底栏）。
  const talk = createTrustScreen();
  talk.write('> Yes, I trust this folder is the option name in Claude Code.\r\nQuick safety check is its title.\r\n');
  assert.strictEqual(detectTrustDialogInLines(await talk.lines()), null, '没有确认底栏就不动手');
  screen.dispose(); idle.dispose(); talk.dispose();
  console.log('unit-codeagent-trust-screen: OK');
})().catch(error => { console.error(error); process.exit(1); });
