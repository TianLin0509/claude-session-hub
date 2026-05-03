'use strict';
// LinDangAgent 桥接（2026-05-03 重构）：
// 旧入口 `python -m services.fetch_for_arena ...` 已下线（services 目录已删）。
// 新入口：`python data_query.py <op> [args...]`，详见 C:\LinDangAgent\data\AGENT_GUIDE.md
//
// 对外接口：
//   fetchSnapshot(symbol)        — 主用：一键拉 gate+basic+price+indicators+flow
//   fetchField(op, symbol, extra) — 按需取单字段（op = financial/flow/indicators/dragon-tiger/...）
//   fetchStock(symbol, name)     — 兼容老接口，内部 = fetchSnapshot
//   fetchConcept / fetchSector   — 已下线，返回错误（依赖 Stock_top10 已删）

const { spawn } = require('child_process');

const LINDANG_DIR = process.env.LINDANG_DIR || 'C:\\LinDangAgent';
const PYTHON_BIN = process.env.LINDANG_PYTHON
  || 'C:\\Users\\lintian\\AppData\\Local\\Programs\\Python\\Python312\\python.exe';

// data_query.py 各子命令的合理超时（ms）。snapshot 拉得多，给宽一点
const OP_TIMEOUTS = {
  'snapshot': 90000,
  'financial': 60000,
  'price': 30000,
  'indicators': 30000,
  'qmt-realtime': 15000,
  'qmt-kline': 15000,
  'qmt-financial': 60000,
  'qmt-sector': 30000,
  // 其他单字段查询默认 30s
};

function _runDataQuery(op, args, timeoutMs = null) {
  if (timeoutMs == null) timeoutMs = OP_TIMEOUTS[op] || 30000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(PYTHON_BIN, ['-X', 'utf8', 'data_query.py', op, ...args], {
        cwd: LINDANG_DIR,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8:replace',
          LANG: 'zh_CN.UTF-8',
          LC_ALL: 'zh_CN.UTF-8',
        },
        windowsHide: true,
      });
    } catch (e) {
      return resolve({ ok: false, op, error: 'spawn failed: ' + e.message });
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch {}
      resolve({ ok: false, op, error: 'timeout (' + timeoutMs + 'ms)' });
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ ok: false, op, error: 'process error: ' + e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (!stdout) {
        return resolve({ ok: false, op, error: 'exit ' + code, stderr: stderr.slice(0, 1500) });
      }
      // data_query.py 输出严格 JSON；偶有第三方库（xtquant 等）污染 stdout，提取首个 { 起的内容
      const jsonStart = stdout.search(/[{\[]/);
      const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
      try {
        const parsed = JSON.parse(jsonText);
        // data_query.py 自带 ok/op/error 字段，原样透传
        resolve(parsed);
      } catch (e) {
        resolve({
          ok: false,
          op,
          error: 'json parse: ' + e.message,
          stdout: jsonText.slice(0, 800),
          stderr: stderr.slice(0, 500),
        });
      }
    });
  });
}

async function fetchSnapshot(symbol) {
  if (!symbol) return { ok: false, op: 'snapshot', error: 'symbol 必填' };
  return await _runDataQuery('snapshot', [symbol]);
}

async function fetchField(op, symbol, extra = []) {
  if (!op) return { ok: false, op, error: 'op 必填' };
  if (!symbol) return { ok: false, op, error: 'symbol 必填' };
  return await _runDataQuery(op, [symbol, ...extra]);
}

// ── 兼容老接口 ────────────────────────────────────────────────────

async function fetchStock(symbol, _name = '') {
  // 旧接口语义：拉单股 33 字段。新方案 snapshot 也是一站式（gate+basic+price+indicators+flow）。
  return await fetchSnapshot(symbol);
}

async function fetchConcept(_concept, _topN = 10) {
  return {
    ok: false,
    op: 'concept',
    error: '概念龙头查询已下线（依赖 Stock_top10 已删）。圆桌请改用 fetch_lindang_stock(symbol) 或 fetch_lindang_field(op, symbol)。',
  };
}

async function fetchSector(_sector) {
  return {
    ok: false,
    op: 'sector',
    error: '板块概况查询已下线。如需板块成分，可改用 fetch_lindang_field(op="qmt-sector", symbol="<板块名>")，但需要 QMT 客户端启动。',
  };
}

module.exports = {
  fetchSnapshot,
  fetchField,
  fetchStock,
  fetchConcept,
  fetchSector,
  LINDANG_DIR,
  PYTHON_BIN,
};
