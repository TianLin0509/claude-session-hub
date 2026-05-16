'use strict';
// 圆桌记忆 · checkpoint-state.json 读写（plan §4.1）
//
// 路径：<projectCwd>/.arena/rooms/{scene}/checkpoint-state.json
// 文件 < 1KB，每次 user msg / worker 完成都覆写（不是 append）
// 原子写入：write tmp + rename
//
// schema：
// {
//   "last_user_msg_count": 2,           // 自上次 checkpoint 以来用户发言数
//   "last_token_count": 4500,           // 累计 token（可选估算）
//   "last_checkpoint_at": "2026-...",   // 上次 worker 跑完的 ISO 时间
//   "last_checkpoint_turn": "t6",       // 上次 worker 跑时对应 turn 号
//   "consecutive_failures": 0,          // 连续失败次数（≥5 触发红色状态灯）
//   "last_failure_reason": null,        // 最近一次失败原因（hover 状态灯显示）
// }

const fs = require('fs');
const path = require('path');

function stateFilePath(projectCwd, scene) {
  if (!projectCwd || !scene) return null;
  return path.join(projectCwd, '.arena', 'rooms', scene, 'checkpoint-state.json');
}

const DEFAULT_STATE = {
  last_user_msg_count: 0,
  last_token_count: 0,
  last_checkpoint_at: null,
  last_checkpoint_turn: null,
  consecutive_failures: 0,
  last_failure_reason: null,
};

function readState(projectCwd, scene) {
  const fp = stateFilePath(projectCwd, scene);
  if (!fp || !fs.existsSync(fp)) return { ...DEFAULT_STATE };
  try {
    const raw = fs.readFileSync(fp, 'utf-8');
    const parsed = JSON.parse(raw);
    return { ...DEFAULT_STATE, ...parsed };
  } catch {
    // 损坏 → 返回默认（不抛，避免 worker 链断裂）
    return { ...DEFAULT_STATE };
  }
}

// 原子写入：write tmp + rename。
// [Bug 8 fix · 多路评审 v2 P1] 移除 unlink，直接 renameSync——
// Node 18+ 在 Windows 上 renameSync 用 MoveFileEx + MOVEFILE_REPLACE_EXISTING，原子覆盖目标。
// 之前的 "if exists unlink + rename" 在两步之间存在窗口，并发 readState 会读到默认值（count=0）。
function writeState(projectCwd, scene, state) {
  const fp = stateFilePath(projectCwd, scene);
  if (!fp) throw new Error('writeState: invalid projectCwd/scene');
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const tmp = fp + '.tmp.' + process.pid + '.' + Date.now();
  const merged = { ...DEFAULT_STATE, ...state };
  fs.writeFileSync(tmp, JSON.stringify(merged, null, 2), 'utf-8');
  fs.renameSync(tmp, fp);
  return fp;
}

// 增量 patch（merge）—— 只改部分字段
function patchState(projectCwd, scene, patch) {
  const cur = readState(projectCwd, scene);
  return writeState(projectCwd, scene, { ...cur, ...patch });
}

// user 发言计数 +1（每次 dispatch turn 时调）
function bumpUserMsgCount(projectCwd, scene) {
  const cur = readState(projectCwd, scene);
  cur.last_user_msg_count = (cur.last_user_msg_count || 0) + 1;
  writeState(projectCwd, scene, cur);
  return cur;
}

// worker 跑完后标记 checkpoint。
// [Bug 2 fix · 2026-05-07 多路评审 P0] 不再无脑 reset count=0；改为"减去 worker 启动时快照"，
// 保留 worker 跑期间主进程 bump 的增量（避免 worker 5s 窗口内用户发言计数被覆盖）。
//
// args: { startCount } —— worker 启动时 readState 的 last_user_msg_count 快照
function markCheckpoint(projectCwd, scene, turnNum, opts = {}) {
  const cur = readState(projectCwd, scene);
  const startCount = typeof opts.startCount === 'number' ? opts.startCount : (cur.last_user_msg_count || 0);
  // 当前 count - 快照 = worker 跑期间 bump 的增量；不能 < 0
  const delta = Math.max(0, (cur.last_user_msg_count || 0) - startCount);
  cur.last_user_msg_count = delta;
  cur.last_token_count = 0;
  cur.last_checkpoint_at = new Date().toISOString();
  cur.last_checkpoint_turn = turnNum != null ? String(turnNum) : null;
  cur.consecutive_failures = 0;
  cur.last_failure_reason = null;
  writeState(projectCwd, scene, cur);
  return cur;
}

// worker 失败时 +1 失败计数（不 reset user msg count，保留下次重跑机会）
function markFailure(projectCwd, scene, reason) {
  const cur = readState(projectCwd, scene);
  cur.consecutive_failures = (cur.consecutive_failures || 0) + 1;
  cur.last_failure_reason = String(reason || 'unknown').slice(0, 200);
  writeState(projectCwd, scene, cur);
  return cur;
}

module.exports = {
  DEFAULT_STATE,
  stateFilePath,
  readState,
  writeState,
  patchState,
  bumpUserMsgCount,
  markCheckpoint,
  markFailure,
};
