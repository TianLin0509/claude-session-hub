'use strict';

// 活实例登记表。Hub 本来就在 <dataDir>/diagnostics/ 下每 10 秒写一次心跳
// （见 core/process-lifecycle-journal.js），多实例共用同一个数据目录，
// 所以这些文件天然就是一张「本机有哪些 Hub、哪些还活着」的名册，白捡的。
//
// 这张表撑起了整个回收功能里最硬的一条判据：
//   心跳文件在、进程没了 => 那个 Hub 已经退出 => 它名下还在跑的东西全是垃圾。
//
// 判死必须极其保守。「心跳很久没更新」不算死——Hub 卡住时心跳也会停，
// 但它的会话还在跑，误判成死的就会杀掉用户正在干的活。只有进程真的不在了，
// 或者那个 PID 已经被别的程序复用了，才算死。

const fs = require('fs');
const path = require('path');
const os = require('os');

const HEARTBEAT_SUFFIX = '.heartbeat.json';
const HEARTBEAT_PREFIX = 'process-lifecycle-';

function resolveDataDir(options = {}) {
  const env = (options.env || process.env) || {};
  return path.resolve(
    options.dataDir
      || env.CLAUDE_HUB_DATA_DIR
      || path.join((options.homedir || os.homedir)(), '.claude-session-hub'),
  );
}

function parseHeartbeatFile(fsRef, filePath) {
  let raw;
  try {
    raw = fsRef.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    // 心跳是「读-改-写」的小文件，正好读到写一半是正常的，跳过这轮即可。
    return null;
  }
  const pid = Number(data && data.pid);
  if (!Number.isFinite(pid) || pid <= 0) return null;

  const epochMs = Number(data.epochMs) || Date.parse(data.ts || '') || 0;
  return {
    pid,
    ppid: Number(data.ppid) || 0,
    lastBeatAt: epochMs,
    lastBeatIso: String(data.ts || ''),
    event: String(data.event || ''),
    phase: String(data.phase || ''),
    cleanExit: data.cleanExit === true,
    windowCount: Number(data.windowCount) || 0,
    uptimeSec: Number(data.uptimeSec) || 0,
    // 自报的退出：event=app-quit / phase=quit。这类是干净退出，
    // 留下的残留最典型（Hub 走了，孙辈进程没人管）。
    selfReportedQuit: String(data.event || '') === 'app-quit' || String(data.phase || '') === 'quit',
    file: filePath,
  };
}

function readHubInstances(options = {}) {
  const fsRef = options.fsRef || fs;
  const dataDir = resolveDataDir(options);
  const diagnosticsDir = path.join(dataDir, 'diagnostics');

  let entries;
  try {
    entries = fsRef.readdirSync(diagnosticsDir);
  } catch {
    return { dataDir, diagnosticsDir, instances: [] };
  }

  const instances = [];
  for (const entry of entries) {
    if (!entry.startsWith(HEARTBEAT_PREFIX) || !entry.endsWith(HEARTBEAT_SUFFIX)) continue;
    const record = parseHeartbeatFile(fsRef, path.join(diagnosticsDir, entry));
    if (record) instances.push(record);
  }

  instances.sort((a, b) => b.lastBeatAt - a.lastBeatAt);
  return { dataDir, diagnosticsDir, instances };
}

// 把心跳记录和「现在真正在跑的进程」对上号。
//
// isHubProcess 由调用方注入：光看 PID 存不存在不够，PID 是会被系统回收复用的，
// 必须确认占着这个 PID 的确实还是一个 Hub 进程，否则会把某个刚启动的无关程序
// 误认成「Hub 还活着」，进而把真正该回收的东西一路保护起来。
function classifyInstances(records, options = {}) {
  const byPid = options.byPid || new Map();
  const isHubProcess = typeof options.isHubProcess === 'function' ? options.isHubProcess : () => false;
  const now = Number(options.now) || Date.now();

  const alive = [];
  const dead = [];

  for (const record of records) {
    const proc = byPid.get(record.pid);
    const stillHub = !!proc && isHubProcess(proc);
    // 进程启动时间晚于最后一次心跳 => 这个 PID 已经被复用了，原实例早没了。
    const pidReused = !!proc && record.lastBeatAt > 0 && proc.startedAt > record.lastBeatAt + 5_000;

    if (stillHub && !pidReused) {
      alive.push({
        ...record,
        alive: true,
        startedAt: proc.startedAt,
        beatAgeMs: record.lastBeatAt > 0 ? Math.max(0, now - record.lastBeatAt) : null,
      });
    } else {
      dead.push({
        ...record,
        alive: false,
        pidReused,
        // 说明为什么判它死了，界面上要原样展示给用户看。
        deadReason: pidReused
          ? 'pid-reused'
          : (record.selfReportedQuit ? 'self-reported-quit' : 'process-gone'),
        goneForMs: record.lastBeatAt > 0 ? Math.max(0, now - record.lastBeatAt) : null,
      });
    }
  }

  return { alive, dead };
}

module.exports = {
  HEARTBEAT_PREFIX,
  HEARTBEAT_SUFFIX,
  classifyInstances,
  parseHeartbeatFile,
  readHubInstances,
  resolveDataDir,
};
