'use strict';
// core/writing/piece-store.js
//
// 写作台的文章：<写作台根>/<YYYYMMDD-HHmmss>/ 一篇一个目录，也是这篇文章写作群聊的工作目录。
// 2026-09-30 田哥体验后简化：不要系列、不要标题（标题由 AI 在群聊里提出，从稿件第一行读）。
//
//   piece.json    群聊 id、创建时间、文风自动优化的状态（Hub 维护）
//   drafts/*.md   群里每位 AI 的稿（AI 按写作群规则自己保存）
//   final.md      汇总改定的定稿
//   手写稿.md     田哥自己汇总的一稿（写作 Tab 的「田哥手写」页，2026-10-15）；不在 drafts/ 里，不会被当成 AI 的稿
//   .vibe-root    让 Codex 把文章目录当项目根，不再往上读工作根的工程规则

const fs = require('fs');
const path = require('path');

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

function titleOf(markdown) {
  const m = String(markdown || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/^《|》$/g, '') : '';
}

class PieceStore {
  constructor(paths) {
    this.root = paths.piecesRoot;
  }

  // 目录必须落在写作台根下，防止渲染层传入任意路径被读写
  resolve(dir) {
    const full = path.resolve(dir);
    const root = path.resolve(this.root);
    if (!full.startsWith(root + path.sep)) throw new Error('文章目录不在写作台根下');
    return full;
  }

  create() {
    let dir = path.join(this.root, stamp());
    for (let i = 2; fs.existsSync(dir); i++) dir = path.join(this.root, `${stamp()}-${i}`);
    fs.mkdirSync(path.join(dir, 'drafts'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.vibe-root'), '', 'utf8');
    this.writeMeta(dir, { createdAt: new Date().toISOString(), meetingId: null, voice: null });
    return dir;
  }

  readMeta(dir) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, 'piece.json'), 'utf8')); } catch { return null; }
  }

  writeMeta(dir, meta) {
    fs.writeFileSync(path.join(dir, 'piece.json'), JSON.stringify(meta, null, 2), 'utf8');
  }

  mutate(dir, fn) {
    const full = this.resolve(dir);
    const meta = this.readMeta(full) || {};
    fn(meta);
    this.writeMeta(full, meta);
    return meta;
  }

  drafts(dir) {
    const d = path.join(dir, 'drafts');
    let files = [];
    try { files = fs.readdirSync(d).filter((f) => f.endsWith('.md')); } catch { /* 还没有稿 */ }
    return files.map((f) => {
      const full = path.join(d, f);
      const text = readText(full);
      return { name: f.replace(/\.md$/, ''), file: full, text, mtime: fs.statSync(full).mtimeMs };
    }).sort((a, b) => a.mtime - b.mtime);
  }

  summary(dir) {
    const full = this.resolve(dir);
    const meta = this.readMeta(full) || {};
    const drafts = this.drafts(full);
    const finalFile = path.join(full, 'final.md');
    const final = readText(finalFile);
    const finalMtime = final ? fs.statSync(finalFile).mtimeMs : 0;
    const title = titleOf(final) || titleOf((drafts[drafts.length - 1] || {}).text) || '';
    return {
      dir: full,
      name: path.basename(full),
      createdAt: meta.createdAt,
      meetingId: meta.meetingId || null,
      title,
      drafts: drafts.map((d) => ({ name: d.name, title: titleOf(d.text), chars: (d.text.match(/[一-鿿]/g) || []).length })),
      hasFinal: !!final.trim(),
      finalMtime,
      voice: meta.voice || null,
    };
  }

  list() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => path.join(this.root, d.name)); } catch { return []; }
    return dirs.filter((d) => fs.existsSync(path.join(d, 'piece.json'))).map((d) => this.summary(d))
      .sort((a, b) => String(b.name).localeCompare(String(a.name)));
  }

  readFinal(dir) { return readText(path.join(this.resolve(dir), 'final.md')); }

  /* 田哥手写：AI 给素材，田哥自己汇总一稿 */

  readHand(dir) {
    const file = path.join(this.resolve(dir), HAND_FILE);
    return { text: readText(file), file };
  }

  // base 是编辑器上次读到 / 存下的内容。文件在别处（如 Typora）被改过、又和这次要存的不同，就不覆盖，交给田哥选
  saveHand(dir, text, base) {
    const file = path.join(this.resolve(dir), HAND_FILE);
    const next = String(text == null ? '' : text).replace(/\r\n/g, '\n');
    const disk = readText(file);
    if (base != null && disk !== String(base).replace(/\r\n/g, '\n') && disk !== next) return { conflict: true, text: disk, file };
    if (disk !== next || !fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, next, 'utf8');
      fs.renameSync(tmp, file);
    }
    return { conflict: false, file, savedAt: Date.now() };
  }
}

const HAND_FILE = '手写稿.md';

module.exports = { PieceStore, titleOf, stamp, HAND_FILE };
