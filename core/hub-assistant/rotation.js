'use strict';
// 助理换班策略（纯函数，便于测试与调参）。
// 业界做法：快满时压缩（Claude Code ~95%、Codex ≤90%）只防溢出；OpenClaw 按天/空闲重开，记忆放文件。
// 助理追求速度，所以以「空闲换班」为主、按后端的大小上限兜底；上下文太小的会话不换，避免白白丢掉近况。
const IDLE_MS = 2 * 3600 * 1000;
const DAILY_HOUR = 4;
const MIN_TOKENS = 30000;
const CAP_BY_KIND = { claude: 150000 };
const DEFAULT_CAP = 100000;

function capFor(kind, contextMax) {
  const override = Number(process.env.HUB_ASSISTANT_ROTATE_TOKENS); // 仅供实测压低阈值
  if (override > 0) return override;
  const base = CAP_BY_KIND[kind] || DEFAULT_CAP;
  return typeof contextMax === 'number' && contextMax > 0 ? Math.min(base, Math.floor(contextMax * 0.5)) : base;
}
function dailyBoundary(now, hour = DAILY_HOUR) {
  const d = new Date(now); d.setHours(hour, 0, 0, 0);
  if (d.getTime() > now) d.setDate(d.getDate() - 1);
  return d.getTime();
}
// 返回换班原因：size（上下文到上限）、idle（空闲超过 2 小时）、daily（跨过每天 4 点），不需要则为 null。
function rotationReason({ tokens, lastActiveAt, now = Date.now(), kind, contextMax }) {
  if (tokens >= capFor(kind, contextMax)) return 'size';
  if (!tokens || tokens < Math.min(MIN_TOKENS, capFor(kind, contextMax)) || !lastActiveAt) return null;
  if (now - lastActiveAt >= IDLE_MS) return 'idle';
  if (lastActiveAt < dailyBoundary(now)) return 'daily';
  return null;
}
const REASON_LABELS = { size: '上下文到上限', idle: '空闲超过 2 小时', daily: '跨过每天 4 点', manual: '手动新开' };
module.exports = { IDLE_MS, DAILY_HOUR, MIN_TOKENS, capFor, dailyBoundary, rotationReason, REASON_LABELS };
