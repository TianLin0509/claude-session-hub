'use strict';
/**
 * 投委会 UI 纯逻辑（无 electron/DOM 依赖，jsdom 可真实测）。task#6/7。
 *
 * - parseStocks：解析用户弹窗输入 → [{code,name}]
 * - reduceProgress：committee:progress 事件 → 面板状态机
 * - modalHtml / panelHtml：弹窗与战法面板的纯 HTML（样式在 committee-ui.css）
 *
 * 壳 committee-ui.js 负责 electron IPC + DOM 挂载，调本模块的纯函数。
 */

const ACT_ORDER = ['立会', '建库', '点评', '辩论', '收敛'];

function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** "688256 寒武纪, 603823 百合花" / 多行 / 空格分隔多只纯名字 / 含 .SH 后缀 → [{code,name}]，去重。 */
function parseStocks(raw) {
  if (!raw) return [];
  const out = [];
  const seen = new Set();
  // code 仅在真有 6 位代码时填；无代码留空，标的标识由后端 idOf 兜底用名称。
  const push = (code, name) => {
    if (!code && !name) return;
    const key = code || name;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ code, name: name || '' });
  };
  for (const seg of String(raw).split(/[,，;；\n\t]+/)) {
    const t = seg.trim();
    if (!t) continue;
    const m = t.match(/(\d{6})/);
    if (m) {
      // 含 6 位代码：当「代码 名字」一只（去掉代码及 SH/SZ/BJ 前后缀，剩下当名称）
      const name = t.replace(/(?:S[HZ]|BJ)?\.?\d{6}\.?(?:S[HZ]|BJ)?/gi, '').trim();
      push(m[1], name);
    } else {
      // 无代码：按空格（含全角）拆成多只纯名字——用户常空格分隔多只，如「沪电股份 沪硅产业 盛合晶微」
      for (const nm of t.split(/[\s　]+/)) { const name = nm.trim(); if (name) push('', name); }
    }
  }
  return out;
}

function initState() {
  return { active: false, done: false, stocks: [], rounds: 0, chair: '', members: [], curAct: '', actRound: 0, actTotal: 0, boards: null, chairReport: null, error: '', actsDetail: {}, activeTab: '', view: 'panel', historyList: [], viewingHistoryId: null };
}

function initScreenerState(seed = {}) {
  return {
    view: 'screener',
    runId: seed.runId || '',
    meetingId: seed.meetingId || '',
    active: false,
    done: false,
    error: '',
    stage: '待启动',
    percent: 0,
    message: '点击后读取当天技术初筛快照',
    result: null,
  };
}

/** committee:progress payload 归并进面板状态。 */
function reduceProgress(state, p) {
  const s = Object.assign({}, state);
  switch (p && p.type) {
    case 'start': s.active = true; s.done = false; s.error = ''; s.stocks = p.stocks || []; s.rounds = p.rounds || 0; s.chair = p.chair || ''; s.members = p.members || []; s.actsDetail = {}; s.view = 'panel'; s.viewingHistoryId = null; s.activeTab = '立会'; break;
    case 'act': s.curAct = p.act || ''; s.actRound = p.round || 0; s.actTotal = p.total || 0; s.activeTab = p.act || s.activeTab; break;
    case 'act-detail': {
      const key = p.act || '';
      const detail = Object.assign({}, s.actsDetail);
      detail[key] = (detail[key] || []).concat([{ round: p.round, sub: p.sub, speeches: p.speeches || [] }]);
      s.actsDetail = detail;
      s.activeTab = key || s.activeTab;
      break;
    }
    case 'board': if (p.boards) s.boards = p.boards; break;
    case 'chair': if (p.chair) s.chairReport = p.chair; break;
    case 'done': s.done = true; s.active = false; if (p.boards) s.boards = p.boards; if (p.chair) s.chairReport = p.chair; break;
    case 'error': s.error = p.reason || '出错'; s.active = false; break;
    default: break;
  }
  return s;
}

function reduceScreenerProgress(state, p) {
  const s = Object.assign(initScreenerState(), state || {});
  if (!p) return s;
  if (p.runId) s.runId = p.runId;
  if (p.meetingId) s.meetingId = p.meetingId;
  if (p.stage) s.stage = p.stage;
  if (p.message) s.message = p.message;
  if (p.percent != null) s.percent = Math.max(0, Math.min(100, Number(p.percent) || 0));
  switch (p.type) {
    case 'start':
      s.active = true; s.done = false; s.error = ''; break;
    case 'progress':
      s.active = true; s.done = false; break;
    case 'done':
      s.active = false; s.done = true; s.error = ''; s.percent = 100; s.result = p.result || s.result; break;
    case 'error':
      s.active = false; s.done = false; s.error = p.reason || p.message || '技术初筛失败'; s.percent = 100; break;
    default:
      break;
  }
  return s;
}

