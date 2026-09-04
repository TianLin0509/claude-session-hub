'use strict';
// LinDangAgent 桥接（2026-05-03 重构）：
// 旧入口 `python -m services.fetch_for_arena ...` 已下线（services 目录已删）。
// 新入口：`python data_query.py <op> [args...]`，详见 <LINDANG_DIR>/data/AGENT_GUIDE.md
//
// 对外接口：
//   fetchSnapshot(symbol)        — 一键拉 gate+basic+price+indicators+flow
//   fetchStatic/Market/News/...  — research-mcp 聚合接口，供 Hub 投研场景调用

const { spawn } = require('child_process');

// LINDANG_DIR 必须由用户配置（env LINDANG_DIR 或 LinDangAgent 项目根路径），未配置则
// LinDang MCP 工具调用直接返回 not-configured 错误（不影响 Hub 主流程）。
// PYTHON_BIN 默认走 PATH 解析，绝大多数装了 Python 的机器都能命中。
const LINDANG_DIR = process.env.LINDANG_DIR || '';
const PYTHON_BIN = process.env.LINDANG_PYTHON || 'python';

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
    if (!LINDANG_DIR) {
      return resolve({
        ok: false,
        op,
        error: '投研数据后端未配置：投研场景需要 A 股数据后端 + 设置环境变量 LINDANG_DIR 指向项目根目录。详见 README → 协作集成。当前群聊可改用通用 / 开发场景。',
      });
    }
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

// ─── 新增：research-mcp 聚合接口（Plan 2） ──────────────────────────
// research-mcp 是独立的数据聚合层（C:\research-mcp），通过 `uv run python query.py <op> <symbol>`
// 调用，每个 op 后端并行聚合多个原子查询（含 LinDangAgent 5-6 层兜底）。
//   stock-static  — 9 op：gate/basic/financial/valuation/peers/holders/pledge/funds/research
//   stock-market  — 6 op：price/indicators/flow/dragon-tiger/northbound/margin
//   stock-news    — 2 op：announcement + market_news

const RESEARCH_MCP_DIR = process.env.RESEARCH_MCP_DIR || 'C:\\research-mcp';
const RESEARCH_MCP_UV_BIN = process.env.RESEARCH_MCP_UV || 'uv';
const RESEARCH_MCP_TIMEOUTS = {
  // Codex/Claude MCP clients time out tools/call at about 120s. Return a
  // controlled result before that budget so one slow tool does not block the
  // whole research MCP queue.
  'stock-static': 110000,
  'stock-market': 110000,
  'stock-news': 60000,
  'stock-sentiment': 90000,
  'stock-scan': 110000,
  // K 线相似度：默认 ensemble（RRF 3 方法融合），首次冷启动拉 200 候选 OHLCV ~30s
  // disk cache 命中后 5-10s；matrix_profile 单 method 始终 ~5s
  'kline-similarity-search': 120000,
};

function _killProcessTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      });
      killer.on('error', () => {});
    } catch {}
    return;
  }
  try { child.kill('SIGKILL'); } catch {}
}

