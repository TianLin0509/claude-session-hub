'use strict';
// 圆桌记忆 · checkpoint trigger（主进程，plan §5.2 / §10 #1+#6）
//
// 职责：
//   1. 每个圆桌轮完成后调 maybeRunCheckpoint(meetingId, scene, projectCwd, turn)
//   2. 判断是否触发：
//      - 必要：state.last_user_msg_count ≥ 3
//      - 显式：用户说"记一下/总结一下"（force=true）
//      - 防抖：距 last_checkpoint_at 不到 cooldown_ms 跳过
//      - 互斥：.checkpoint.lock 文件存在跳过（前一个 worker 还在跑）
//   3. fork core/checkpoint-worker.js（注入 ARENA_CHECKPOINT_* env）
//   4. 监听 worker exit code → 失败时已由 worker 自己 markFailure，主进程主要做日志/IPC 广播

const fs = require('fs');
const path = require('path');
const { fork } = require('child_process');
const ckptState = require('./checkpoint-state.js');

const DEFAULT_USER_MSG_THRESHOLD = 3;
const DEFAULT_COOLDOWN_MS = 60 * 1000; // 1 分钟（plan §5.2）
const STALE_LOCK_MS = 5 * 60 * 1000;   // 5 分钟以上的 lock 视为僵尸（worker 崩了）

function lockFilePath(projectCwd, scene) {
  return path.join(projectCwd, '.arena', 'rooms', scene, '.checkpoint.lock');
}

// 读 lock 内容（含 owner pid + token），损坏返回 null
function _readLockContent(fp) {
  try {
    if (!fs.existsSync(fp)) return null;
    return JSON.parse(fs.readFileSync(fp, 'utf-8'));
  } catch {
    return null;
  }
}

// 检查 PID 是否仍存活（Windows + Unix 都用 process.kill(pid, 0)）
function _isPidAlive(pid) {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // ESRCH = 进程不存在；EPERM = 存在但无权限（视为存活）
    return e.code === 'EPERM';
  }
}

// [Bug 6 fix · 多路评审 P2] isLocked 改用 PID 存活校验 + mtime 兜底
//   1. lock 文件不存在 → 未锁
//   2. lock 文件存在但 owner PID 已死 → 视为僵尸，清除返回未锁
//   3. lock 文件存在且 mtime > STALE_LOCK_MS → 兜底僵尸清除（防 PID 复用）
//   4. 否则视为锁定
function isLocked(projectCwd, scene) {
  const fp = lockFilePath(projectCwd, scene);
  if (!fs.existsSync(fp)) return false;
  const content = _readLockContent(fp);
  // PID 存活校验
  if (content && typeof content.pid === 'number' && !_isPidAlive(content.pid)) {
    try { fs.unlinkSync(fp); } catch {}
    return false;
  }
  // mtime 兜底（防 PID 复用让僵尸看起来"活着"）
  try {
    const st = fs.statSync(fp);
    if (Date.now() - st.mtimeMs > STALE_LOCK_MS) {
      fs.unlinkSync(fp);
      return false;
    }
  } catch {}
  return true;
}

