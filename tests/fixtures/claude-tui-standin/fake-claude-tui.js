'use strict';
// Claude Code 形态（主屏、不进备用屏幕）的输出替身，只用于测「点后台」的开销（2026-10-13）。
// 启动时先打印一段长对话历史（FAKE_HISTORY_KB，默认 300KB），之后像流式回答一样逐字追加，并重画底部的
// 状态行与输入框。终端尺寸一变，就清屏、清回滚区并把整段历史按新宽度重印一遍——长对话的 CLI 改尺寸时
// 的最坏情况。10 月后台路径在卡片视图里把 PTY 停在 80×24，点后台时才改到实际尺寸，正好触发这次重印。
const out = process.stdout;
const ESC = '\x1b[';
const PARA = [
  '## 下行调度复盘', '物理层下行先做同步信号检测，再解主信息块，随后按系统信息配置初始接入。',
  '- 上行随机接入用前导码与定时提前量完成粗同步；', '- 调度器按信道质量分配资源块，HARQ 负责重传合并；',
  '```python', 'def pf_metric(rate, avg): return rate / max(avg, 1e-6)', '```',
  '比例公平的权重随平均速率自适应，小区边缘用户在长时间尺度上仍能拿到资源。',
];
const historyBytes = Number(process.env.FAKE_HISTORY_KB || 300) * 1024;
const intervalMs = Number(process.env.FAKE_TUI_INTERVAL_MS || 42);
let cols = out.columns || 120;
const history = [];
for (let n = 0, i = 0; n < historyBytes; i++) {
  const line = (i % 9 === 0 ? `\n⏺ 第 ${Math.floor(i / 9) + 1} 轮回答\n` : '') + PARA[i % PARA.length];
  history.push(line); n += Buffer.byteLength(line);
}
const color = line => line.startsWith('##') ? `${ESC}1;38;2;215;119;87m${line}${ESC}0m`
  : line.startsWith('-') ? `${ESC}38;2;201;209;217m${line}${ESC}0m`
  : line.startsWith('```') || line.startsWith('def ') ? `${ESC}38;2;121;192;255m${line}${ESC}0m` : line;
const printHistory = () => history.map(color).join('\r\n').replace(/(?<!\r)\n/g, '\r\n') + '\r\n';
let answer = '', tick = 0, pos = 0;
const SPIN = '✻✽✶✳✢·';
function dynamic() {
  const w = Math.max(20, cols - 4);
  return `${ESC}2K${ESC}38;2;215;119;87m${SPIN[tick % SPIN.length]} 思考中… (${(tick * intervalMs / 1000).toFixed(0)}s)${ESC}0m\r\n`
    + `${ESC}2K╭${'─'.repeat(w)}╮\r\n${ESC}2K│ > ${' '.repeat(w - 3)}│\r\n${ESC}2K╰${'─'.repeat(w)}╯`;
}
function redrawAll() {
  out.write(`${ESC}?2026h${ESC}2J${ESC}3J${ESC}H` + printHistory() + answer + '\r\n' + dynamic() + `${ESC}?2026l`);
}
function step() {
  tick++;
  const add = PARA[1].slice(pos % PARA[1].length, pos % PARA[1].length + 2); pos += 2;
  answer += add;
  if (answer.length > 60) { history.push(answer); answer = ''; }
  // 光标回到动态区顶部（回答行 + 3 行输入框 + 1 行状态），整块重画——Ink 的做法。
  out.write(`${ESC}?2026h${ESC}4A\r${ESC}J` + (answer ? `${ESC}2K${answer}` : '') + '\r\n' + dynamic() + `${ESC}?2026l`);
}
out.write(`${ESC}?25l`); redrawAll();
out.on('resize', () => { cols = out.columns || cols; redrawAll(); });
const timer = setInterval(step, intervalMs);
const stopAfter = Number(process.env.FAKE_TUI_STOP_AFTER_MS || 0);
if (stopAfter > 0) setTimeout(() => clearInterval(timer), stopAfter);
process.stdin.on('data', () => {}); process.stdin.resume();
