'use strict';
// core/writing/library-index.js
//
// 作品库索引：扫描旧作目录与写作台目录下的 Markdown，解析文件头，打题材标签，
// 提供筛选与全文搜索。索引只放内存，随时可以重建；用户手改的题材单独存在
// hub-state/library-overrides.json，重建不会丢。
//
// 文件头格式来自抓取脚本（tools/wx_article_to_md.py、csdn_collect.py）：
//   # 标题
//   - 公众号：PythonicStock        或  - 平台：CSDN（…）
//   - 发布日期：2023-04-12          （CSDN 带时分秒）
//   - 类型：图文 / 原创 / 非原创或未知…
//   - 原文链接：…
//   - 汉字数：1180
//   ---
//   正文

const fs = require('fs');
const path = require('path');

// 题材靠关键词打分：命中越多越像。这是自动初标，用户可在阅读区改。
const TOPIC_RULES = [
  { topic: '投资随笔', words: ['股', '赛力斯', 'A股', '大A', '目标价', '涨停', '跌停', '仓位', '牛市', '熊市', '券商', '市值', '江淮', '比亚迪', '基金', '抄底', '割肉'] },
  { topic: '无线通信', words: ['信道', 'MIMO', '波束', 'OFDM', '天线', '预编码', '通信', '基站', '频谱', 'SINR', '信噪比', '5G', '调度'] },
  { topic: '强化学习', words: ['强化学习', 'DQN', '策略梯度', 'Q值', 'reward', '奖励', 'Actor', 'Critic', 'Gym'] },
  { topic: '优化算法', words: ['优化', '凸', 'ADMM', '流形', '拉格朗日', '梯度下降', '迭代', '最优解', '约束', '启发式'] },
  { topic: 'AI 与 Agent', words: ['Agent', '大模型', 'Claude', 'Codex', 'ChatGPT', 'DeepSeek', 'LLM', '人工智能', 'AI'] },
  { topic: '编程工具', words: ['Python', 'python', 'pandas', 'pytorch', 'tensorflow', 'Matlab', 'matlab', '代码', '函数', 'numpy'] },
];
const LENGTH_BUCKETS = [
  { key: 'short', label: '短帖', max: 800 },
  { key: 'medium', label: '中篇', max: 3000 },
  { key: 'long', label: '长文', max: Infinity },
];

function cjkCount(text) {
  const m = String(text || '').match(/[一-鿿]/g);
  return m ? m.length : 0;
}

function lengthBucket(n) {
  return LENGTH_BUCKETS.find((b) => n < b.max).key;
}

function guessTopics(title, body) {
  const text = `${title}\n${title}\n${body}`;
  const scored = TOPIC_RULES.map(({ topic, words }) => ({
    topic,
    score: words.reduce((s, w) => s + (text.split(w).length - 1), 0),
  })).filter((x) => x.score >= 3).sort((a, b) => b.score - a.score);
  if (!scored.length) return ['生活随笔'];
  return scored.slice(0, 2).map((x) => x.topic);
}

function headerField(header, name) {
  const m = header.match(new RegExp(`^- ${name}：(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

// 解析一篇抓取来的文章；source 由所在目录决定（PythonicStock → 公众号，CSDN → CSDN）。
function parseArticle(relPath, text) {
  const sep = text.indexOf('\n---\n');
  const header = sep >= 0 ? text.slice(0, sep) : '';
  const body = sep >= 0 ? text.slice(sep + 5).trim() : text.trim();
  const titleLine = header.match(/^# (.+)$/m);
  const top = relPath.split('/')[0];
  const source = top === 'CSDN' ? 'CSDN' : top === 'PythonicStock' ? '公众号' : top;
  const date = (headerField(header, '发布日期') || '').slice(0, 10);
  const type = headerField(header, '类型');
  const cjk = Number(headerField(header, '汉字数')) || cjkCount(body);
  const title = titleLine ? titleLine[1].trim() : path.basename(relPath, '.md');
  return {
    id: relPath,
    title,
    source,
    date: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : '',
    year: /^\d{4}/.test(date) ? date.slice(0, 4) : '未知',
    type,
    original: source !== 'CSDN' || type === '原创',
    url: headerField(header, '原文链接'),
    cjk,
    lengthKey: lengthBucket(cjk),
    stem: path.basename(relPath, '.md'),
    excerpt: excerptOf(body),
    topics: guessTopics(title, body),
    status: '已发',
    body,
  };
}

function excerptOf(body) {
  const plain = String(body || '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\$\$[\s\S]*?\$\$/g, '［公式］')
    .replace(/```[\s\S]*?```/g, '［代码］')
    .replace(/[#>*`_\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.slice(0, 90);
}

function walkMarkdown(dir, out = []) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkMarkdown(full, out);
    else if (e.isFile() && e.name.endsWith('.md') && !e.name.startsWith('_')) out.push(full);
  }
  return out;
}

