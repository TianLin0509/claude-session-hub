'use strict';
// Plan 2 Task C — bridge smoke: 验证 fetchStatic/fetchMarket/fetchNews 真实可用
// 不启动 Hub Electron 实例（生产 Hub 隔离）；直接 require lindang-bridge.js 跑 facade

const path = require('path');
const bridge = require(path.join(__dirname, '..', 'core', 'lindang-bridge.js'));

async function smokeOne(name, fn, symbol) {
  const t0 = Date.now();
  try {
    const r = await fn(symbol);
    const dt = Date.now() - t0;
    const ok = r && r.ok === true;
    const summary = {
      ok,
      ms: dt,
      symbol: r && r.symbol,
      stock_name: r && r.stock_name,
      error: r && r.error,
      keys: r ? Object.keys(r).filter(k => r[k] != null && k !== 'errors').slice(0, 8) : [],
      sub_errors: r && r.errors ? Object.entries(r.errors)
        .filter(([k, v]) => v != null).map(([k]) => k) : [],
    };
    return { name, ...summary };
  } catch (e) {
    return { name, ok: false, ms: Date.now() - t0, error: 'exception: ' + e.message };
  }
}

(async () => {
  console.log('Bridge smoke 2026-05-14 — testing fetchStatic / fetchMarket / fetchNews against 600519\n');
  const results = [];
  results.push(await smokeOne('fetchStatic', bridge.fetchStatic, '600519'));
  results.push(await smokeOne('fetchMarket', bridge.fetchMarket, '600519'));
  results.push(await smokeOne('fetchNews', bridge.fetchNews, '600519'));

  let okCount = 0;
  for (const r of results) {
    const flag = r.ok ? 'OK' : 'FAIL';
    console.log(`[${flag}] ${r.name.padEnd(14)} ${(r.ms + 'ms').padStart(7)}  symbol=${r.symbol || '-'}  stock_name=${r.stock_name || '-'}`);
    if (r.keys && r.keys.length) console.log(`   data keys: ${r.keys.join(', ')}`);
    if (r.sub_errors && r.sub_errors.length) console.log(`   sub-op errors: ${r.sub_errors.join(', ')}`);
    if (r.error) console.log(`   error: ${r.error.toString().slice(0, 200)}`);
    if (r.ok) okCount++;
  }
  console.log(`\nSMOKE: ${okCount}/${results.length} passed`);
  process.exit(okCount === results.length ? 0 : 1);
})();
