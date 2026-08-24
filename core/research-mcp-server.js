#!/usr/bin/env node
// Research Group Chat MCP server.
// Exposes aggregate stock tools (all backed by C:\research-mcp\query.py through Hub loopback):
//   stock_static(symbol, depth) - slow profile: gate/basic/financial/valuation/peers/holders/pledge/funds/research.
//   stock_market(symbol, depth, mode) - market view: price/indicators/flow/dragon-tiger/northbound/margin/realtime.
//   stock_news(symbol, depth)   - news view: announcements + Eastmoney stock news + CLS flash + market news.
//   scan_* tools                - market-wide discovery scans backed by research-mcp stock-scan.
//
// 历史下线工具：
//   fetch_lindang_stock / fetch_lindang_field 已于 2026-06-04 完全下线（三件套 stock_static/market/news 全覆盖）。
//   fetch_concept_stocks / fetch_sector_overview 已下线（依赖 Stock_top10 已删）。
// 单字段查询需求请走 Bash：`python C:\LinDangAgent\data_query.py <op> <symbol>`。
'use strict';

const http = require('http');

const MEETING_ID = process.env.ARENA_MEETING_ID || '';
const HUB_PORT = parseInt(process.env.ARENA_HUB_PORT || '0', 10);
const HOOK_TOKEN = process.env.ARENA_HOOK_TOKEN || '';
const AI_KIND = process.env.ARENA_AI_KIND || 'unknown';

const fs = require('fs');
const os = require('os');
const path = require('path');
const screenerScore = require('./screener-score');
const spiritRegistry = require('./spirit-registry');
const CHUXIN_ENABLED = process.env.ARENA_CHUXIN_ENABLED === '1';
let chuxinKnowledge = null;
if (CHUXIN_ENABLED) {
  try {
    const chuxinDir = process.env.CHUXIN_DIR || path.join(os.homedir(), 'chuxin-research');
    chuxinKnowledge = require(path.join(chuxinDir, 'mcp', 'knowledge-core.js'));
  } catch (error) {
    try { process.stderr.write('[arena-research-mcp] chuxin knowledge tools unavailable: ' + error.message + '\n'); } catch {}
  }
}

const HUB_DATA_DIR = process.env.ARENA_HUB_DATA_DIR || process.env.CLAUDE_HUB_DATA_DIR || '';

const DEBUG = process.env.ARENA_MCP_DEBUG === '1';
const LOG_FILE = DEBUG
  ? path.join(os.tmpdir(), 'arena-research-mcp-' + Date.now() + '-' + process.pid + '.log')
  : null;
function logErr(msg) {
  try { process.stderr.write('[arena-research-mcp] ' + msg + '\n'); } catch {}
  if (LOG_FILE) {
    try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + msg + '\n'); } catch {}
  }
}

logErr('startup pid=' + process.pid + ' meeting=' + MEETING_ID + ' port=' + HUB_PORT + ' kind=' + AI_KIND);

// Stub mode: 当 ARENA_* env 缺失（例如用户在终端独立跑 gemini，或非 research 群聊会议
// spawn gemini）时，server 不退出而是进入 stub —— 响应 initialize、tools/list 返回空，
// 避免 gemini settings.json 里全局注册的 arena-research server 在无 ARENA_* 环境下报错。
const STUB_MODE = !MEETING_ID || !HUB_PORT || !HOOK_TOKEN;
if (STUB_MODE) {
  logErr('no ARENA_* env detected, running in STUB mode (tools list will be empty)');
}

// --- MCP tools ---
const DEPTH_SCHEMA = {
  type: 'string',
  enum: ['brief', 'medium', 'full'],
  description: '返回深度：brief=核心摘要，medium=默认适中，full=尽量完整。默认 medium。',
};

const MARKET_MODE_SCHEMA = {
  type: 'string',
  enum: ['daily', 'intraday'],
  description: '行情模式：daily=日线/日终画像，intraday=追加可用的 QMT 实时快照。默认 daily。',
};

const SCAN_TYPES = {
  scan_market_breadth: 'market-breadth',
  scan_sector_flow: 'sector-flow',
  scan_northbound: 'northbound',
  scan_anomalies: 'anomalies',
  scan_dragon_tiger: 'dragon-tiger',
};

function scanTool(name, description) {
  return {
    name,
    description,
    inputSchema: {
      type: 'object',
      properties: { depth: DEPTH_SCHEMA },
      required: [],
    },
  };
}