// ───────────────────────── HTML ─────────────────────────
function modalHtml(defaultStocks) {
  return [
    '<div class="cm-modal">',
    '  <div class="cm-mh">⚖️ 开投委会</div>',
    '  <div class="cm-ml">议题股票（代码 / 名，多只逗号分隔）</div>',
    `  <textarea class="cm-input cm-stocks" data-cm-stocks rows="2" placeholder="688256 寒武纪, 603823 百合花">${escapeHtml(defaultStocks || '')}</textarea>`,
    '  <div class="cm-ml">辩论轮次</div>',
    '  <select class="cm-input" data-cm-rounds><option value="3">3 轮</option><option value="4" selected>4 轮</option><option value="5">5 轮</option></select>',
    '  <div class="cm-note">点开始后<b>全自动</b>跑完五幕（立会→建库→点评→辩论→收敛），期间无需干预；<b>结束自动回到自由讨论</b>。</div>',
    '  <div class="cm-err" data-cm-err></div>',
    '  <div class="cm-mbtns"><button type="button" class="cm-cancel" data-cm-cancel>取消</button><button type="button" class="cm-start" data-cm-start>🚀 一键开始</button></div>',
    '</div>',
  ].join('');
}

function actBarHtml(curAct) {
  const ci = ACT_ORDER.indexOf(curAct);
  return '<div class="cm-acts">' + ACT_ORDER.map((a, i) => {
    const cls = ci < 0 ? '' : (i < ci ? ' done' : (i === ci ? ' on' : ''));
    return `<div class="cm-act${cls}">${a}</div>`;
  }).join('') + '</div>';
}

function _rankHtml(title, cls, ranking) {
  const rows = (ranking || []).map((r, i) =>
    `<div class="cm-rk"><span>${i + 1} ${escapeHtml(r.name || r.code)}</span><span class="cm-s ${cls}">${r[cls === 'chase' ? 'chase_agg' : 'ambush_agg'] == null ? '—' : r[cls === 'chase' ? 'chase_agg' : 'ambush_agg']}</span></div>`).join('');
  return `<div class="cm-brd"><div class="cm-bt cm-${cls}">${title}</div>${rows || '<div class="cm-rk cm-soft">暂无</div>'}</div>`;
}

function _checkupHtml(rows) {
  return (rows || []).map(r => {
    const f = r.faces || {};
    const fv = (k, color) => {
      const v = f[k];
      const tip = v == null
        ? ` title="${escapeHtml(k)}：本场无委员给出该维度评分（委员超时或未产出结构化 JSON）"`
        : ` title="${escapeHtml(k)}综合分 ${v}（多委员均值）"`;
      return `<div class="cm-fc"${tip}><div class="cm-fl">${k[0]}</div><div class="cm-fv ${color}">${v == null ? '—' : v}</div></div>`;
    };
    const cov = r.coverage && r.coverage.degraded
      ? `<span class="cm-cov" title="仅 ${r.coverage.gave}/${r.coverage.total} 位委员给出结构化评分，其余超时或没按格式输出 JSON——分数仅按已给分的委员聚合">⚠${r.coverage.gave}/${r.coverage.total}</span>`
      : '';
    // 各委员原始分（折叠展开，排查谁没给分/谁异常）——光看均值看不出是哪个 AI 没输出
    const pm = (r.per_member || []).map(m => {
      if (!m.gave) return `<div class="cm-pm cm-pm-miss"><span class="cm-pml">${escapeHtml(m.label)}</span><span class="cm-pmv">⚠ 未输出有效打分</span></div>`;
      const mf = m.faces || {};
      const cell = ['基本面', '技术面', '消息面'].map(k => mf[k] == null ? '—' : mf[k]).join('/');
      return `<div class="cm-pm"><span class="cm-pml">${escapeHtml(m.label)}</span><span class="cm-pmv">基技消 ${cell} · 追${m.chase ?? '—'}/低${m.ambush ?? '—'} [${escapeHtml(m.lean || '—')}]${m.veto ? ' ⛔否决' : ''}</span></div>`;
    }).join('');
    const detail = pm ? `<details class="cm-pm-box"><summary>各委员原始分（排查谁没给）</summary>${pm}</details>` : '';
    return `<div class="cm-brd"><div class="cm-bt">${escapeHtml(r.name || r.code)} ${cov}<span class="cm-lean">${escapeHtml(r.lean_consensus || '')}</span></div><div class="cm-three">${fv('基本面', 'b')}${fv('技术面', 't')}${fv('消息面', 'm')}</div>${detail}</div>`;
  }).join('');
}