// 写作台的新作：<写作台根>/<日期时间>/ 一篇一个目录；有 final.md 才进作品库，标题取定稿第一行。
function scanPieces(piecesRoot) {
  const items = [];
  let dirs = [];
  try { dirs = fs.readdirSync(piecesRoot, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return items; }
  for (const p of dirs) {
    const dir = path.join(piecesRoot, p.name);
    let meta = {};
    try { meta = JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')); } catch { continue; }
    const finalFile = path.join(dir, 'final.md');
    if (!fs.existsSync(finalFile)) continue;
    const body = fs.readFileSync(finalFile, 'utf8').replace(/\r\n/g, '\n');
    const titleLine = body.match(/^#\s+(.+)$/m);
    const title = titleLine ? titleLine[1].trim() : '未命名新作';
    const cjk = cjkCount(body);
    const date = String(meta.createdAt || '').slice(0, 10);
    items.push({
      id: `写作台/${p.name}`,
      title,
      source: '新作',
      date,
      year: date.slice(0, 4) || '未知',
      type: '新作',
      original: true,
      url: '',
      cjk,
      lengthKey: lengthBucket(cjk),
      stem: p.name,
      excerpt: excerptOf(body.replace(/^#\s+.+$/m, '')),
      topics: guessTopics(title, body),
      status: '定稿',
      body,
      pieceDir: dir,
    });
  }
  return items;
}

class LibraryIndex {
  constructor(paths) {
    this.paths = paths;
    this.items = null;
    this.builtAt = 0;
  }

  overridesFile() { return path.join(this.paths.stateDir, 'library-overrides.json'); }

  readOverrides() {
    try { return JSON.parse(fs.readFileSync(this.overridesFile(), 'utf8')); } catch { return {}; }
  }

  build() {
    const items = [];
    for (const root of this.paths.libraryRoots) {
      for (const file of walkMarkdown(root)) {
        const rel = path.relative(root, file).split(path.sep).join('/');
        try { items.push(parseArticle(rel, fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'))); } catch { /* 单篇坏文件不影响整库 */ }
      }
    }
    items.push(...scanPieces(this.paths.piecesRoot));
    const overrides = this.readOverrides();
    for (const it of items) {
      if (overrides[it.id] && Array.isArray(overrides[it.id].topics)) it.topics = overrides[it.id].topics;
    }
    items.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
    this.items = items;
    this.builtAt = Date.now();
    return items;
  }

  ensure() { return this.items || this.build(); }

  // exemplarStems：范文出处里出现过的文件名（如 20230412-通信之道），用来给列表打星标
  list({ query = '', sources = [], years = [], topics = [], lengths = [], exemplarOnly = false, sort = 'date' } = {}, exemplarStems = new Set()) {
    const all = this.ensure();
    const q = String(query || '').trim().toLowerCase();
    let rows = all.map((it) => ({ ...it, exemplar: isExemplar(it.stem, exemplarStems) }));
    if (sources.length) rows = rows.filter((r) => sources.includes(r.source));
    if (years.length) rows = rows.filter((r) => years.includes(r.year));
    if (topics.length) rows = rows.filter((r) => r.topics.some((t) => topics.includes(t)));
    if (lengths.length) rows = rows.filter((r) => lengths.includes(r.lengthKey));
    if (exemplarOnly) rows = rows.filter((r) => r.exemplar);
    if (q) {
      rows = rows.filter((r) => r.title.toLowerCase().includes(q) || r.body.toLowerCase().includes(q));
      rows = rows.map((r) => ({ ...r, hit: snippet(r.body, q) }));
    }
    if (sort === 'length') rows.sort((a, b) => b.cjk - a.cjk);
    const stats = statsOf(all, exemplarStems);
    return { stats, total: rows.length, items: rows.map(({ body, ...rest }) => rest) };
  }

  get(id) {
    const it = this.ensure().find((x) => x.id === id);
    return it ? { ...it } : null;
  }
}

// 范文出处写的是文件名；早期出处可能只写了文件名的前半段，所以前缀匹配也算
function isExemplar(stem, exemplarStems) {
  if (exemplarStems.has(stem)) return true;
  for (const s of exemplarStems) if (s.length >= 10 && stem.startsWith(s)) return true;
  return false;
}

function snippet(body, q) {
  const i = body.toLowerCase().indexOf(q);
  if (i < 0) return '';
  const start = Math.max(0, i - 30);
  return (start > 0 ? '…' : '') + body.slice(start, i + q.length + 50).replace(/\s+/g, ' ') + '…';
}

function statsOf(all, exemplarStems) {
  const bySource = {};
  const byYear = {};
  const byTopic = {};
  let cjk = 0;
  for (const it of all) {
    bySource[it.source] = (bySource[it.source] || 0) + 1;
    byYear[it.year] = (byYear[it.year] || 0) + 1;
    for (const t of it.topics) byTopic[t] = (byTopic[t] || 0) + 1;
    cjk += it.cjk;
  }
  const years = Object.keys(byYear).filter((y) => y !== '未知').sort();
  return {
    total: all.length,
    cjk,
    bySource,
    byYear,
    byTopic,
    yearRange: years.length ? `${years[0]}—${years[years.length - 1]}` : '',
    exemplarCount: all.filter((it) => isExemplar(it.stem, exemplarStems)).length,
    lengths: LENGTH_BUCKETS.map((b) => ({ key: b.key, label: b.label, count: all.filter((it) => it.lengthKey === b.key).length })),
  };
}

module.exports = { isExemplar, LibraryIndex, parseArticle, guessTopics, cjkCount, TOPIC_RULES, LENGTH_BUCKETS };
