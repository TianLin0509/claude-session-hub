'use strict';
// core/writing/voice-store.js
//
// 文风 skill 的读写。skill 文件是唯一事实来源（Claude 与 Codex 写作时都读它）：
//
//   SKILL.md                 一句话画像 + 「## 十条写法」（写作群规则里注入的就是这一份）
//   exemplars.md             范文；出处里的文件名用来给作品库打星标
//   learned-from-edits.md    从写作过程中学到的规则
//   CHANGELOG.md             每次改动一行：田哥手动修改、AI 自动优化都记在这里
//   voice-review.json        Hub 维护的改动比例记录
//   backups/                 每次写回前的原文件副本，供「回退上一步」

const fs = require('fs');
const path = require('path');

function nowIso() { return new Date().toISOString(); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-'); }

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

  // 写回任何 skill 文件前先备份；回退时取最近一份。
  writeWithBackup(name, text, reason) {
    const backupDir = this.file('backups');
    fs.mkdirSync(backupDir, { recursive: true });
    fs.writeFileSync(path.join(backupDir, `${stamp()}-${Date.now() % 1000}-${name}`), this.read(name), 'utf8');
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
    let files = [];
    try { files = fs.readdirSync(backupDir).filter((f) => f.endsWith('.md')).sort(); } catch { /* 没有备份 */ }
    const last = files[files.length - 1];
    if (!last) return { ok: false, message: '没有可回退的改动' };
    const name = last.replace(/^\d{8}-\d{6}-\d+-/, '');
    fs.writeFileSync(this.file(name), fs.readFileSync(path.join(backupDir, last), 'utf8'), 'utf8');
    fs.unlinkSync(path.join(backupDir, last));
    this.log(`回退 ${name} 到上一次改动之前`);
    return { ok: true, file: name };
  }

  // 文风页直接展示与编辑源文件；只放行这几个文件
  readSource(name) {
    if (!['SKILL.md', 'exemplars.md', 'learned-from-edits.md', 'CHANGELOG.md'].includes(name)) throw new Error('不允许读取这个文件');
    return this.read(name);
  }

  saveSource(name, text, reason) {
    if (!['SKILL.md', 'exemplars.md', 'learned-from-edits.md'].includes(name)) throw new Error('只能修改 SKILL.md、exemplars.md、learned-from-edits.md');
    const next = String(text || '').replace(/\r\n/g, '\n');
    if (!next.trim()) throw new Error('内容为空，没有保存');
    if (next === this.read(name)) return { ok: true, unchanged: true };
    this.writeWithBackup(name, next, reason || `手动修改 ${name}`);
    return { ok: true };
  }

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

module.exports = { VoiceStore };
