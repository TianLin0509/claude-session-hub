'use strict';
// core/paste-trapped-detector.js
// 主动检测"prompt 卡在 CLI 输入框的 paste 模式没提交"现象（2A，2026-05-05 道雪）。
//
// 用户痛点：dispatch 主路径写 prompt + \r 后，CLI（特别是 codex）有时不识别 \r，
//   prompt 留在输入框 paste 缓冲区。屏幕显示一个折叠标记如：
//     codex:  [[Pasted Content 4834 chars]]
//     claude: [Pasted text +120 lines]
//     gemini: [Pasted +N lines]
//   用户傻等几十秒发现 AI 没回答才意识到卡了。
//
// 本 detector 三层 AND 判定（防虚警）：
//   1) 时间门：dispatch 后 < 5s 不扫描（dispatch 主路径自己 paste 期间 marker 短暂
//      出现是正常的）
//   2) marker 持续：连续 ≥ 3 次 tick 都看到同一条 marker（数字 N 不变）+ 持续 ≥ 8s
//   3) 无 streaming：这段时间 PTY lastActivity 涨幅 < 200 字节（streaming 时 token
//      输出至少几 KB）
//
// API（被动 tick）：
//   detector.start(sid, dispatchTs)
//   const r = detector.tick(sid, buf, currentActivity)  // 'stuck' | 'ok' | 'unknown'
//   detector.stop(sid)
//
// 调用方（main.js dispatch 路径）每 3s 跑一次 tick，看到 'stuck' 立即推
// 'roundtable-send-stuck' IPC + setSendStatus，让 renderer 亮 [📤 发送] + 改文案。

// 三家 paste marker 通配。覆盖：
//   "[[Pasted Content 4834 chars]]"  codex
//   "[Pasted text +120 lines]"       claude code TUI
//   "[Pasted +N lines]" / 类似       gemini（实测时按需扩）
const PASTE_MARKER_REGEX = /\[+Pasted(?:\s+Content)?(?:\s+text)?\s*\+?(\d+)\s*(?:chars|lines)\]+/;

const TIME_GATE_MS = 5000;
const MIN_MARKER_OBSERVATIONS = 3;
const MIN_OBSERVATION_DURATION_MS = 8000;
const MAX_ACTIVITY_DELTA = 200;
const TAIL_SCAN_BYTES = 1024;

const _entries = new Map();

function start(sid, dispatchTs) {
  if (!sid) return;
  _entries.set(sid, {
    dispatchTs: dispatchTs || Date.now(),
    markerSeenCount: 0,
    markerNum: null,
    markerSnapshotActivity: null,
    markerFirstSeenTs: null,
  });
}

function _extractMarker(buf) {
  const tail = (buf || '').slice(-TAIL_SCAN_BYTES);
  const m = PASTE_MARKER_REGEX.exec(tail);
  return m ? { full: m[0], num: parseInt(m[1], 10) } : null;
}

// 返回值：
//   'unknown'  尚未确诊（时间门未到 / marker 刚出现 / 计数未满）
//   'ok'       未看到 marker（normal streaming or already submitted）
//   'stuck'    三层条件全满足，输入框卡 paste 模式
function tick(sid, buf, currentActivity) {
  const e = _entries.get(sid);
  if (!e) return 'unknown';
  const now = Date.now();

  // 层 1：时间门
  if (now - e.dispatchTs < TIME_GATE_MS) return 'unknown';

  // 层 2：marker 检测
  const marker = _extractMarker(buf);
  if (!marker) {
    // marker 不在 → dispatch 已 paste 完 + \r 提交成功（marker 被 streaming 内容覆盖
    //   或输入框清空），重置计数
    e.markerSeenCount = 0;
    e.markerNum = null;
    e.markerFirstSeenTs = null;
    return 'ok';
  }

  // 看到 marker
  if (e.markerNum === null || e.markerNum !== marker.num) {
    // 第 1 次看到 / N 变了（说明用户/dispatch 又往里贴了内容）→ 重置基线
    e.markerNum = marker.num;
    e.markerSeenCount = 1;
    e.markerSnapshotActivity = (typeof currentActivity === 'number') ? currentActivity : 0;
    e.markerFirstSeenTs = now;
    return 'unknown';
  }

  // N 相同 → 计数+1
  e.markerSeenCount++;

  // 层 3：所有条件满足 → 确诊 stuck
  const obsDuration = now - e.markerFirstSeenTs;
  const activityDelta = (typeof currentActivity === 'number')
    ? currentActivity - (e.markerSnapshotActivity || 0)
    : 0;
  if (
    e.markerSeenCount >= MIN_MARKER_OBSERVATIONS &&
    obsDuration >= MIN_OBSERVATION_DURATION_MS &&
    activityDelta < MAX_ACTIVITY_DELTA
  ) {
    return 'stuck';
  }
  return 'unknown';
}

function stop(sid) {
  _entries.delete(sid);
}

// 测试 helper：清空所有内部状态（unit test 隔离用）
function _resetAll() {
  _entries.clear();
}

// 测试 helper：覆盖 entry 的字段（让 unit test 不必真 sleep 8s 验证持续时长）
function _injectEntry(sid, partial) {
  const e = _entries.get(sid);
  if (e && partial) Object.assign(e, partial);
}

module.exports = {
  start,
  tick,
  stop,
  _resetAll,
  _injectEntry,
  PASTE_MARKER_REGEX,
  TIME_GATE_MS,
  MIN_MARKER_OBSERVATIONS,
  MIN_OBSERVATION_DURATION_MS,
  MAX_ACTIVITY_DELTA,
};
