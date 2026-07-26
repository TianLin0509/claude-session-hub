'use strict';
/**
 * 投委会两段式输出抽取 + 双榜聚合（task#4）。
 *
 * 从委员发言 text（自然语言 + 末尾 JSON）抽结构化打分，聚合成战法面板数据：
 *   双榜(追涨/低吸) · 绝对体检(三面分) · 矛盾探针 · 风险隔离 · lean 共识 · top3 方向 · coverage 降级。
 *
 * 设计为纯函数模块（无状态、无副作用），conductor 与单测共用。移植门户 committee2.py
 * _parse_review / scoring 思路。容错铁律：任一委员无 JSON / 坏 JSON，降级标注，绝不崩。
 */

function _num(v) { const x = Number(v); return Number.isFinite(x) ? x : null; }
function _norm6(code) { return String(code || '').split('.')[0].trim(); }
function _avg(arr) { const xs = arr.filter(x => x != null); return xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null; }

// 标的唯一标识：有 6 位证券代码用代码，否则用名称（用户常直接输名字、无代码）。全程 key（委员
// 点评 JSON / 双榜聚合 / validCodes）统一按它对齐——根治「输名字时 code 落成名字、而委员用
// 真实代码做 key 致整段打分被 validCodes 过滤丢弃」（绝对体检 0/3、买入榜「暂无」的真因）。
function idOf(s) { return _norm6((s && (s.code || s.name)) || ''); }
// 显示标签：代码 + 名称去重拼接。输名字时 code 为空 → 只剩名字，不再「长川科技 长川科技」重复。
function labelOf(s) {
  const parts = [s && s.code, s && s.name].map(x => String(x == null ? '' : x).trim()).filter(Boolean);
  return [...new Set(parts)].join(' ');
}

