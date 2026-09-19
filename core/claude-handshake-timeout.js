'use strict';

/**
 * Claude 握手（initialize）的等待预算，按要载入的历史体积给。
 *
 * 2026-09-18 真实事故：从一个 17.1 MB / 884 条记录的会话分支出群聊成员，
 * `claude --resume <父会话> --fork-session` 必须把父会话整个读进来再写成新会话文件，
 * 实测 124.6 秒才连上。而 Hub 的 initialize 等待写死 60 秒（main/claude-stream-client.js），
 * 于是：60 秒判连接失败 → 群聊那条提交被标成「待核对」→ 侧栏亮异常 →
 * 一分钟后引擎其实连上了、照常把这一轮跑完。
 *
 * 也就是说，**历史越大越必然踩**，而踩到的表现是「报错，然后自己好了」——
 * 最容易让人误以为功能坏了的那一种。
 *
 * 全新会话没有历史要载入，仍然是原来的 60 秒，行为不变；只有 resume / fork
 * 才按父会话 transcript 的字节数放宽。每 MB 给多少是从上面那次实测反推的：
 * 17.1 MB 需要 ≥125 秒，约 7.3 秒/MB；这里给 25 秒/MB（约 3 倍余量），
 * 因为磁盘忙、模型冷启动都会让它更慢，而**等久一点只是慢，判错则是丢状态**。
 */

const fs = require('fs');
const { findTranscriptByCCSessionId } = require('./claude-transcript-locator.js');

// 全新会话的基准，等于历史行为。
const BASE_MS = 60_000;
// 每 MB 历史额外给的时间。
const PER_MB_MS = 25_000;
// 再大也不无限等：超过这个数说明真的不对劲，该报错让人看见。
const MAX_MS = 10 * 60_000;
const MB = 1024 * 1024;

function initializeTimeoutMsForBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return BASE_MS;
  return Math.min(MAX_MS, Math.round(BASE_MS + (size / MB) * PER_MB_MS));
}

function formatMb(bytes) {
  const size = Number(bytes) || 0;
  return size >= MB ? `${(size / MB).toFixed(1)} MB` : `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * 算出这次启动该等多久，并给一句能放进界面的说明。
 *
 * 找不到父会话文件不是错误：可能是刚迁过目录、或者 provider 把它放在别处。
 * 那种情况回落到基准值，和以前一模一样。
 */
function resolveHandshakeBudget({ resumeSessionId = '', homeDir, statFile } = {}) {
  const id = String(resumeSessionId || '').trim();
  if (!id) return { timeoutMs: BASE_MS, bytes: 0, transcriptPath: null, reason: null };
  let transcriptPath = null;
  let bytes = 0;
  try {
    transcriptPath = findTranscriptByCCSessionId(id, homeDir);
    if (transcriptPath) {
      const stat = typeof statFile === 'function' ? statFile(transcriptPath) : fs.statSync(transcriptPath);
      bytes = Number(stat && stat.size) || 0;
    }
  } catch {
    // 量不到就按基准来；为了量一个超时值而让启动失败是本末倒置。
    transcriptPath = null;
    bytes = 0;
  }
  const timeoutMs = initializeTimeoutMsForBytes(bytes);
  // 载入大历史时界面要说人话：它正在干什么、大概多少量，而不是干等「等待连接响应」。
  const reason = bytes >= MB
    ? `正在载入历史（${formatMb(bytes)}），大会话可能要一两分钟`
    : null;
  return { timeoutMs, bytes, transcriptPath, reason };
}

module.exports = {
  BASE_MS,
  MAX_MS,
  PER_MB_MS,
  formatMb,
  initializeTimeoutMsForBytes,
  resolveHandshakeBudget,
};