const TOOLS = [
  ...((CHUXIN_ENABLED && chuxinKnowledge && chuxinKnowledge.TOOLS) || []),
  {
    name: 'spirit_list',
    description: '【英灵系统入口】列出中立注册表里的可用英灵、版本、规则数、支持的投资任务与系统宪法。英灵是方法论镜头，不是人格扮演；任何底座模型读取到的是同一份 manifest_hash。用户说“有哪些英灵/召唤谁/英灵系统”时先调。',
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
    },
  },
  {
    name: 'spirit_manifest',
    description: '【英灵规则审计】读取单个英灵的 manifest、规则卡、来源、弱点和内容哈希。需要解释“这位英灵依据什么/有哪些边界/是否原典”时调；不得把 A 股适配规则冒充历史人物原话。',
    inputSchema: {
      type: 'object',
      properties: {
        spirit_id: { type: 'string', description: '版本化英灵 ID，例如 buffett.mature.v1 或 livermore.trend.v1' },
        include_rules: { type: 'boolean', description: '是否返回完整规则；默认 true。' },
      },
      required: ['spirit_id'],
    },
  },
  {
    name: 'spirit_prepare',
    description: '【召唤英灵/生成统一 Lens Packet】把投资任务、问题和已冻结证据编译为底座无关的规则包。先用 stock_static/stock_market/stock_news 等工具取证，再把原样结果放入 evidence；返回的 rendered_prompt、规则编号、UNKNOWN 缺口和哈希就是本轮唯一英灵约束。可一次加载多位英灵做冲突审视。此工具只生成分析契约，绝不执行交易。',
    inputSchema: {
      type: 'object',
      properties: {
        spirit_ids: {
          type: 'array',
          minItems: 1,
          maxItems: 4,
          items: { type: 'string' },
          description: '英灵 ID；价值投机通常同时用 buffett.mature.v1 与 livermore.trend.v1。',
        },
        mandate: {
          type: 'string',
          enum: ['long_term_compound', 'trend_speculation', 'value_speculation'],
          description: '长期复利/趋势投机/价值投机。默认 value_speculation。',
        },
        question: { type: 'string', description: '本轮要英灵审视的明确问题。' },
        evidence: {
          type: 'object',
          description: '本轮冻结证据包；可包含 stock_static/market/news/sentiment 返回，不得自行补造。',
          additionalProperties: true,
        },
        output_format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Hub 对话默认 markdown；需要落结构化结果时用 json。',
        },
      },
      required: ['question'],
    },
  },
  {
    name: 'spirit_validate',
    description: '【英灵输出校验】在最终发言前校验结构化 JSON 是否覆盖全部已加载英灵、只引用已知 rule_id、保留人工签署要求且哈希一致。输入 spirit_prepare 返回的 packet 和候选 result；校验失败必须修正，不能静默跳过。',
    inputSchema: {
      type: 'object',
      properties: {
        packet: { type: 'object', additionalProperties: true },
        result: { type: 'object', additionalProperties: true },
      },
      required: ['packet', 'result'],
    },
  },
  // ─── 技术初筛量化分（本地读 kline-screener data.json，不走后端）─────
  {
    name: 'screener_score',
    description: '【技术初筛量化分，判断个股「追涨/蓄势(低吸)」技术形态时优先调】读 kline-screener 最新强势股筛选快照，返回该股 追涨分(chase_score)/蓄势分(setup_score) + 模式 + 关键技术指标(龙分/相对强度分位/偏离MA20/守MA20率/量比/缩量比等) + 形态白话摘要。\n\nmode=chase=追涨型(主升进行中：强势龙、均线多头、守MA20)；mode=setup=蓄势型(大涨后回调企稳、站上MA20、缩量，赌第二波，≈低吸)——恰好对应右侧追涨/低吸两种打法。\n\n[池内 vs 池外] **池内票**(当日强势候选,~240只)给客观量化分；**池外票**返回 available=false、in_pool=false，技术形态分须由 AI 基于 stock_market 行情自行研判，**禁止脑补量化分**。投委会技术面委员建库时优先调本工具拿客观锚，再用 stock_market 补充实时形态。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A股代码（"603823" / "603823.SH" / "SH603823"，6位代码，大小写/后缀容错）' },
      },
      required: ['symbol'],
    },
  },
  // ─── research-mcp 聚合工具（3 个）───────────────────────
  {
    name: 'stock_static',
    description: '【慢变维度，AI 第一次接触某只股优先调】拉 A 股单股的画像类信息：闸门(gate) + 基本面/估值面(pe_ttm/pb/ps/total_mv/total_share/close/industry/stock_name 等，平铺到顶层) + 财务摘要(financial) + 大股东(holders) + 股权质押(pledge) + 基金持仓(funds) + 同行对比(peers) + 券商研报(research_report)。\n\n[v2.0_jury 重要变化 2026-06] 估值/基本面字段现在不是裸数值，而是带可信度标签的对象：\n  { value, confidence, source_used, sources_tried, n_sources_ok, n_sources_tried, max_diff_pct?, outliers? }\nconfidence 5 档：\n  - HIGH：≥3 源容差内一致，可直接量化引用（"PE 25.3 倍"）\n  - MEDIUM：2 源一致，引用时声明 "仅 2 源验证"\n  - LOW：仅 1 源命中，必须声明 "数据未交叉验证"\n  - CONFLICT：多源冲突且无多数派，value=null，必须说 "存在源间冲突，待人工核查"，禁止编造数值\n  - UNAVAILABLE：所有源失败，value=null，必须说 "暂无数据"，禁止填默认值\n顶层 `_meta.warnings` 列出所有非 HIGH 字段；`valuation_history` 是 PE/PB 等历史序列（单源），`pe_percentile` 是当前 PE 在历史中的分位。后端 4 源并发（akshare 东财估值面 / 东财 datacenter / 雪球 / 腾讯）+ 自算市值兜底。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A股代码或名称（"600519" / "600519.SH" / "贵州茅台" 都可）' },
        depth: DEPTH_SCHEMA,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'stock_market',
    description: '【实时维度，讨论买卖时机/技术形态/资金动向时调】拉 A 股单股的行情和资金面：K线+走势摘要(price，多源 fallback) + 17 项技术指标(indicators，RSI/MACD/BB/OBV/ATR/KDJ/MFI/MA_score/volume_ratio/ADX/52w_pos) + 主力净流入(flow) + 融资融券(margin) + (intraday 模式追加 realtime_quote 实时价+盘口)。后端聚合 4-5 个原子 op 并行。\n\n[2026-06-06 瘦身] 已下线：龙虎榜 dragon-tiger（不适用于中线投资场景）/ 北向 northbound（akshare 接口 2024-08 后已死）/ depth=brief（AI 实战从未真用过）。剩余 4 个核心 op + 1 个 intraday 加项。\n\n[symbol 输入] 接受 "600519" / "600519.SH" / "SH600519"（大小写不敏感，前后空格容错）；中文名 / 格式冲突 / 空值会在入口立即拒绝。\n\n[indicators 信任标签 2026-06] 返回 indicators dict 顶层带 `kline_source`（基于哪个源的 K 线算出）+ `adjust_mode`（前复权 qfq / 后复权 hfq）+ `_jury`（LDA 算 vs 本地自算的容差比对结果，confidence 5 档）。AI 引用 RSI/MACD 前先看 _jury.confidence。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A股代码（"600519" / "600519.SH" / "SH600519"，不接受中文名）' },
        depth: {
          type: 'string',
          enum: ['medium', 'full'],
          description: '返回深度：medium=默认（rows trim 到 10 条）/ full=完整不裁剪。brief 已下线（传入会 silently 升级到 medium）。',
        },
        mode: MARKET_MODE_SCHEMA,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'stock_news',
    description: '【消息面，讨论催化剂/突发事件/定期报告时调】拉 A 股单股相关消息：公司公告(announcement,巨潮官方法定披露：年报/停牌/重大事项) + 个股新闻(东财直连，绕开 akshare pyarrow bug) + 财联社快讯 + 大盘新闻(market_news,财新主新闻)。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A股代码或名称' },
        depth: DEPTH_SCHEMA,
      },
      required: ['symbol'],
    },
  },
  {
    name: 'stock_sentiment',
    description: '【舆情面，评估散户/V大情绪+话题热度+争议焦点时调】拉 A 股单股在投资社区的高质量帖子：v1.2 覆盖东方财富股吧（列表 SSR + mguba getArticle API 详情双层抓，无登录无签名）；v2 计划补雪球（Playwright 登录）。每帖含**标题+正文摘要 800 字+完整作者画像+精确互动数+精确时间**，按 4 维综合分（quality 40% + author 25% + engage 20% + recency 15%）排序返回 Top N。\n\n[何时调] 用户问"散户怎么看 X"/"X 当前情绪如何"/"X 股吧/社区在说什么"/"X 有什么争议焦点"/"V 大对 X 的最新观点"/"X 的话题热度"——调本工具。区分：stock_news 是官方信息（公告/新闻/快讯），stock_sentiment 是**社区个人观点+正文**。两者性质互补，需要同时调时都调。\n\n[字段] top_posts[i] = {\n  site, post_id, url, title,\n  posted_at (精确到分钟 "2026-06-06T16:46"),\n  content (正文纯文本摘要，最多 800 字), full_content_chars (原始 HTML 字符数),\n  author{id, name, followers (粉丝数), verified (null/personal/company/official),\n        elite_count (代表影响力等级 0-10), level (注册年龄 "13.2年")},\n  reads, comments, likes, reposts (互动 4 维全),\n  is_subject_stock (本股 vs 跨股关联),\n  is_top, has_image, post_type,\n  score (0-100), score_breakdown {quality, author, engage, recency, weights}\n}。\n\n[depth] brief=5 / medium=10 / full=20（每站候选池 30/50/100；full 自动翻 2 页）。详情页并发抓取，单帖 ~150ms。\n\n[only_subject_stock] 默认 false=保留跨股讨论混入（如产业链 V 大对比帖、行业研报等，会自动 -8 沉底但保留）；true=只返回讨论本股的帖子。讨论"宁德电池 vs 比亚迪"这种关联帖时 false 更佳；要"纯宁德舆情"时设 true。\n\n[可观测] source_health[site] = {ok, fetched, latency_ms, error}；data_status: ok/degraded/failed；degraded=true 时声明"部分站源失败，结论参考价值打折"。\n\n[引用建议] 引用具体帖子时请带 url 让用户能点开看原帖；先读 content 摘要再下结论（**不要只看 title 瞎猜**）；is_subject_stock=true 用"宁德股吧讨论"、false 用"产业链 V 大跨股讨论"；高 author.followers/elite_count 的可点名引用为"X V 大说"；**不要直接说"散户都看多/看空"**，而是说"Top 帖子里 X 篇散户复盘 + Y 篇 V 大访谈，关注点集中在 ABC"。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A股代码（"600519"/"600519.SH"/"SH600519"，大小写不敏感）。**不接受中文名**：契约要求上游解析名字→码后再调本工具' },
        depth: DEPTH_SCHEMA,
        only_subject_stock: {
          type: 'boolean',
          description: '默认 false 保留跨股讨论（产业链关联帖）；true 仅讨论本股的帖。',
        },
        format: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: '返回格式：markdown=默认，LLM 友好（带概览统计+卡片化每帖）；json=精确字段（AI 需要编程式处理时用）。',
        },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'kline_similarity',
    description: '【历史相似 K 线检索】给定 A 股代码 + 窗口长度，在全市场 5207 只股 × 近 10 年日线中检索 Top-K 最相似的历史片段。每个片段附带后续 5/20/60 日累计涨跌幅（forward_*d_ret），给 LLM 做投研解读。\n\n[何时调] 用户问"现在 X 的走势像不像历史上某段"/"历史上类似形态后来怎么走"/"找几个像现在这样放量大跌的案例"/"X 近期形态有无历史对照"——调本工具。结果由 LLM 做语义解读，不做业务过滤。\n\n[算法 v2 2026-06-10] 4 种 method 可选：\n  • **ensemble**（默认推荐）— **RRF 倒数排名融合**3 方法：STUMPY 单 close 形状 + 4 通道欧氏 + 4 通道 DTW-I。学术经典 ensemble retrieval。每个候选返回它在 3 个方法各自的 rank，"S/E/D 三个数都靠前" = 强共识、伪命中少。无短板候选会被顶到前面。\n  • **matrix_profile** — STUMPY Matrix Profile z-norm 欧氏，只看 close 单通道形状，最快（~5s），但量价信息丢失。AI 想"快速看一眼"时用。\n  • **multi_channel_euclidean** — 4 通道（close_ret + volume_log + body_pct + daily_amplitude）欧氏，多维度但严格时间对齐。不容忍节奏微漂。\n  • **dtw_rerank** — 4 通道 DTW-I + Sakoe-Chiba 10% 窗口约束，容忍 ±1-2 天节奏微漂。Keogh 2017 金融最佳实践。\n  Cascade 架构：Stage 1 STUMPY 召回 Top-100/300 → Stage 2 多通道精排。**索引每日 17:30 自动刷新**。\n\n[ensemble 返回字段] top_k[i] = {\n  ts_code, start_date, end_date,\n  rrf_score (RRF 综合分，越大越像),\n  rank_in_methods: { stumpy_close, euclidean_4ch, dtw_4ch }  // 该候选在 3 方法中的 rank，三个都 ≤10 = 强共识\n  sims: { stumpy_close, euclidean_4ch, dtw_4ch }  // 各方法相似度（量纲不同不可直接比）\n  forward_5d_ret / forward_20d_ret / forward_60d_ret  // 后续涨跌幅（null = 数据不够）\n}\n\n[matrix_profile / multi_channel_euclidean / dtw_rerank 返回字段]\n  matrix_profile: sim_full20 / sim_recent5 / sim_combined (几何平均，默认排序键) / _distance\n  multi_channel_euclidean / dtw_rerank: sim_dtw_4ch / dtw_distance / dtw_channel_dists (4 通道分量)\n\n[4 通道含义] close_ret = 当日收益率 · volume_log = log(1+volume) 量级 · body_pct = (close-open)/open 实体 · daily_amplitude = (high-low)/open 日振幅。覆盖你说"放量大跌+缩量收红十字"这类量价语言。\n\n[引用建议] 默认调 ensemble；同时呈现"涨"和"跌"两类历史案例避免幸存者偏差；rank_in_methods 三个都 ≤5 → 强力推荐；某个 method rank >50 → 单方法偏见，谨慎；明确说"历史相似不等于未来一定如此"。引用时报 ts_code + 起止日期 + 后续 60d 涨跌幅。\n\n[性能] 默认 ensemble 首次冷启动 ~30s（拉 OHLCV），后续 disk cache 命中 ~5-10s。matrix_profile 始终 ~5s。索引 252MB pickle + per-symbol OHLCV ~100KB。',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'A 股代码（"600519" / "600519.SH" / "SH600519"，大小写不敏感）' },
        window: {
          type: 'integer',
          enum: [10, 20, 30, 60, 120],
          description: '查询窗口（交易日）。默认 20（≈1 月，短期形态最常用）。60 适合看趋势/季报节奏。',
        },
        top_k: { type: 'integer', description: '返回相似案例数，默认 10。最大 30。' },
        method: {
          type: 'string',
          enum: ['ensemble', 'matrix_profile', 'multi_channel_euclidean', 'dtw_rerank'],
          description: '算法。默认 ensemble（RRF 3 方法融合，最稳健）。matrix_profile 最快（5s）但量价信息丢失。multi_channel_euclidean / dtw_rerank 单独看时用。',
        },
        feature: {
          type: 'string',
          enum: ['close', 'pct_chg', 'volume'],
          description: 'Stage 1 STUMPY 召回用的特征序列。默认 close。Stage 2 始终用 4 通道（close_ret/volume/body/amp）。',
        },
        exclude_self_recent: {
          type: 'integer',
          description: '排除目标股自身最近 N 日（防自相关）。默认 60。设 0 即不排除。',
        },
      },
      required: ['symbol'],
    },
  },
  scanTool('scan_market_breadth', '【市场发现】扫描 A 股赚钱效应、涨跌分布、成交额 Top、涨跌幅 Top。'),
  scanTool('scan_sector_flow', '【市场发现】扫描行业/概念资金流排名，用于找主线和板块热度。'),
  scanTool('scan_northbound', '【市场发现】扫描北向持股/排行候选，用于外资线索。'),
  scanTool('scan_anomalies', '【市场发现】扫描异常量比、振幅、接近涨跌停的股票。'),
  scanTool('scan_dragon_tiger', '【市场发现】扫描近期龙虎榜候选，用于游资/机构席位线索。'),
];

