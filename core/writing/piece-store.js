'use strict';
// core/writing/piece-store.js
//
// 写作台的单篇文章：<写作台根>/<系列>/<YYYYMMDD-篇名>/ 一篇一个目录，全是普通文件，
// 不开 Hub 也能看、能改：
//   piece.json    阶段与元数据（Hub 维护）
//   brief.md      访谈后的 brief（每次保存时由 piece.json 重新生成）
//   drafts/*.md   各份草稿
//   review.md     审阅批注（人可读版本；结构化批注在 piece.json）
//   final.md      定稿
//   diff.md       定稿与胜出稿的改动对比

const fs = require('fs');
const path = require('path');

const DEFAULT_SERIES = ['当无线通信遇上 Agent', '控制变量', '随笔'];
const STAGES = ['interview', 'draft', 'blind', 'review', 'final', 'reflow'];
const STAGE_LABEL = { interview: '访谈', draft: '起草', blind: '盲选', review: '审阅', final: '定稿', reflow: '回流' };

function safeName(s) {
  return String(s || '').replace(/[\\/:*?"<>|\s]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50) || '未命名';
}

// 系列名直接做目录名：只去掉 Windows 不允许的字符，保留空格（「当无线通信遇上 Agent」不该变成带横杠的另一个系列）
function safeSeries(s) {
  return String(s || '').replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, ' ').trim().slice(0, 40) || DEFAULT_SERIES[0];
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

class PieceStore {
  constructor(paths) {
    this.root = paths.piecesRoot;
  }

  // 目录必须落在写作台根下，防止渲染层传入任意路径被读写
  resolve(dir) {
    const full = path.resolve(dir);
    const root = path.resolve(this.root);
    if (!full.startsWith(root + path.sep)) throw new Error('篇目目录不在写作台根下');
    return full;
  }

  listSeries() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* 还没建 */ }
    return Array.from(new Set([...DEFAULT_SERIES, ...dirs]));
  }

  listPieces(series) {
    const dir = path.join(this.root, safeSeries(series));
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return []; }
    return entries.map((e) => {
      const full = path.join(dir, e.name);
      const meta = this.readMeta(full);
      return meta ? { dir: full, title: meta.title, stage: meta.stage, updatedAt: meta.updatedAt } : null;
    }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }

  create({ series, title }) {
    const s = safeSeries(series);
    const t = String(title || '').trim();
    if (!t) throw new Error('标题不能为空');
    let dir = path.join(this.root, s, `${today()}-${safeName(t)}`);
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(this.root, s, `${today()}-${safeName(t)}-${i}`);
    fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
    const now = new Date().toISOString();
    const meta = {
      title: t,
      series: s,
      stage: 'interview',
      createdAt: now,
      updatedAt: now,
      brief: { reader: '', question: '', thesis: '', notes: '', section: '', length: '1500-2500' },
      qa: [],
      quotes: [],
      drafts: [],
      blind: { layout: 'three', scores: {}, marks: {}, picks: {}, winner: null, revealed: false, stitched: null },
      review: { provider: null, status: 'idle', items: [] },
      final: { savedAt: null },
      reflow: { ratio: null, diffFile: null },
    };
    this.writeMeta(dir, meta);
    return { dir, meta };
  }

  readMeta(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')); } catch { return null; }
  }

  writeMeta(dir, meta) {
    meta.updatedAt = new Date().toISOString();
    fs.writeFileSync(path.join(dir, 'piece.json'), JSON.stringify(meta, null, 2), 'utf8');
    fs.writeFileSync(path.join(dir, 'brief.md'), renderBrief(meta), 'utf8');
  }

  get(dir) {
    const full = this.resolve(dir);
    const meta = this.readMeta(full);
    if (!meta) throw new Error('篇目不存在或 piece.json 损坏');
    const drafts = (meta.drafts || []).map((d) => ({ ...d, text: d.file ? this.readFile(full, d.file) : '' }));
    return { dir: full, meta: { ...meta, drafts }, final: this.readFile(full, 'final.md') };
  }

  // 浅合并顶层字段；drafts 等数组整体替换
  update(dir, patch) {
    const full = this.resolve(dir);
    const meta = this.readMeta(full);
    if (!meta) throw new Error('篇目不存在');
    const next = { ...meta, ...patch };
    this.writeMeta(full, next);
    return next;
  }

  mutate(dir, fn) {
    const full = this.resolve(dir);
    const meta = this.readMeta(full);
    if (!meta) throw new Error('篇目不存在');
    fn(meta);
    this.writeMeta(full, meta);
    return meta;
  }

  readFile(dir, rel) {
    try { return fs.readFileSync(path.join(this.resolve(dir), rel), 'utf8'); } catch { return ''; }
  }

  writeFile(dir, rel, text) {
    const full = path.join(this.resolve(dir), rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text, 'utf8');
    return full;
  }
}

function renderBrief(meta) {
  const b = meta.brief || {};
  const lines = [
    `# ${meta.title}`,
    '',
    `- 系列：${meta.series}`,
    `- 读者：${b.reader || '（未填）'}`,
    `- 要回答的主问题：${b.question || '（未填）'}`,
    `- 一句话核心判断：${b.thesis || '（未填）'}`,
    `- 这次写哪一节：${b.section || '整篇'}`,
    `- 目标长度：约 ${b.length || '1500-2500'} 字`,
    '',
    '## 要点与素材',
    '',
    b.notes || '（未填）',
  ];
  if ((meta.quotes || []).length) {
    lines.push('', '## 摘句（可以用，不必全用）', '', ...meta.quotes.map((q) => `> ${q.text}\n\n（${q.source}）\n`));
  }
  const answered = (meta.qa || []).filter((x) => String(x.a || '').trim());
  if (answered.length) {
    lines.push('', '## 访谈', '');
    for (const x of answered) lines.push(`**问：${x.q}**`, '', x.a, '');
  }
  return lines.join('\n') + '\n';
}

module.exports = { PieceStore, STAGES, STAGE_LABEL, DEFAULT_SERIES, renderBrief, safeName, safeSeries };
