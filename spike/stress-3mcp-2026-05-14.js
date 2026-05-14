'use strict';
// 压力测试：3 MCP 工具 × 5 股 × 2 轮 = 30 次
const path = require('path');
const bridge = require(path.join(__dirname, '..', 'core', 'lindang-bridge.js'));

const SYMBOLS = [
  { code: '600519', name: '贵州茅台' },
  { code: '000001', name: '平安银行' },
  { code: '300750', name: '宁德时代' },
  { code: '688981', name: '中芯国际' },
  { code: '600036', name: '招商银行' },
];
const TOOLS = [
  { name: 'stock_static', fn: bridge.fetchStatic },
  { name: 'stock_market', fn: bridge.fetchMarket },
  { name: 'stock_news', fn: bridge.fetchNews },
];
const ROUNDS = 2;

async function runOne(toolName, fn, symbol) {
  const t0 = Date.now();
  try {
    const r = await fn(symbol);
    const dt = Date.now() - t0;
    return {
      tool: toolName, symbol, ms: dt,
      ok: !!(r && r.ok),
      error: r && r.error,
      sub_errors: r && r.errors ?
        Object.entries(r.errors).filter(([k, v]) => v != null).map(([k]) => k) : [],
      data_keys: r ?
        Object.keys(r).filter(k => r[k] != null && k !== 'errors' && k !== 'fetched_at').length : 0,
    };
  } catch (e) {
    return { tool: toolName, symbol, ms: Date.now() - t0, ok: false, error: 'exception: ' + e.message };
  }
}

(async () => {
  console.log(`Stress test: ${TOOLS.length} tools × ${SYMBOLS.length} symbols × ${ROUNDS} rounds = ${TOOLS.length * SYMBOLS.length * ROUNDS} calls\n`);
  console.log('Started:', new Date().toISOString());

  const results = [];
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n--- Round ${round}/${ROUNDS} ---`);
    for (const sym of SYMBOLS) {
      // 同一股票的 3 个工具串行（避免 LinDangAgent rate limit）
      for (const tool of TOOLS) {
        process.stderr.write(`  [${round}.${sym.code}.${tool.name}] running...`);
        const r = await runOne(tool.name, tool.fn, sym.code);
        results.push({ round, ...r });
        process.stderr.write(` ${r.ok ? 'OK' : 'FAIL'} (${(r.ms / 1000).toFixed(1)}s)\n`);
      }
    }
  }

  console.log('\nFinished:', new Date().toISOString());
  console.log('\n========== Summary ==========');

  // 按 tool 聚合
  const byTool = {};
  for (const r of results) {
    if (!byTool[r.tool]) byTool[r.tool] = [];
    byTool[r.tool].push(r);
  }

  for (const tool of TOOLS.map(t => t.name)) {
    const list = byTool[tool] || [];
    const okList = list.filter(r => r.ok);
    const ms = okList.map(r => r.ms);
    const avg = ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0;
    const min = ms.length ? Math.min(...ms) : 0;
    const max = ms.length ? Math.max(...ms) : 0;
    console.log(`${tool.padEnd(14)} ${okList.length}/${list.length} ok  avg=${(avg/1000).toFixed(1)}s  min=${(min/1000).toFixed(1)}s  max=${(max/1000).toFixed(1)}s`);
  }

  // sub-op errors 分布
  console.log('\n========== Sub-op errors (across all calls) ==========');
  const errCount = {};
  for (const r of results) {
    if (r.sub_errors && r.sub_errors.length) {
      for (const e of r.sub_errors) {
        const key = `${r.tool}.${e}`;
        errCount[key] = (errCount[key] || 0) + 1;
      }
    }
  }
  const sortedErrs = Object.entries(errCount).sort((a, b) => b[1] - a[1]);
  for (const [k, v] of sortedErrs.slice(0, 20)) {
    console.log(`  ${k}: ${v} times`);
  }

  // 失败 case 详情
  const fails = results.filter(r => !r.ok);
  if (fails.length) {
    console.log('\n========== FAILED CALLS ==========');
    for (const f of fails) {
      console.log(`  [${f.tool}] ${f.symbol} (round ${f.round}): ${(f.error || '').toString().slice(0, 150)}`);
    }
  }

  // dump JSON 结果给 HTML 报告用
  const fs = require('fs');
  const dumpPath = path.join(__dirname, 'stress-3mcp-results-2026-05-14.json');
  fs.writeFileSync(dumpPath, JSON.stringify({
    started: new Date().toISOString(),
    symbols: SYMBOLS,
    tools: TOOLS.map(t => t.name),
    rounds: ROUNDS,
    results,
    summary_by_tool: Object.fromEntries(TOOLS.map(t => {
      const list = byTool[t.name] || [];
      const okList = list.filter(r => r.ok);
      const ms = okList.map(r => r.ms);
      return [t.name, {
        ok_count: okList.length,
        total: list.length,
        success_rate: list.length ? (okList.length / list.length) : 0,
        avg_ms: ms.length ? ms.reduce((a, b) => a + b, 0) / ms.length : 0,
        min_ms: ms.length ? Math.min(...ms) : 0,
        max_ms: ms.length ? Math.max(...ms) : 0,
      }];
    })),
    sub_op_errors: errCount,
  }, null, 2));
  console.log(`\nFull results dumped to: ${dumpPath}`);

  const totalOk = results.filter(r => r.ok).length;
  console.log(`\nOVERALL: ${totalOk}/${results.length} passed (${((totalOk / results.length) * 100).toFixed(1)}%)`);
  process.exit(totalOk === results.length ? 0 : 1);
})();