function boardsHtml(boards) {
  if (!boards) return '<div class="cm-soft cm-empty">战法面板：点评幕后长出双榜 / 三面分 / 矛盾探针 / 风险隔离</div>';
  let h = '<div class="cm-pt">🩺 绝对体检（三面分）</div>' + _checkupHtml(boards.rows);
  h += '<div class="cm-pt">🏆 相对买入榜</div>';
  h += _rankHtml('🚀 追涨', 'chase', boards.chase_ranking);
  h += _rankHtml('🌱 低吸', 'ambush', boards.ambush_ranking);
  if (boards.probes && boards.probes.length) {
    h += '<div class="cm-pt">⚖️ 矛盾探针</div>' + boards.probes.map(p => `<div class="cm-warn">${escapeHtml(p.name || p.code)}：${escapeHtml(p.detail || '分歧')}</div>`).join('');
  }
  if (boards.isolated && boards.isolated.length) {
    h += '<div class="cm-pt">🚧 风险隔离</div>' + boards.isolated.map(i => `<div class="cm-danger">${escapeHtml(i.name || i.code)} → 隔离观察（${(i.by || []).map(escapeHtml).join('/') || '否决'}）</div>`).join('');
  }
  return h;
}

function chairHtml(report) {
  if (!report) return '';
  const buys = (arr, cls) => (arr || []).map(b => `<div class="cm-rk"><span>${b.rank ? b.rank + ' ' : ''}${escapeHtml(b.name || b.code)}</span><span class="cm-bz">${escapeHtml(b.reason || '')}</span></div>`).join('') || '<div class="cm-rk cm-soft">无</div>';
  let h = '<div class="cm-pt">🎩 主席换帽子 · 总指挥</div><div class="cm-chair">';
  if (report.degraded) h += '<div class="cm-soft">（主席未给结构化结论，原文）<br>' + escapeHtml((report.raw || '').slice(0, 200)) + '</div>';
  else {
    h += `<div class="cm-bt cm-chase">🚀 追涨买入榜</div>${buys(report.chase_buys)}`;
    h += `<div class="cm-bt cm-ambush">🌱 低吸买入榜</div>${buys(report.ambush_buys)}`;
    if (report.cross_advice) h += `<div class="cm-cross"><b>跨策略</b>：${escapeHtml(report.cross_advice)}</div>`;
    if (report.appendix) h += `<div class="cm-app"><b>附言</b>：${escapeHtml(report.appendix)}</div>`;
  }
  h += '<div class="cm-saf">🛡️ 三道保险：①换帽子中立 ②涉己更严 ③玻璃房可复核</div></div>';
  return h;
}

function _fmtTime(ts) {
  if (!ts) return '';
  try { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; } catch (e) { return ''; }
}

// 五幕可点 tab（点击切换查看某幕各委员发言）。on=当前查看的幕，done=已完成的幕，has=该幕有发言。
function tabBarHtml(s) {
  const sel = s.activeTab || s.curAct || '';
  const ci = ACT_ORDER.indexOf(s.curAct);
  return '<div class="cm-acts">' + ACT_ORDER.map((a, i) => {
    const isSel = a === sel;
    const isDone = s.done || (ci >= 0 && i < ci);
    const has = !!(s.actsDetail && s.actsDetail[a] && s.actsDetail[a].length);
    const cls = 'cm-act' + (isSel ? ' on' : (isDone ? ' done' : '')) + (has ? ' has' : '');
    return `<div class="${cls}" data-cm-tab="${escapeHtml(a)}" title="查看「${escapeHtml(a)}」幕各委员发言">${a}</div>`;
  }).join('') + '</div>';
}

