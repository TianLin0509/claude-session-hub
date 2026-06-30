'use strict';
/**
 * kline-screener 技术初筛分桥接（Hub 玻璃房投委会 · task#1）。
 *
 * 复用 kline-screener 已算好的「追涨(chase)/蓄势(setup≈低吸)」双模式打分 + 技术指标，
 * 给投委会「技术面」一个客观量化锚——两模式恰好对应用户追涨/低吸右侧打法。
 *
 * - 池内票（在最新筛选快照 snapshots[最新日]）：直接读 mode/chase_score/setup_score/关键指标。
 * - 池外票（用户手动加的非强势票）：available=false，技术分降级由 AI 基于行情研判（不脑补量化分）。
 * - data.json ~MB 级且含 Python json 写出的 NaN/Infinity 字面量（JS JSON.parse 不接受）：
 *   读后先把裸 NaN/Infinity 替换为 null，再 parse；按 mtime 缓存「最新日 {code6: 记录}」。
 *
 * 移植自门户 touwei-committee/src/touwei/screener_bridge.py，逻辑等价。
 */
const fs = require('fs');

const DATA_PATH = process.env.SCREENER_DATA_PATH || 'C:/Users/lintian/kline-screener/data.json';

let _cache = { mtime: null, byCode: {}, endDate: null, rows: [], meta: null };

function _norm(code) {
  return String(code || '').split('.')[0].trim();
}

// 安全转数：NaN/Infinity/不可转 → null
function _f(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : null;
}

function _pct(v) {
  const x = _f(v);
  return x == null ? '—' : `${(x * 100).toFixed(0)}%`;
}

function _r(v, n = 2) {
  const x = _f(v);
  return x == null ? '—' : x.toFixed(n);
}

function _load() {
  let mt;
  try {
    mt = fs.statSync(DATA_PATH).mtimeMs;
  } catch {
    return _cache.byCode; // 文件不在：降级返回上次/空
  }
  if (_cache.mtime !== mt) {
    let raw;
    try {
      raw = fs.readFileSync(DATA_PATH, 'utf-8');
    } catch {
      return _cache.byCode;
    }
    let d;
    try {
      // data.json 由 Python json(allow_nan) 写出，含裸 NaN/Infinity 字面量；
      // JS JSON.parse 不接受 → 替换为 null（字符串字段不会是裸 NaN，\b 边界安全）。
      const cleaned = raw.replace(/\b-?Infinity\b/g, 'null').replace(/\bNaN\b/g, 'null');
      d = JSON.parse(cleaned);
    } catch {
      return _cache.byCode; // 解析失败不致命，沿用旧缓存
    }
    const meta = d.meta || {};
    const dates = d.dates || meta.dates || [];
    const snaps = d.snapshots || {};
    const latest = dates.length ? (snaps[dates[0]] || []) : [];
    const byCode = {};
    for (const r of latest) {
      const c = _norm(r.code);
      if (c) byCode[c] = r;
    }
    _cache = { mtime: mt, byCode, endDate: dates[0] || meta.end_date || null, rows: latest, meta };
  }
  return _cache.byCode;
}

function techRecord(code) {
  return _load()[_norm(code)] || null;
}

const MODE_CN = { chase: '追涨型(主升进行中)', setup: '蓄势型(回调企稳·低吸)' };

// 注入技术面的关键指标白名单（带中文名，给 AI 看）
const IND_CN = {
  strength: '龙分综合', p_rs: '相对强度分位', bias20: '偏离MA20', ret5: '5日涨幅',
  ret20: '20日涨幅', guard20: '守MA20率', dd60: '距60日高回撤', vr: '量比',
  vol_contract: '缩量比', temp: '温度', close: '收盘价', amt20: '20日均额(亿)',
};

function _shapeSummary(r) {
  const mode = r.mode;
  if (mode === 'chase') {
    return `追涨型(主升进行中)：龙分 ${_r(r.strength, 0)}·相对强度分位 ${_r(r.p_rs, 0)}，`
      + `20日涨 ${_pct(r.ret20)}、偏离MA20 ${_pct(r.bias20)}，守MA20率 ${_pct(r.guard20)}，量比 ${_r(r.vr)}。`
      + `形态符合：强势龙、均线多头、守MA20——对应『追涨·主升进行中』。`;
  }
  if (mode === 'setup') {
    return `蓄势型(回调企稳·低吸)：前期峰值偏离 ${_pct(r.pmax_b20)}(涨幅充分)，`
      + `当前回踩60日高 ${_pct(r.dd60)}、偏离MA20 ${_pct(r.bias20)}，守MA20率 ${_pct(r.guard20)}、缩量比 ${_r(r.vol_contract)}。`
      + `形态符合：大涨后回调、站上MA20、缩量企稳——对应『低吸·回调赌第二波』。`;
  }
  return '未明确归入追涨/蓄势模式。';
}