// [Bug 6 fix 续] 原子建锁：fs.openSync('wx') 文件已存在直接 EEXIST。
// 内容写入 owner pid + 唯一 token，释放时只允许 owner 删除。
function writeLock(projectCwd, scene, pid) {
  const fp = lockFilePath(projectCwd, scene);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  const token = `${pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const content = JSON.stringify({ pid, token, at: new Date().toISOString() });
  // 'wx' = exclusive create; 已存在抛 EEXIST
  let fd;
  try {
    fd = fs.openSync(fp, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') {
      // 罕见：另一线程刚写过；调用方 isLocked 检查应该已经 catch
      throw new Error('lock already held: ' + fp);
    }
    throw e;
  }
  try {
    fs.writeSync(fd, content);
  } finally {
    fs.closeSync(fd);
  }
  return { filePath: fp, token };
}

// [Bug 11 fix · v2 P2 + Bug 16 fix · v3 P2] fork 成功后用 worker pid 覆盖 lock 内容；
// Bug 16 修复：用 'r+' 模式打开（要求文件存在），如果 worker 已极快 unlink lock，
// open 抛 ENOENT 直接返回 false——避免 writeFileSync 把 unlink 后的文件"复活"造成 stale lock。
function updateLockWithChildPid(filePath, token, childPid) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r+'); // 要求已存在；ENOENT 抛
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, 4096, 0);
    const content = JSON.parse(buf.slice(0, n).toString('utf-8'));
    if (!content || content.token !== token) return false; // 不是我的 lock
    content.pid = childPid;
    content.parent_pid = content.parent_pid || process.pid;
    content.updated_at = new Date().toISOString();
    const newContent = JSON.stringify(content);
    fs.ftruncateSync(fd, 0);
    fs.writeSync(fd, newContent, 0);
    return true;
  } catch (e) {
    if (e.code === 'ENOENT') return false; // worker 已 unlink lock — 不复活
    return false;
  } finally {
    if (fd != null) {
      try { fs.closeSync(fd); } catch {}
    }
  }
}

// [Bug 6 fix 续] 释放时校验 token——只允许 owner 删
function releaseLockOwner(filePath, token) {
  try {
    const content = _readLockContent(filePath);
    if (!content || content.token !== token) {
      // 不是我的 lock（可能僵尸清理后被别人重写） → 不删
      return false;
    }
    fs.unlinkSync(filePath);
    return true;
  } catch {
    return false;
  }
}

// 判断是否触发（不真 fork，只返回 reason）
function shouldRun({ projectCwd, scene, force = false, userMsgThreshold = DEFAULT_USER_MSG_THRESHOLD, cooldownMs = DEFAULT_COOLDOWN_MS }) {
  if (!projectCwd || !scene) return { run: false, reason: 'missing projectCwd/scene' };
  if (isLocked(projectCwd, scene)) return { run: false, reason: 'locked (worker running)' };
  const state = ckptState.readState(projectCwd, scene);
  // cooldown 防抖
  if (state.last_checkpoint_at) {
    const elapsed = Date.now() - Date.parse(state.last_checkpoint_at);
    if (elapsed < cooldownMs && !force) {
      return { run: false, reason: `cooldown (${Math.round(elapsed / 1000)}s/${Math.round(cooldownMs / 1000)}s)` };
    }
  }
  if (force) return { run: true, reason: 'explicit (user said "记一下")' };
  if ((state.last_user_msg_count || 0) >= userMsgThreshold) {
    return { run: true, reason: `user_msg_count >= ${userMsgThreshold}` };
  }
  return { run: false, reason: `user_msg_count ${state.last_user_msg_count || 0} < ${userMsgThreshold}` };
}

// 主入口：每轮 user prompt 完成时调
//
// args: { meetingId, scene, projectCwd, turn, identities, force, onComplete?, onError? }
//   Phase 3：identities 为字符串数组，如 ['claude-opus-4-7','gemini-3-pro','codex-gpt-5-2']。
//   缺省（main.js 没传）→ env 留空 → worker 自己用 listAllIdentities 扫 memDir 兜底。
//
// 返回 { spawned: bool, reason: string, child?: ChildProcess }
function maybeRunCheckpoint(args) {
  const { projectCwd, scene, turn, identities, force = false, onComplete, onError } = args || {};
  const { run, reason } = shouldRun({ projectCwd, scene, force });
  if (!run) return { spawned: false, reason };

  // [Bug 6 fix · 多路评审 P2] 原子建锁；EEXIST 视为另一并发触发已抢到，跳过
  let lockInfo;
  try {
    lockInfo = writeLock(projectCwd, scene, process.pid);
  } catch (e) {
    return { spawned: false, reason: 'writeLock failed (EEXIST race?): ' + e.message };
  }
  const lockPath = lockInfo.filePath;
  const lockToken = lockInfo.token;

  // [Bug 20 fix · v5 P1 · Codex] spawn 前清旧 sidecar marker，避免上次残留让本次真实失败漏报
  const sidecarFp = path.join(projectCwd, '.arena', 'rooms', scene, '.checkpoint.failure-reported');
  try { if (fs.existsSync(sidecarFp)) fs.unlinkSync(sidecarFp); } catch {}

  const workerPath = path.resolve(__dirname, '..', 'checkpoint-worker.js');
  // Phase 3：identities 是 main.js 从 meeting.subSessions 派生的当前圆桌身份列表。
  //   留空时 worker 自己 listAllIdentities 扫 memDir，覆盖文件已存在但本轮未参与的历史身份。
  const identitiesCsv = Array.isArray(identities) && identities.length > 0 ? identities.join(',') : '';

  let child;
  try {
    child = fork(workerPath, [], {
      env: {
        ...process.env,
        ARENA_CHECKPOINT_PROJECT_CWD: projectCwd,
        ARENA_CHECKPOINT_SCENE: scene,
        ARENA_CHECKPOINT_TURN: turn != null ? String(turn) : '',
        ARENA_CHECKPOINT_IDENTITIES: identitiesCsv,
        // 把 lock token 透传给 worker，worker 释放 lock 时校验 owner（防孤儿 worker 删新 worker 锁）
        ARENA_CHECKPOINT_LOCK_TOKEN: lockToken,
      },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      silent: true,
    });
    // 注：Electron 主进程 child_process.fork 自动把 ELECTRON_RUN_AS_NODE=1 透传给子进程
    // （Electron 内部对 fork 的特殊处理，已实测）
  } catch (e) {
    releaseLockOwner(lockPath, lockToken);
    return { spawned: false, reason: 'fork failed: ' + e.message };
  }

  // [Bug 11 fix · v2 P2] fork 成功 → 立即用 worker pid 覆盖 lock 内容
  if (child.pid) {
    updateLockWithChildPid(lockPath, lockToken, child.pid);
  }

  let stderrBuf = '';
  let stdoutBuf = '';
  if (child.stderr) child.stderr.on('data', d => { stderrBuf += d.toString(); });
  if (child.stdout) child.stdout.on('data', d => { stdoutBuf += d.toString(); });

  // [Bug 10 fix · v2 P1] worker 通过 IPC 让主进程串行化写 state（消除跨进程 RMW race）
  // [Bug 15 fix · v3 P2] 用 flag 记录是否已收到 IPC 失败/成功上报，避免 exit handler 双倍计数
  let _stateReported = false;
  child.on('message', (msg) => {
    if (!msg || typeof msg !== 'object') return;
    try {
      if (msg.type === 'markCheckpoint') {
        ckptState.markCheckpoint(projectCwd, scene, msg.turn != null ? String(msg.turn) : null, {
          startCount: typeof msg.startCount === 'number' ? msg.startCount : 0,
        });
        _stateReported = true;
      } else if (msg.type === 'markFailure') {
        ckptState.markFailure(projectCwd, scene, msg.reason || 'worker reported failure');
        _stateReported = true;
      }
    } catch (e) {
      console.warn('[mem-ckpt] main.process state write from IPC failed:', e.message);
    }
  });

  child.on('error', e => {
    releaseLockOwner(lockPath, lockToken);
    if (typeof onError === 'function') onError(e);
  });
  child.on('exit', (code, signal) => {
    releaseLockOwner(lockPath, lockToken);
    // [Bug 15 + Bug 19 + Bug 20 fix · v3/v4/v5] worker 异常退出兜底：
    //   _stateReported=true 表示已通过 IPC 上报 → 不再写
    //   sidecar 文件存在 + token 匹配本次 lockToken → worker 已通过 fallback 本地写过 → 不再写
    //   sidecar token 不匹配（陈旧 marker）→ 视为不存在，正常兜底；并清掉它
    //   consume sidecar 防止下次 worker 误读
    if (code !== 0 && !_stateReported) {
      const sidecarFp = path.join(projectCwd, '.arena', 'rooms', scene, '.checkpoint.failure-reported');
      let sidecarValid = false;
      try {
        if (fs.existsSync(sidecarFp)) {
          let tokenMatch = false;
          try {
            const content = JSON.parse(fs.readFileSync(sidecarFp, 'utf-8'));
            tokenMatch = !!(content && content.token && content.token === lockToken);
          } catch {}
          fs.unlinkSync(sidecarFp); // 不论 token 是否匹配都 consume（防陈旧）
          sidecarValid = tokenMatch;
        }
      } catch {}
      if (!sidecarValid) {
        try { ckptState.markFailure(projectCwd, scene, `worker exit ${code}/${signal}`); }
        catch {}
      }
    } else {
      // 成功路径或已上报 → 也清 sidecar 防漏（worker 可能已经写过又 ack 成功）
      const sidecarFp = path.join(projectCwd, '.arena', 'rooms', scene, '.checkpoint.failure-reported');
      try { if (fs.existsSync(sidecarFp)) fs.unlinkSync(sidecarFp); } catch {}
    }
    const result = { code, signal, stderrTail: stderrBuf.slice(-2000), stdoutTail: stdoutBuf.slice(-2000) };
    if (code === 0) {
      if (typeof onComplete === 'function') onComplete(result);
    } else {
      if (typeof onError === 'function') onError(new Error(`worker exit ${code}/${signal}`), result);
    }
  });

  return { spawned: true, reason, child, lockPath, lockToken };
}

module.exports = {
  DEFAULT_USER_MSG_THRESHOLD,
  DEFAULT_COOLDOWN_MS,
  STALE_LOCK_MS,
  lockFilePath,
  isLocked,
  writeLock,
  releaseLockOwner,
  updateLockWithChildPid,
  shouldRun,
  maybeRunCheckpoint,
};