// 当前 activeTab 幕的各委员发言原文（点4：看该步骤每个 AI 的具体表现）。
function actDetailHtml(s) {
  const key = s.activeTab || s.curAct || '';
  const entries = (s.actsDetail && s.actsDetail[key]) || [];
  if (!entries.length) {
    return `<div class="cm-soft cm-empty">${key ? escapeHtml(key) + '幕暂无发言（进行中或未产出）' : '点上方幕次，查看每位委员的发言'}</div>`;
  }
  return '<div class="cm-speeches">' + entries.map(e => {
    const sub = (e.round || e.sub) ? `<div class="cm-subh">${e.round ? '第 ' + e.round + ' 轮' : ''}${e.sub ? ' · ' + escapeHtml(e.sub) : ''}</div>` : '';
    const sp = (e.speeches || []).map(x =>
      `<div class="cm-sp"><div class="cm-spl">${escapeHtml(x.label)}</div><div class="cm-spt">${escapeHtml(x.text)}</div></div>`
    ).join('') || '<div class="cm-soft">（本幕无人发言）</div>';
    return sub + sp;
  }).join('') + '</div>';
}

// 历史摘要列表（点 cm-hi 加载该场回看）。
function historyListHtml(items) {
  if (!items || !items.length) return '<div class="cm-soft cm-empty">还没有跑过投委会</div>';
  return '<div class="cm-hist">' + items.map(it => {
    const names = (it.stocks || []).map(x => escapeHtml(x.name || x.code)).join('、');
    const badge = it.live ? '<span class="cm-badge cm-live">在跑</span>' : (it.degraded ? '<span class="cm-cov" title="主席未给结构化结论">⚠降级</span>' : '');
    return `<div class="cm-hi" data-cm-hist-id="${escapeHtml(it.id || '')}"><div class="cm-hi-top"><b>${names || '—'}</b>${badge}</div><div class="cm-hi-meta">${_fmtTime(it.endedAt)} · 主席 ${escapeHtml(it.chair || '—')} · 辩论 ${it.rounds || '?'} 轮</div></div>`;
  }).join('') + '</div>';
}

function historyPanelHtml(s) {
  let h = `<div class="cm-phead" data-cm-drag><span class="cm-ptitle">📋 过往投委会</span><button type="button" class="cm-pclose" data-cm-panel-close title="关闭">×</button></div>`;
  h += '<div class="cm-pmeta">点任意一场，回看五幕发言 + 双榜 + 主席报告</div>';
  h += historyListHtml(s.historyList);
  return h;
}

// 历史 record → 面板 state（复用 panelHtml 渲染，view=panel + viewingHistoryId 标记历史回看）。
function recordToState(record) {
  const s = initState();
  if (!record) return s;
  s.view = 'panel'; s.viewingHistoryId = record.id || true;
  s.done = true; s.active = false;
  s.stocks = record.stocks || []; s.rounds = record.rounds || 0;
  s.chair = record.chair || ''; s.members = record.members || [];
  s.boards = record.boards || null; s.chairReport = record.chairReport || null;
  s.curAct = '收敛';
  const detail = {};
  for (const a of record.acts || []) {
    const key = a.act || '';
    if (!key) continue;
    detail[key] = (detail[key] || []).concat([{ round: a.round, sub: a.sub, speeches: a.speeches || [] }]);
  }
  s.actsDetail = detail;
  s.activeTab = ACT_ORDER.find(a => detail[a] && detail[a].length) || '收敛';
  return s;
}

function _n(v, n = 1) {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(n) : '—';
}

function _pctNum(v) {
  const x = Number(v);
  return Number.isFinite(x) ? (x * 100).toFixed(0) + '%' : '—';
}

function _fmtScreenerDate(s) {
  const t = String(s || '');
  if (/^\d{8}$/.test(t)) return `${t.slice(0, 4)}-${t.slice(4, 6)}-${t.slice(6, 8)}`;
  return t || '—';
}

function _screenerRankHtml(title, rows, scoreKey) {
  const body = (rows || []).map((r, i) => {
    const score = scoreKey === 'setup' ? r.setup_score : r.chase_score;
    return `<div class="cm-scr-row">
      <div class="cm-scr-rank">${i + 1}</div>
      <div class="cm-scr-main"><b>${escapeHtml(r.name || r.code)}</b><span>${escapeHtml(r.code || '')} · ${escapeHtml(r.mode_cn || '')}</span></div>
      <div class="cm-scr-score">${_n(score, 1)}</div>
      <div class="cm-scr-tags"><span>RS ${_n(r.p_rs, 0)}</span><span>5日 ${_pctNum(r.ret5)}</span><span>量比 ${_n(r.vr, 2)}</span></div>
    </div>`;
  }).join('');
  return `<div class="cm-scr-card"><div class="cm-bt">${title}</div>${body || '<div class="cm-soft cm-empty">暂无候选</div>'}</div>`;
}