/** 投委会技术面注入包。池内票给量化模式分+指标+形态摘要；池外票降级标注。 */
function brief(code) {
  const r = techRecord(code);
  if (!r) {
    return {
      available: false, in_pool: false,
      note: '不在最新技术初筛池(强势候选 chase/setup)；技术形态分由 AI 基于行情(stock_market)研判（非 kline-screener 量化分，不脑补）',
    };
  }
  const mode = r.mode;
  const score = mode === 'chase' ? r.chase_score : r.setup_score;
  const indicators = {};
  for (const k of Object.keys(IND_CN)) indicators[IND_CN[k]] = _f(r[k]);
  return {
    available: true, in_pool: true, mode, mode_cn: MODE_CN[mode] || String(mode), name: r.name || null,
    screener_score: _f(score), chase_score: _f(r.chase_score), setup_score: _f(r.setup_score),
    end_date: _cache.endDate, summary: _shapeSummary(r), indicators,
  };
}

/** 注入 prompt 的文本块（投委会技术面/公共信息池用）。 */
function promptBlock(code) {
  const b = brief(code);
  if (!b.available) return `（技术初筛：${b.note}）`;
  const inds = Object.entries(b.indicators)
    .filter(([, v]) => v != null)
    .map(([k, v]) => `${k} ${v}`)
    .join('，');
  return `【kline-screener 技术初筛 · 截至 ${b.end_date}】模式=${b.mode_cn}，`
    + `量化分=${_r(b.screener_score, 0)}（追涨分 ${_r(b.chase_score, 0)} / 蓄势分 ${_r(b.setup_score, 0)}）。\n`
    + `形态摘要：${b.summary}\n关键指标：${inds}`;
}

function _scoreOf(r) {
  if (!r) return null;
  return r.mode === 'setup' ? _f(r.setup_score) : _f(r.chase_score);
}

function _rowView(r) {
  const score = _scoreOf(r);
  return {
    code: _norm(r.code),
    name: r.name || '',
    mode: r.mode || '',
    mode_cn: MODE_CN[r.mode] || String(r.mode || ''),
    score,
    chase_score: _f(r.chase_score),
    setup_score: _f(r.setup_score),
    strength: _f(r.strength),
    p_rs: _f(r.p_rs),
    ret5: _f(r.ret5),
    ret20: _f(r.ret20),
    bias20: _f(r.bias20),
    guard20: _f(r.guard20),
    dd60: _f(r.dd60),
    vr: _f(r.vr),
    vol_contract: _f(r.vol_contract),
    temp: r.temp || '',
    close: _f(r.close),
    amt20: _f(r.amt20),
    summary: _shapeSummary(r),
  };
}

function _topByMode(rows, mode, limit) {
  return rows
    .filter(r => r && r.mode === mode)
    .slice()
    .sort((a, b) => (_scoreOf(b) || 0) - (_scoreOf(a) || 0))
    .slice(0, limit)
    .map(_rowView);
}

/** 当日/最新技术初筛快照，供 Hub UI 一键展示。 */
function latestSnapshot(opts = {}) {
  _load();
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 12));
  const rows = Array.isArray(_cache.rows) ? _cache.rows : [];
  const meta = _cache.meta || {};
  return {
    end_date: _cache.endDate || meta.end_date || null,
    generated: meta.generated || null,
    source: meta.source || '',
    universe: _f(meta.universe),
    data_path: DATA_PATH,
    total: rows.length,
    chase_count: rows.filter(r => r && r.mode === 'chase').length,
    setup_count: rows.filter(r => r && r.mode === 'setup').length,
    top_chase: _topByMode(rows, 'chase', limit),
    top_setup: _topByMode(rows, 'setup', limit),
  };
}

module.exports = {
  brief,
  promptBlock,
  techRecord,
  latestSnapshot,
  DATA_PATH,
  _resetCache: () => { _cache = { mtime: null, byCode: {}, endDate: null, rows: [], meta: null }; },
};