/** 从 text 抽最后一段合法 JSON：优先 ```json 围栏，兜底最后一个平衡 {}。坏的返 null 不崩。 */
function parseLastJson(text) {
  if (!text || typeof text !== 'string') return null;
  const candidates = [...text.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map(m => m[1]);
  if (!candidates.length) {
    const last = text.lastIndexOf('}');
    if (last >= 0) {
      let depth = 0;
      for (let i = last; i >= 0; i--) {
        if (text[i] === '}') depth++;
        else if (text[i] === '{') { depth--; if (depth === 0) { candidates.push(text.slice(i, last + 1)); break; } }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try { return JSON.parse(candidates[i].trim()); } catch { /* try previous candidate */ }
  }
  return null;
}

/** results[{label,text,status}] → [{label, byStock:{code6:{faces,chase,ambush,lean,veto,top_bull,top_bear}}, hasJson}] */
function extractReviews(results, stocks) {
  const validCodes = new Set((stocks || []).map(idOf));
  return (results || []).map(r => {
    const j = parseLastJson(r && r.text);
    const byStock = {};
    if (j && j.stocks && typeof j.stocks === 'object') {
      for (const [code, v] of Object.entries(j.stocks)) {
        const c = _norm6(code);
        if (!validCodes.has(c) || !v || typeof v !== 'object') continue;
        byStock[c] = {
          faces: (v.faces && typeof v.faces === 'object') ? v.faces : {},
          chase: _num(v.chase), ambush: _num(v.ambush), rs: _num(v.rs),
          lean: typeof v.lean === 'string' ? v.lean : '', veto: !!v.veto,
          catalyst: typeof v.catalyst === 'string' ? v.catalyst : '',
          top_bull: Array.isArray(v.top_bull) ? v.top_bull.filter(x => typeof x === 'string') : [],
          top_bear: Array.isArray(v.top_bear) ? v.top_bear.filter(x => typeof x === 'string') : [],
        };
      }
    }
    return { label: (r && r.label) || '?', status: r && r.status, byStock, hasJson: !!j };
  });
}

/** 辩论后的新分覆盖旧分（委员有记忆，改判即更新同委员同股的条目）。 */
function mergeReviews(prev, next) {
  const byLabel = {};
  for (const rv of prev || []) byLabel[rv.label] = { ...rv, byStock: { ...rv.byStock } };
  for (const rv of next || []) {
    if (!byLabel[rv.label]) { byLabel[rv.label] = { ...rv, byStock: { ...rv.byStock } }; continue; }
    for (const [code, v] of Object.entries(rv.byStock)) byLabel[rv.label].byStock[code] = v;
    if (rv.hasJson) byLabel[rv.label].hasJson = true;
  }
  return Object.values(byLabel);
}

function _topCount(arr) {
  if (!arr.length) return '';
  const c = {};
  for (const x of arr) c[x] = (c[x] || 0) + 1;
  return Object.entries(c).sort((a, b) => b[1] - a[1])[0][0];
}
function _dedupTop(arr, n) {
  const seen = new Set(); const out = [];
  for (const x of arr) { const k = String(x).trim(); if (!k || seen.has(k)) continue; seen.add(k); out.push(x); if (out.length >= n) break; }
  return out;
}

/**
 * 聚合双榜 + 体检 + 探针 + 隔离 + lean 共识 + top3 + coverage。
 * @returns {rows, chase_ranking, ambush_ranking, probes, isolated}
 */
function buildBoards(reviews, stocks) {
  const totalMembers = (reviews || []).length;
  const perStock = {};
  for (const s of stocks || []) {
    const id = idOf(s);
    perStock[id] = {
      code: id, name: s.name || '',
      chase: [], ambush: [], rs: [], faces: { 基本面: [], 技术面: [], 消息面: [] },
      vetoers: [], leans: [], bulls: [], bears: [], catalysts: [], jsonCount: 0,
    };
  }
  for (const rv of reviews || []) {
    for (const [code, v] of Object.entries(rv.byStock || {})) {
      const ps = perStock[code]; if (!ps) continue;
      ps.jsonCount += 1;
      if (v.chase != null) ps.chase.push(v.chase);
      if (v.ambush != null) ps.ambush.push(v.ambush);
      if (v.rs != null) ps.rs.push(v.rs);
      if (v.catalyst) ps.catalysts.push(v.catalyst);
      for (const f of ['基本面', '技术面', '消息面']) { const x = _num(v.faces && v.faces[f]); if (x != null) ps.faces[f].push(x); }
      if (v.veto) ps.vetoers.push(rv.label);
      if (v.lean) ps.leans.push(v.lean);
      for (const b of v.top_bull || []) ps.bulls.push(b);
      for (const b of v.top_bear || []) ps.bears.push(b);
    }
  }
  const rows = Object.values(perStock).map(ps => ({
    code: ps.code, name: ps.name,
    chase_agg: _avg(ps.chase), ambush_agg: _avg(ps.ambush), rs_agg: _avg(ps.rs),
    catalyst: ps.catalysts[0] || '',
    faces: { 基本面: _avg(ps.faces.基本面), 技术面: _avg(ps.faces.技术面), 消息面: _avg(ps.faces.消息面) },
    chase_spread: ps.chase.length > 1 ? Math.max(...ps.chase) - Math.min(...ps.chase) : 0,
    lean_consensus: _topCount(ps.leans),
    top_bull: _dedupTop(ps.bulls, 4),
    top_bear: _dedupTop(ps.bears, 3),
    vetoers: ps.vetoers,
    coverage: { gave: ps.jsonCount, total: totalMembers, degraded: totalMembers > 0 && ps.jsonCount < totalMembers },
    // 每委员对该股的原始打分（gave=false 即该委员没给该股结构化分→排查谁没输出/谁异常，UI 折叠展开）
    per_member: (reviews || []).map(rv => {
      const v = (rv.byStock || {})[ps.code];
      return {
        label: rv.label, gave: !!v,
        faces: (v && v.faces) ? v.faces : {},
        chase: v ? v.chase : null, ambush: v ? v.ambush : null,
        lean: (v && v.lean) || '', veto: !!(v && v.veto),
      };
    }),
  }));
  const chase_ranking = [...rows].filter(r => r.chase_agg != null).sort((a, b) => b.chase_agg - a.chase_agg);
  const ambush_ranking = [...rows].filter(r => r.ambush_agg != null).sort((a, b) => b.ambush_agg - a.ambush_agg);
  const probes = rows.filter(r => r.chase_spread > 30).map(r => ({ code: r.code, name: r.name, kind: 'chase_spread', detail: `追涨分分歧 ${r.chase_spread}` }));
  const isolated = rows.filter(r => r.vetoers.length > 0).map(r => ({ code: r.code, name: r.name, by: r.vetoers }));
  return { rows, chase_ranking, ambush_ranking, probes, isolated };
}

/** 抽主席收敛报告 JSON；无 JSON 时降级保留原文片段。 */
function parseChair(text) {
  const j = parseLastJson(text);
  if (!j) return { chase_buys: [], ambush_buys: [], cross_advice: '', conflict_rulings: [], isolated: [], appendix: '', degraded: true, raw: String(text || '').slice(0, 400) };
  return {
    chase_buys: Array.isArray(j.chase_buys) ? j.chase_buys : [],
    ambush_buys: Array.isArray(j.ambush_buys) ? j.ambush_buys : [],
    cross_advice: j.cross_advice || '',
    conflict_rulings: Array.isArray(j.conflict_rulings) ? j.conflict_rulings : [],
    isolated: Array.isArray(j.isolated) ? j.isolated : [],
    appendix: j.appendix || '',
    degraded: false,
  };
}

module.exports = { parseLastJson, extractReviews, mergeReviews, buildBoards, parseChair, _norm6, idOf, labelOf };