function screenerPanelHtml(state) {
  const s = state || initScreenerState();
  const r = s.result || {};
  const modeBadge = s.error ? '<span class="cm-badge cm-err-badge">失败</span>'
    : s.done ? '<span class="cm-badge cm-done">已生成</span>'
      : s.active ? '<span class="cm-badge cm-live"><span class="cm-dot"></span>初筛进行中</span>'
        : '<span class="cm-badge">技术初筛</span>';
  let h = `<div class="cm-phead" data-cm-drag><span class="cm-ptitle">📊 技术初筛</span>${modeBadge}<button type="button" class="cm-pclose" data-cm-panel-close title="关闭面板">×</button></div>`;
  h += `<div class="cm-pmeta">独立趋势龙雷达 · 与投委会解耦 · 快照 ${escapeHtml(_fmtScreenerDate(r.end_date))}</div>`;
  h += `<div class="cm-scr-progress"><div class="cm-scr-progress-bar" style="width:${Math.max(0, Math.min(100, s.percent || 0))}%"></div></div>`;
  h += `<div class="cm-scr-status"><b>${escapeHtml(s.stage || '')}</b><span>${escapeHtml(s.message || '')}</span><em>${Math.round(s.percent || 0)}%</em></div>`;
  if (s.error) h += `<div class="cm-danger">⚠ ${escapeHtml(s.error)}</div>`;
  if (!s.done || !r) {
    h += '<div class="cm-soft cm-empty">等待读取本地 kline-screener 快照并生成榜单</div>';
    return h;
  }
  h += `<div class="cm-scr-meta">
    <span>生成 ${escapeHtml(r.generated || '—')}</span>
    <span>候选 ${r.total || 0}</span>
    <span>追涨 ${r.chase_count || 0}</span>
    <span>蓄势 ${r.setup_count || 0}</span>
  </div>`;
  h += _screenerRankHtml('🚀 追涨候选 Top', r.top_chase || [], 'chase');
  h += _screenerRankHtml('🌱 蓄势低吸 Top', r.top_setup || [], 'setup');
  h += '<div class="cm-saf">结果来自本地 kline-screener 最新快照；若快照日期不是今天，界面会按快照日期展示。</div>';
  return h;
}

function panelHtml(state) {
  const s = state || initState();
  if (s.view === 'history') return historyPanelHtml(s);
  if (s.view === 'screener') return screenerPanelHtml(s);
  const stockTxt = (s.stocks || []).map(x => escapeHtml(x.name || x.code)).join(' / ');
  const modeBadge = s.error ? '<span class="cm-badge cm-err-badge">出错</span>'
    : s.viewingHistoryId ? '<span class="cm-badge cm-done">历史回看</span>'
      : s.done ? '<span class="cm-badge cm-done">已闭庭 · 回自由聊</span>'
        : s.active ? '<span class="cm-badge cm-live"><span class="cm-dot"></span>投委会自动巡航中</span>'
          : '<span class="cm-badge">投委会</span>';
  let h = `<div class="cm-phead" data-cm-drag><span class="cm-ptitle">⚖️ 玻璃房投委会</span>${modeBadge}<button type="button" class="cm-pback" data-cm-hist-open title="过往投委会">📋</button><button type="button" class="cm-pclose" data-cm-panel-close title="关闭面板">×</button></div>`;
  h += `<div class="cm-pmeta">标的：${stockTxt || '—'} · 主席 ${escapeHtml(s.chair || '—')}${s.actTotal ? ` · 辩论第 ${s.actRound}/${s.actTotal} 轮` : ''}</div>`;
  if (s.error) h += `<div class="cm-danger">⚠ ${escapeHtml(s.error)}</div>`;
  h += tabBarHtml(s);
  h += '<div class="cm-tabbody">' + actDetailHtml(s) + '</div>';
  h += '<div class="cm-pt">📋 总览（双榜 · 主席报告）</div>';
  h += '<div class="cm-pbody">' + boardsHtml(s.boards) + chairHtml(s.chairReport) + '</div>';
  return h;
}

const api = { ACT_ORDER, parseStocks, initState, initScreenerState, reduceProgress, reduceScreenerProgress, modalHtml, panelHtml, boardsHtml, chairHtml, actBarHtml, tabBarHtml, actDetailHtml, historyListHtml, recordToState, screenerPanelHtml, escapeHtml };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
if (typeof window !== 'undefined') window.committeeUICore = api;