// --- Markdown renderer for stock_sentiment ---
// 把 fetcher 返回的 JSON 渲染成 LLM 友好的 markdown 卡片。
// AI 阅读效率比原 JSON 高 ~40%（去字段名噪音、去 null、扁平化作者/互动行）。
function renderSentimentMarkdown(data) {
  const out = [];
  const posts = data.top_posts || [];

  // ── Header ────────────────────────────────
  out.push(`# ${data.symbol} 舆情 · Top ${data.returned_count}`);
  out.push('');
  const srcSummary = Object.entries(data.source_health || {})
    .map(([s, h]) => `${s}=${h.ok ? `ok(${h.fetched}帖/${h.latency_ms}ms)` : `FAIL(${h.error})`}`)
    .join(' · ');
  out.push(`**${data.fetched_at}** · 候选池 ${data.total_pool_size} · 总耗时 ${data.elapsed_ms}ms · 状态 ${data.data_status}${data.degraded ? ' ⚠️ degraded' : ''}`);
  out.push(`**源**: ${srcSummary}`);
  if (data.only_subject_stock) {
    out.push(`**过滤**: only_subject_stock=true（剔除 ${data.subject_filter_dropped} 条跨股帖）`);
  }
  out.push('');

  // ── 整体特征 自动统计 ──────────────────────
  const longArticles = posts.filter(p => (p.full_content_chars || 0) > 1500).length;
  const cfh = posts.filter(p => (p.url || '').includes('caifuhao')).length;
  const subject = posts.filter(p => p.is_subject_stock).length;
  const cross = posts.length - subject;
  out.push(`## 概览`);
  out.push(`- **${longArticles}** 篇长文（>1500 字）· **${posts.length - longArticles}** 篇短帖`);
  out.push(`- **${subject}** 篇本股 · **${cross}** 篇跨股关联`);
  out.push(`- **${cfh}** 篇财富号 V 大文章`);
  out.push('');
  out.push('---');
  out.push('');

  // ── 每帖卡片 ──────────────────────────────
  posts.forEach((p, i) => {
    const rank = i + 1;
    const subj = p.is_subject_stock ? '本股' : '跨股';
    const typ = p.post_type || 'post';
    const ts = p.posted_at || '未知时间';
    const score = (p.score != null ? p.score : 0).toFixed(1);

    out.push(`## #${rank} ⭐${score} · ${subj} · ${typ} · ${ts}`);
    out.push('');
    out.push(`### ${p.title || '(无标题)'}`);
    out.push('');

    // 作者一行（紧凑）
    const a = p.author || {};
    const authorParts = [a.name || '匿名'];
    if (a.followers && a.followers > 0) authorParts.push(`粉丝 ${a.followers}`);
    if (a.elite_count != null) authorParts.push(`影响力 ${a.elite_count}/10`);
    if (a.level) authorParts.push(`注册 ${a.level}`);
    if (a.verified) authorParts.push(`认证 ${a.verified}`);
    out.push(`> 👤 ${authorParts.join(' · ')}`);

    // 互动一行
    const stats = [];
    if (p.reads != null) stats.push(`阅读 ${p.reads}`);
    if (p.comments != null) stats.push(`评论 ${p.comments}`);
    if (p.likes != null && p.likes > 0) stats.push(`赞 ${p.likes}`);
    if (p.reposts != null && p.reposts > 0) stats.push(`转 ${p.reposts}`);
    if (stats.length) out.push(`> 📊 ${stats.join(' · ')}`);
    out.push('');

    // 正文摘要（默认 250 字；调 fetch_post_detail 拉全文）
    if (p.content) {
      out.push(p.content);
      if (p.full_content_chars && p.full_content_chars > (p.content.length + 10)) {
        out.push('');
        out.push(`*（共 ${p.full_content_chars} 字，需全文请调 \`fetch_post_detail("${p.url}")\`）*`);
      }
    }
    out.push('');

    out.push(`🔗 ${p.url}`);
    out.push('');
    out.push('---');
    out.push('');
  });

  // ── 次级池（雪球等）─ 紧凑表 + URL ──────
  const secondary = data.secondary_pools || {};
  for (const [site, items] of Object.entries(secondary)) {
    if (!items || !items.length) continue;
    out.push(`## ${site} 候选池 (${items.length} 帖) — 摘要 + URL`);
    out.push('');
    out.push(`> 这些是次级源（${site}）的待选帖。AI 看完摘要后，认为有深入价值的请调 \`fetch_post_detail("URL")\` 拉全文。`);
    out.push('');
    items.forEach((p, i) => {
      const rank = i + 1;
      const ts = p.posted_at || '?';
      const author = p.author_name || '?';
      const title = (p.title || '').replace(/\n/g, ' ').slice(0, 60);
      const preview = (p.preview || '').replace(/\n/g, ' ').slice(0, 120);
      out.push(`**${rank}.** [${ts}] **${author}** · ${title}`);
      if (preview) out.push(`   > ${preview}${p.preview_chars && p.preview_chars > preview.length ? '…' : ''}`);
      out.push(`   🔗 ${p.url}`);
      out.push('');
    });
    out.push('---');
    out.push('');
  }

  // ── 尾部元信息（给 AI 看，必要时引用） ──────
  out.push(`## 元信息`);
  out.push(`- 评分公式: ${data.scoring_formula || 'quality 40% + author 25% + engage 20% + recency 15%'}`);
  out.push(`- depth: ${data.depth} · returned ${data.returned_count} / pool ${data.total_pool_size}`);
  if (data.secondary_pool_counts) {
    const sec = Object.entries(data.secondary_pool_counts).map(([s, n]) => `${s}=${n}`).join(', ');
    out.push(`- 次级池: ${sec}`);
  }
  if (data.failed_sites && data.failed_sites.length) {
    out.push(`- 失败的源: ${data.failed_sites.join(', ')}`);
  }
  out.push(`- 深入单帖: 调 \`fetch_post_detail(url)\` 拉全文（支持东财 guba / 财富号 / 雪球）`);
  return out.join('\n');
}