function _runResearchMcp(op, args, timeoutMs) {
  if (timeoutMs == null) timeoutMs = RESEARCH_MCP_TIMEOUTS[op] || 90000;
  return new Promise((resolve) => {
    let child;
    let settled = false;
    let timer = null;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(payload);
    };
    try {
      // 调 uv run python query.py <op> [args...]，cwd=research-mcp
      child = spawn(RESEARCH_MCP_UV_BIN, ['run', 'python', 'query.py', op, ...args], {
        cwd: RESEARCH_MCP_DIR,
        env: {
          ...process.env,
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8:replace',
          NO_PROXY: 'localhost,127.0.0.1',
        },
        windowsHide: true,
      });
    } catch (e) {
      return finish({ ok: false, op, error: 'spawn failed: ' + e.message });
    }
    const stdoutChunks = [];
    const stderrChunks = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    timer = setTimeout(() => {
      _killProcessTree(child);
      finish({ ok: false, op, error: 'timeout (' + timeoutMs + 'ms)' });
    }, timeoutMs);
    child.on('error', (e) => {
      finish({ ok: false, op, error: 'process error: ' + e.message });
    });
    child.on('close', (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString('utf-8').trim();
      const stderr = Buffer.concat(stderrChunks).toString('utf-8');
      if (!stdout) {
        return finish({ ok: false, op, error: 'exit ' + code, stderr: stderr.slice(0, 1500) });
      }
      // research-mcp query.py 输出严格 JSON，但可能有 stderr 污染 stdout 极少数情况
      const jsonStart = stdout.search(/[{\[]/);
      const jsonText = jsonStart >= 0 ? stdout.slice(jsonStart) : stdout;
      try {
        // 用 raw_decode 等价逻辑容忍尾部污染
        let parsed;
        try {
          parsed = JSON.parse(jsonText);
        } catch {
          // 找到最后一个 } 截断
          const lastBrace = jsonText.lastIndexOf('}');
          if (lastBrace > 0) {
            parsed = JSON.parse(jsonText.slice(0, lastBrace + 1));
          } else {
            throw new Error('no closing brace');
          }
        }
        finish(parsed);
      } catch (e) {
        finish({
          ok: false, op,
          error: 'json parse: ' + e.message,
          stdout: jsonText.slice(0, 800),
          stderr: stderr.slice(0, 500),
        });
      }
    });
  });
}

function _depthArg(depth) {
  return ['brief', 'medium', 'full'].includes(depth) ? ['--depth', depth] : [];
}

function _modeArg(mode) {
  return ['daily', 'intraday'].includes(mode) ? ['--mode', mode] : [];
}

async function fetchStatic(symbol, depth = 'medium') {
  if (!symbol) return { ok: false, op: 'stock-static', error: 'symbol 必填' };
  return await _runResearchMcp('stock-static', [symbol, ..._depthArg(depth)]);
}

async function fetchMarket(symbol, depth = 'medium', mode = 'daily') {
  if (!symbol) return { ok: false, op: 'stock-market', error: 'symbol 必填' };
  return await _runResearchMcp('stock-market', [symbol, ..._depthArg(depth), ..._modeArg(mode)]);
}

async function fetchNews(symbol, depth = 'medium') {
  if (!symbol) return { ok: false, op: 'stock-news', error: 'symbol 必填' };
  return await _runResearchMcp('stock-news', [symbol, ..._depthArg(depth)]);
}

async function fetchSentiment(symbol, depth = 'medium', only_subject_stock = false) {
  if (!symbol) return { ok: false, op: 'stock-sentiment', error: 'symbol 必填' };
  const extraArgs = only_subject_stock ? ['--only-subject-stock'] : [];
  return await _runResearchMcp('stock-sentiment', [symbol, ..._depthArg(depth), ...extraArgs]);
}

async function fetchScan(scanType, depth = 'medium', opts = {}) {
  if (!scanType) return { ok: false, op: 'stock-scan', error: 'scan_type 必填' };
  // date/source 目前只有 emotion-cycle 用；research-mcp 的 run_scanner 会按形参过滤，
  // 传给其它 scan_type 也不会报错，但这里仍只在有值时才追加，保持命令行干净。
  const extra = [];
  if (opts.date) extra.push('--date', String(opts.date));
  if (opts.source) extra.push('--source', String(opts.source));
  return await _runResearchMcp('stock-scan', [scanType, ..._depthArg(depth), ...extra]);
}

// K 线历史相似走势检索（STUMPY Matrix Profile）
async function fetchKlineSimilarity(symbol, opts = {}) {
  if (!symbol) return { ok: false, op: 'kline-similarity-search', error: 'symbol 必填' };
  const window = opts.window || 20;
  const top_k = opts.top_k || 10;
  const method = opts.method || 'matrix_profile';
  const feature = opts.feature || 'close';
  const exclude_self_recent = (opts.exclude_self_recent == null) ? 60 : opts.exclude_self_recent;
  const args = [
    symbol,
    '--window', String(window),
    '--top-k', String(top_k),
    '--method', method,
    '--feature', feature,
    '--exclude-self-recent', String(exclude_self_recent),
  ];
  return await _runResearchMcp('kline-similarity-search', args);
}

module.exports = {
  fetchSnapshot,
  fetchStatic,
  fetchMarket,
  fetchNews,
  fetchSentiment,
  fetchScan,
  fetchKlineSimilarity,
  LINDANG_DIR,
  PYTHON_BIN,
  RESEARCH_MCP_DIR,
};
