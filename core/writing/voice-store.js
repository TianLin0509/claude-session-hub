'use strict';
// core/writing/voice-store.js
//
// 文风页的数据层：读写 tiange-voice skill。skill 文件是唯一事实来源（Claude 与 Codex
// 起草时都读它），界面上的每次确认都直接改这些文件，并追加变更日志。
//
//   SKILL.md                 一句话画像 + 「## 十条写法」编号列表
//   exemplars.md             「## 分组：说明」下的引用块 + （出处）
//   learned-from-edits.md    「## 已确认」「## 观察中」
//   voice-review.json        界面状态：每条写法的确认状态、范文候选、改动比例（Hub 维护）
//   backups/                 每次写回前的原文件副本，供「回退上一步」
//
// 写法条目的确认状态放在 voice-review.json，而不是写进 SKILL.md：状态是给人看的，
// 不该进入起草时的系统提示。

const fs = require('fs');
const path = require('path');

// 与 exemplars.md 的二级标题一致
const GROUPS = ['开场', '推进', '类比', '算账', '把自己放进去', '点破', '收束'];
const RULE_LINE = /^(\d+)\. \*\*(.+?)\*\*\s*(.*)$/;

function nowIso() { return new Date().toISOString(); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-'); }

class VoiceStore {
  constructor(paths) {
    this.dir = paths.voiceDir;
  }

  file(name) { return path.join(this.dir, name); }
  read(name) { try { return fs.readFileSync(this.file(name), 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

  readState() {
    try {
      const s = JSON.parse(this.read('voice-review.json') || '{}');
      return { rules: {}, candidates: [], editRatios: [], ...s };
    } catch { return { rules: {}, candidates: [], editRatios: [] }; }
  }

  writeState(state) {
    fs.writeFileSync(this.file('voice-review.json'), JSON.stringify(state, null, 2), 'utf8');
  }

  // 写回任何 skill 文件前先备份；回退时取最近一份。
  writeWithBackup(name, text, reason) {
    const backupDir = this.file('backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const current = this.read(name);
    fs.writeFileSync(path.join(backupDir, `${stamp()}-${Date.now() % 1000}-${name}`), current, 'utf8');
    fs.writeFileSync(this.file(name), text, 'utf8');
    this.log(reason);
  }

  log(reason) {
    const line = `- ${nowIso().slice(0, 10)} Hub 写作 Tab：${reason}\n`;
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
    this.log(`回退 ${name} 到改动前（${last}）`);
    return { ok: true, file: name };
  }

  parseSkill() {
    const text = this.read('SKILL.md');
    const portrait = (text.match(/\*\*一句话画像\*\*：(.+)/) || [])[1] || '';
    const rules = [];
    let inRules = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^## /.test(line)) inRules = line.startsWith('## 十条写法');
      if (!inRules) continue;
      const m = line.match(RULE_LINE);
      if (m) rules.push({ n: Number(m[1]), title: m[2].replace(/[。.]$/, ''), text: m[3], raw: line });
    }
    return { portrait: portrait.trim(), rules };
  }

  parseExemplars() {
    const text = this.read('exemplars.md');
    const groups = [];
    let cur = null;
    let quote = [];
    const flush = (sourceLine) => {
      if (cur && quote.length) {
        const source = sourceLine.replace(/^（|）$/g, '');
        cur.items.push({ text: quote.join('\n'), source });
      }
      quote = [];
    };
    for (const line of text.split(/\r?\n/)) {
      const h = line.match(/^## (.+)$/);
      if (h) {
        const [key, desc = ''] = h[1].split('：');
        cur = { key: key.trim(), desc: desc.trim(), items: [] };
        groups.push(cur);
        quote = [];
        continue;
      }
      if (line.startsWith('> ')) { quote.push(line.slice(2)); continue; }
      if (/^（.+）$/.test(line.trim()) && quote.length) flush(line.trim());
    }
    return groups;
  }

  // 范文出处形如「公众号 20230412-通信之道」，取文件名部分给作品库打星标
  exemplarStems() {
    const stems = new Set();
    for (const g of this.parseExemplars()) {
      for (const it of g.items) {
        const s = it.source.replace(/^\S+\s+/, '').trim();
        if (s) stems.add(s);
      }
    }
    return stems;
  }

  parseLearned() {
    const text = this.read('learned-from-edits.md');
    const out = { confirmed: [], observing: [] };
    let bucket = null;
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith('## 已确认')) { bucket = 'confirmed'; continue; }
      if (line.startsWith('## 观察中')) { bucket = 'observing'; continue; }
      if (line.startsWith('## ')) { bucket = null; continue; }
      if (bucket && line.startsWith('- ')) out[bucket].push(line.slice(2));
    }
    return out;
  }

  snapshot() {
    const { portrait, rules } = this.parseSkill();
    const state = this.readState();
    return {
      dir: this.dir,
      portrait,
      rules: rules.map((r) => ({ ...r, status: (state.rules[r.n] && state.rules[r.n].status) || 'pending' })),
      groups: this.parseExemplars(),
      candidates: state.candidates,
      learned: this.parseLearned(),
      editRatios: state.editRatios,
      hasBackup: (() => { try { return fs.readdirSync(this.file('backups')).some((f) => f.endsWith('.md')); } catch { return false; } })(),
    };
  }

  setRule(n, action, newText) {
    const { rules } = this.parseSkill();
    const rule = rules.find((r) => r.n === Number(n));
    if (!rule) return { ok: false, message: `找不到第 ${n} 条写法` };
    const state = this.readState();
    if (action === 'confirm') {
      state.rules[n] = { status: 'confirmed', at: nowIso() };
      this.writeState(state);
      this.log(`确认第 ${n} 条写法「${rule.title}」`);
      return { ok: true };
    }
    const skill = this.read('SKILL.md');
    if (action === 'rewrite') {
      const body = String(newText || '').trim();
      if (!body) return { ok: false, message: '改写内容为空' };
      const line = `${n}. ${body.startsWith('**') ? body : `**${rule.title}。** ${body}`}`;
      this.writeWithBackup('SKILL.md', skill.replace(rule.raw, line), `改写第 ${n} 条写法「${rule.title}」`);
      state.rules[n] = { status: 'confirmed', at: nowIso() };
      this.writeState(state);
      return { ok: true };
    }
    if (action === 'strike') {
      // 删掉这一条，后面的顺延编号，状态跟着挪
      let next = skill.replace(rule.raw + '\n', '').replace(rule.raw, '');
      const later = rules.filter((r) => r.n > rule.n);
      for (const r of later) next = next.replace(r.raw, r.raw.replace(/^\d+\./, `${r.n - 1}.`));
      this.writeWithBackup('SKILL.md', next, `划掉第 ${n} 条写法「${rule.title}」`);
      const moved = {};
      for (const [k, v] of Object.entries(state.rules)) {
        const kn = Number(k);
        if (kn < rule.n) moved[kn] = v;
        else if (kn > rule.n) moved[kn - 1] = v;
      }
      state.rules = moved;
      this.writeState(state);
      return { ok: true };
    }
    return { ok: false, message: `未知操作 ${action}` };
  }

  addCandidate({ group, text, source, why }) {
    const body = String(text || '').trim();
    if (!body) return { ok: false, message: '范文内容为空' };
    if (!GROUPS.includes(group)) return { ok: false, message: `分组必须是：${GROUPS.join('、')}` };
    const state = this.readState();
    const cand = { id: `c${Date.now()}`, group, text: body, source: String(source || '').trim(), why: String(why || '').trim(), at: nowIso() };
    state.candidates.push(cand);
    this.writeState(state);
    return { ok: true, candidate: cand };
  }

  resolveCandidate(id, action) {
    const state = this.readState();
    const cand = state.candidates.find((c) => c.id === id);
    if (!cand) return { ok: false, message: '候选不存在' };
    state.candidates = state.candidates.filter((c) => c.id !== id);
    if (action === 'promote') {
      const text = this.read('exemplars.md');
      const block = `${cand.text.split(/\r?\n/).map((l) => `> ${l}`).join('\n')}\n\n（${cand.source}）\n`;
      const heading = new RegExp(`^## ${cand.group}[：:].*$`, 'm');
      const m = text.match(heading);
      let next;
      if (!m) {
        next = `${text.trimEnd()}\n\n## ${cand.group}\n\n${block}`;
      } else {
        const start = m.index + m[0].length;
        const rest = text.slice(start);
        const nextHeading = rest.search(/^## /m);
        const insertAt = nextHeading < 0 ? text.length : start + nextHeading;
        next = `${text.slice(0, insertAt).trimEnd()}\n\n${block}\n${text.slice(insertAt)}`;
      }
      this.writeWithBackup('exemplars.md', next.replace(/\n{3,}/g, '\n\n'), `范文转正：${cand.group} · ${cand.source}${cand.why ? `（${cand.why}）` : ''}`);
    }
    this.writeState(state);
    return { ok: true };
  }

  addEditRatio(entry) {
    const state = this.readState();
    state.editRatios = state.editRatios.filter((e) => e.piece !== entry.piece);
    state.editRatios.push({ ...entry, at: nowIso() });
    this.writeState(state);
  }

  // 起草时拼进系统提示的文风部分：画像、十条写法、若干范文
  draftContext({ groups = ['开场', '推进', '收束'], perGroup = 1 } = {}) {
    const skill = this.read('SKILL.md');
    const m = skill.match(/\*\*一句话画像\*\*[\s\S]*?(?=\n## 写技术段落|\n## 田哥明确确认过的偏好|$)/);
    const core = m ? m[0] : skill;
    const exemplars = this.parseExemplars()
      .filter((g) => groups.includes(g.key))
      .map((g) => `【${g.key}】\n${g.items.slice(0, perGroup).map((it) => it.text).join('\n\n')}`)
      .join('\n\n');
    return { core, exemplars };
  }
}

module.exports = { VoiceStore, GROUPS };