// --- HTTP helper ---
// Plan 2: 默认 200s 给 stock_static（9 个 op 并行，180s bridge 超时 + 20s 余量）留足。
function postFetch(endpoint, body, timeoutMs = 200000) {
  return new Promise((resolve) => {
    const data = JSON.stringify(body);
    const req = http.request({
      hostname: '127.0.0.1',
      port: HUB_PORT,
      path: endpoint,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
      timeout: timeoutMs,
    }, (res) => {
      let chunks = '';
      res.on('data', (c) => { chunks += c; });
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body: chunks }));
    });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: 'request error: ' + e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.write(data);
    req.end();
  });
}

// --- JSON-RPC over stdio ---
function send(msg) {
  try { process.stdout.write(JSON.stringify(msg) + '\n'); } catch (e) { logErr('stdout write failed: ' + e.message); }
}
function reply(id, result) { if (id != null) send({ jsonrpc: '2.0', id, result }); }
function replyError(id, code, message) { if (id != null) send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function handleRequest(req) {
  const { id, method, params } = req || {};
  if (method === 'initialize') {
    return reply(id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'stock-research', version: '2.0.0' },
    });
  }
  if (method === 'notifications/initialized') {
    return;
  }
  if (method === 'tools/list') {
    return reply(id, { tools: STUB_MODE ? [] : TOOLS });
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const args = (params && params.arguments) || {};
    if (CHUXIN_ENABLED && chuxinKnowledge && chuxinKnowledge.hasTool(name)) {
      try {
        const text = await chuxinKnowledge.callTool(name, args);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: '初心工具失败：' + (e && e.message) }], isError: true });
      }
    }
    if (STUB_MODE) {
      return replyError(id, -32601, 'stock-research server in stub mode (not in research group chat)');
    }
    const baseBody = { token: HOOK_TOKEN, meetingId: MEETING_ID, kind: AI_KIND };

    // ── 模型无关英灵注册表：统一规则、证据哈希与输出契约 ──────────
    if (name === 'spirit_list') {
      try {
        const data = spiritRegistry.list();
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'spirit_list 失败：' + (e && e.message) }], isError: true });
      }
    }

    if (name === 'spirit_manifest') {
      const spiritId = String(args.spirit_id || '').trim();
      if (!spiritId) return reply(id, { content: [{ type: 'text', text: '错误：spirit_id 参数必填' }], isError: true });
      try {
        const data = spiritRegistry.manifest(spiritId, { includeRules: args.include_rules !== false });
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'spirit_manifest 失败：' + (e && e.message) }], isError: true });
      }
    }

    if (name === 'spirit_prepare') {
      const question = String(args.question || '').trim();
      if (!question) return reply(id, { content: [{ type: 'text', text: '错误：question 参数必填' }], isError: true });
      const mandate = ['long_term_compound', 'trend_speculation', 'value_speculation'].includes(args.mandate)
        ? args.mandate : 'value_speculation';
      const spiritIds = Array.isArray(args.spirit_ids) && args.spirit_ids.length
        ? args.spirit_ids.map(value => String(value || '').trim()).filter(Boolean)
        : undefined;
      try {
        const packet = spiritRegistry.prepare({
          spirit_ids: spiritIds,
          mandate,
          question,
          evidence: args.evidence && typeof args.evidence === 'object' ? args.evidence : {},
          output_format: args.output_format === 'json' ? 'json' : 'markdown',
          host: 'ai-hub-research-groupchat',
          base_model: AI_KIND,
        });
        try {
          const auditPath = spiritRegistry.appendAudit({
            hubDataDir: HUB_DATA_DIR,
            meetingId: MEETING_ID,
            aiKind: AI_KIND,
            action: 'prepare',
            packet,
          });
          if (!auditPath) throw new Error('审计路径不可用');
        } catch (auditError) {
          logErr('spirit audit append failed: ' + auditError.message);
          return reply(id, { content: [{ type: 'text', text: 'spirit_prepare 审计落盘失败：' + auditError.message }], isError: true });
        }
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(packet, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'spirit_prepare 失败：' + (e && e.message) }], isError: true });
      }
    }

    if (name === 'spirit_validate') {
      try {
        const validated = spiritRegistry.validate(args.packet, args.result);
        try {
          const auditPath = spiritRegistry.appendAudit({
            hubDataDir: HUB_DATA_DIR,
            meetingId: MEETING_ID,
            aiKind: AI_KIND,
            action: 'validate',
            packet: args.packet,
            details: { valid: true },
          });
          if (!auditPath) throw new Error('审计路径不可用');
        } catch (auditError) {
          logErr('spirit validation audit append failed: ' + auditError.message);
          return reply(id, { content: [{ type: 'text', text: 'spirit_validate 审计落盘失败：' + auditError.message }], isError: true });
        }
        return reply(id, { content: [{ type: 'text', text: JSON.stringify(validated, null, 2) }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'spirit_validate 失败：' + (e && e.message) }], isError: true });
      }
    }

    // ── screener_score：本地读 kline-screener data.json，不走后端 ──
    if (name === 'screener_score') {
      const symbol = String(args.symbol || '');
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      try {
        const text = screenerScore.promptBlock(symbol);
        return reply(id, { content: [{ type: 'text', text }] });
      } catch (e) {
        return reply(id, { content: [{ type: 'text', text: 'screener_score 失败：' + (e && e.message) }], isError: true });
      }
    }

    // ── 3 个聚合工具，调 research-mcp/query.py ────────────
    if (name === 'stock_static') {
      const symbol = String(args.symbol || '');
      const depth = ['brief', 'medium', 'full'].includes(args.depth) ? args.depth : 'medium';
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      const r = await postFetch('/api/research/stock-static', { ...baseBody, symbol, depth });
      const text = r.ok ? r.body : `stock-static 失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    if (name === 'stock_market') {
      const symbol = String(args.symbol || '');
      const depth = ['brief', 'medium', 'full'].includes(args.depth) ? args.depth : 'medium';
      const mode = ['daily', 'intraday'].includes(args.mode) ? args.mode : 'daily';
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      const r = await postFetch('/api/research/stock-market', { ...baseBody, symbol, depth, mode });
      const text = r.ok ? r.body : `stock-market 失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    if (name === 'stock_news') {
      const symbol = String(args.symbol || '');
      const depth = ['brief', 'medium', 'full'].includes(args.depth) ? args.depth : 'medium';
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      const r = await postFetch('/api/research/stock-news', { ...baseBody, symbol, depth });
      const text = r.ok ? r.body : `stock-news 失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    if (name === 'stock_sentiment') {
      const symbol = String(args.symbol || '');
      const depth = ['brief', 'medium', 'full'].includes(args.depth) ? args.depth : 'medium';
      const only_subject_stock = !!args.only_subject_stock;
      // format: markdown（默认，LLM 友好）/ json（AI 需要精确字段编程式处理时切）
      const format = (args.format === 'json') ? 'json' : 'markdown';
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      const r = await postFetch('/api/research/stock-sentiment', { ...baseBody, symbol, depth, only_subject_stock });
      if (!r.ok) {
        return reply(id, { content: [{ type: 'text', text: `stock-sentiment 失败（${r.status}）：${r.body}` }], isError: true });
      }
      // 成功：默认渲染 markdown；format=json 时回原 JSON
      if (format === 'json') {
        return reply(id, { content: [{ type: 'text', text: r.body }] });
      }
      try {
        const data = JSON.parse(r.body);
        // [v2.0] Python 端已预渲染 markdown 字段，直接透传
        if (data && typeof data.markdown === 'string' && data.markdown.length > 100) {
          return reply(id, { content: [{ type: 'text', text: data.markdown }] });
        }
        // fallback：JS 端旧 renderer（v1.x 兼容）
        const md = renderSentimentMarkdown(data);
        return reply(id, { content: [{ type: 'text', text: md }] });
      } catch (e) {
        logErr('markdown render failed: ' + e.message);
        return reply(id, { content: [{ type: 'text', text: r.body }] });
      }
    }

    if (name === 'kline_similarity') {
      const symbol = String(args.symbol || '');
      if (!symbol) return reply(id, { content: [{ type: 'text', text: '错误：symbol 参数必填' }], isError: true });
      const window = [10, 20, 30, 60, 120].includes(args.window) ? args.window : 20;
      const top_k = Number.isInteger(args.top_k) && args.top_k > 0 && args.top_k <= 30 ? args.top_k : 10;
      const VALID_METHODS = ['ensemble', 'matrix_profile', 'multi_window', 'dtw_rerank', 'multi_channel_euclidean'];
      const method = VALID_METHODS.includes(args.method) ? args.method : 'ensemble';
      const feature = ['close', 'pct_chg', 'volume'].includes(args.feature) ? args.feature : 'close';
      const exclude_self_recent = Number.isInteger(args.exclude_self_recent) && args.exclude_self_recent >= 0
        ? args.exclude_self_recent : 60;
      const r = await postFetch('/api/research/kline-similarity', {
        ...baseBody, symbol, window, top_k, method, feature, exclude_self_recent,
      });
      const text = r.ok ? r.body : `kline-similarity 失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    if (Object.prototype.hasOwnProperty.call(SCAN_TYPES, name)) {
      const depth = ['brief', 'medium', 'full'].includes(args.depth) ? args.depth : 'medium';
      const r = await postFetch('/api/research/stock-scan', { ...baseBody, scan_type: SCAN_TYPES[name], depth });
      const text = r.ok ? r.body : `${name} 失败（${r.status}）：${r.body}`;
      return reply(id, { content: [{ type: 'text', text }], isError: !r.ok });
    }

    return replyError(id, -32601, 'unknown tool: ' + name);
  }
  return replyError(id, -32601, 'method not found: ' + method);
}

// --- diagnostic heartbeat ---
if (DEBUG) {
  let _hb = 0;
  const _hbI = setInterval(() => {
    _hb++;
    logErr('heartbeat #' + _hb);
    if (_hb >= 30) clearInterval(_hbI);
  }, 2000);
}

// --- stdin line buffer ---
let buf = '';
process.stdin.on('data', (chunk) => {
  if (DEBUG) logErr('stdin chunk: ' + chunk.length + ' bytes');
  buf += chunk.toString('utf-8');
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    let req;
    try { req = JSON.parse(line); } catch (e) { logErr('parse failed: ' + e.message); continue; }
    if (DEBUG) logErr('handling method=' + req.method + ' id=' + req.id);
    Promise.resolve(handleRequest(req)).catch((e) => {
      logErr('handler error: ' + e.message);
      replyError(req.id, -32603, 'internal error: ' + e.message);
    });
  }
});
process.stdin.on('end', () => { logErr('stdin ended'); process.exit(0); });
process.stdin.on('error', (e) => logErr('stdin error: ' + e.message));
process.stdin.on('close', () => logErr('stdin closed'));
process.on('SIGTERM', () => { logErr('SIGTERM received'); process.exit(0); });
process.on('exit', (code) => logErr('process exit code=' + code));
