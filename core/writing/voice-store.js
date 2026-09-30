'use strict';
// core/writing/voice-store.js
//
// 文风 skill 的读写。skill 文件是唯一事实来源（Claude 与 Codex 写作时都读它）：
//
//   SKILL.md                 一句话画像 + 「## 十条写法」（写作群规则里注入的就是这一份）
//   exemplars.md             范文；出处里的文件名用来给作品库打星标
//   learned-from-edits.md    从写作过程中学到的规则
//   CHANGELOG.md             每次改动一行：田哥手动修改、AI 自动优化都记在这里
//   voice-review.json        Hub 维护的状态：改动比例记录、田哥手动改过的写法条目
//   backups/                 每次写回前的原文件副本，供「回退上一步」
//
// 备份文件名：<YYYYMMDD-HHmmss>-<毫秒三位>-<批次>__<文件名>。一次 AI 优化可能同时写两份文件，
// 它们共用一个批次，回退时一起恢复，不会只退一半。

const fs = require('fs');
const path = require('path');

const RULE_LINE = /^(\d+)\. \*\*(.+?)\*\*/gm;
const NEW_BACKUP = /^(\d{8}-\d{6})-(\d{3})-([a-z0-9]+)__(.+\.md)$/;
const OLD_BACKUP = /^(\d{8}-\d{6})-(\d+)-(.+\.md)$/; // 2026-09-30 之前的格式，毫秒没补零、没有批次

function nowIso() { return new Date().toISOString(); }
function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-'); }
function newBatch() { return `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`; }

// 只数「## 十条写法」这一节里的编号条目：「写技术段落」等别的小节也有加粗编号步骤，不算写法
function rulesOf(skill) {
  const text = String(skill || '');
  const start = text.indexOf('## 十条写法');
  if (start < 0) return [];
  const next = text.slice(start + 1).search(/\n## /);
  const section = next < 0 ? text.slice(start) : text.slice(start, start + 1 + next);
  const out = [];
  let m;
  RULE_LINE.lastIndex = 0;
  while ((m = RULE_LINE.exec(section))) {
    const end = section.indexOf('\n', m.index);
    out.push({ n: Number(m[1]), title: m[2], line: section.slice(m.index, end < 0 ? undefined : end) });
  }
  return out;
}

function parseBackup(f) {
  let m = f.match(NEW_BACKUP);
  if (m) return { file: f, key: `${m[1]}-${m[2]}`, batch: m[3], name: m[4] };
  m = f.match(OLD_BACKUP);
  if (m) return { file: f, key: `${m[1]}-${m[2].padStart(3, '0')}`, batch: f, name: m[3] };
  return null;
}

class VoiceStore {
  constructor(paths) {
    this.dir = paths.voiceDir;
  }

  file(name) { return path.join(this.dir, name); }
  read(name) { try { return fs.readFileSync(this.file(name), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

  readState() {
    try { return { editRatios: [], ...JSON.parse(this.read('voice-review.json') || '{}') }; } catch { return { editRatios: [] }; }
  }

  writeState(state) {
    fs.writeFileSync(this.file('voice-review.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  newBatch() { return newBatch(); }

  // 写回任何 skill 文件前先备份；回退时取最近一批。
  writeWithBackup(name, text, reason, batch = newBatch()) {
    const backupDir = this.file('backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const d = new Date();
    fs.writeFileSync(path.join(backupDir, `${stamp(d)}-${String(d.getMilliseconds()).padStart(3, '0')}-${batch}__${name}`), this.read(name), 'utf8');
    fs.writeFileSync(this.file(name), text, 'utf8');
    this.log(reason);
  }

  log(reason) {
    const line = `- ${nowIso().slice(0, 10)} ${reason}\n`;
    const cur = this.read('CHANGELOG.md');
    fs.writeFileSync(this.file('CHANGELOG.md'), (cur.endsWith('\n') || !cur ? cur : cur + '\n') + line, 'utf8');
  }

  undo() {
    const backupDir = this.file('backups');
    let items = [];
    try { items = fs.readdirSync(backupDir).map(parseBackup).filter(Boolean); } catch { /* 没有备份 */ }
    if (!items.length) return { ok: false, message: '没有可回退的改动' };
    items.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    const last = items[items.length - 1];
    // 同一批次里同一文件只取最早那份（批次开始前的原文）
    const batch = items.filter((it) => it.batch === last.batch);
    const restored = [];
    for (const it of batch) {
      if (!restored.includes(it.name)) {
        fs.writeFileSync(this.file(it.name), fs.readFileSync(path.join(backupDir, it.file), 'utf8'), 'utf8');
        restored.push(it.name);
      }
      fs.unlinkSync(path.join(backupDir, it.file));
    }
    this.log(`回退 ${restored.join('、')} 到上一次改动之前`);
    return { ok: true, file: restored.join('、') };
  }

  // 文风页直接展示与编辑源文件；只放行这几个文件
  readSource(name) {
    if (!['SKILL.md', 'exemplars.md', 'learned-from-edits.md', 'CHANGELOG.md'].includes(name)) throw new Error('不允许读取这个文件');
    return this.read(name);
  }

  // base：编辑器打开时读到的原文。期间文件被 AI 自动优化改过，就不覆盖，免得两边互相吃掉改动。
  saveSource(name, text, reason, base) {
    if (!['SKILL.md', 'exemplars.md', 'learned-from-edits.md'].includes(name)) throw new Error('只能修改 SKILL.md、exemplars.md、learned-from-edits.md');
    const next = String(text || '').replace(/\r\n/g, '\n');
    if (!next.trim()) throw new Error('内容为空，没有保存');
    const cur = this.read(name);
    if (base != null && String(base).replace(/\r\n/g, '\n') !== cur) {
      throw new Error(`${name} 在你编辑期间被 AI 自动优化改过，没有保存。先复制你的改动，点「取消」看最新内容后再改`);
    }
    if (next === cur) return { ok: true, unchanged: true };
    this.writeWithBackup(name, next, reason || `手动修改 ${name}`);
    if (name === 'SKILL.md') this.recordManualRules(cur, next);
    return { ok: true };
  }

  // 田哥手动新增或改写的写法条目记下来，AI 自动优化不得删改；他没碰过的条目 AI 照常可以调整
  recordManualRules(before, after) {
    const old = new Set(rulesOf(before).map((r) => r.line));
    const now = rulesOf(after).map((r) => r.line);
    const state = this.readState();
    const kept = (state.protectedRules || []).filter((l) => now.includes(l));
    const touched = now.filter((l) => !old.has(l) && !kept.includes(l));
    state.protectedRules = [...kept, ...touched];
    this.writeState(state);
  }

  protectedRules() { return this.readState().protectedRules || []; }

  // 变更日志：新的在前
  changelog(limit = 40) {
    return this.read('CHANGELOG.md').split('\n').filter((l) => l.startsWith('- ')).map((l) => l.slice(2)).reverse().slice(0, limit);
  }

  // 范文出处形如「公众号 20230412-通信之道」，取文件名部分给作品库打星标
  exemplarStems() {
    const stems = new Set();
    for (const m of this.read('exemplars.md').matchAll(/^（\S+\s+(.+)）$/gm)) stems.add(m[1].trim());
    return stems;
  }

  addEditRatio(entry) {
    const state = this.readState();
    state.editRatios = (state.editRatios || []).filter((e) => e.piece !== entry.piece);
    state.editRatios.push({ ...entry, at: nowIso() });
    this.writeState(state);
  }
}

module.exports = { VoiceStore, rulesOf };
