'use strict';
// core/writing/voice-evolve.js
//
// 写完一篇就自动优化文风 skill（2026-09-30 田哥要求：「每次写作完之后，根据迭代过程把文风的
// Markdown 重新优化」，并且不需要他点确认，但要让他知道改了什么）。
//
// 材料：这篇写作群里田哥的全部点评原话、各位 AI 的稿、汇总定稿、当前 SKILL.md 与改稿规则。
// 做法：交给干净上下文的 Claude，只在有依据时小步修改；结果过几道闸才写回：
//   结构完整（画像 + 十条写法）、写法不超过十条、篇幅不剧烈变化、不带标签腔；
//   田哥手动改过的条目（变更日志里「田哥手动修改」之后）不允许被改掉。
// 写回前备份，改了什么写进 CHANGELOG，文风页直接展示。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runModel } = require('./draft-runner.js');

const RULE_LINE = /^(\d+)\. \*\*(.+?)\*\*/gm;

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }
function clip(s, n) { const t = String(s || ''); return t.length > n ? `${t.slice(0, n)}\n……（后略）` : t; }

// 群聊记录里田哥的发言（用户消息），按时间顺序
function userMessagesOf(hubDataDir, meetingId) {
  if (!meetingId) return [];
  const file = path.join(hubDataDir, 'arena-prompts', `${meetingId}-groupchat.json`);
  let state = null;
  try { state = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const messages = (state && state.messages) || [];
  // 只要田哥真的说的话：排除 Hub 派工卡片与系统提示（与群聊上下文用的是同一个判定）
  const { isUserSpeech } = require('../group-chat-transcript.js');
  return messages
    .filter((m) => isUserSpeech(m) && String(m.content || '').trim())
    .map((m) => String(m.content).trim());
}

function runDiffRatio(script, before, after) {
  return new Promise((resolve) => {
    const out = path.join(path.dirname(after), `.diff-${path.basename(before)}`);
    const child = spawn('python', [script, '--before', before, '--after', after, '--out', out], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    child.on('error', () => resolve(null));
    child.on('close', () => {
      const text = readText(out);
      try { fs.unlinkSync(out); } catch { /* 临时文件 */ }
      const m = text.match(/改动比例[^：]*：(\d+)%/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

// 只数「## 十条写法」这一节里的编号条目：「写技术段落」等别的小节也有加粗编号步骤，不算写法
function rulesOf(skill) {
  const start = skill.indexOf('## 十条写法');
  if (start < 0) return [];
  const rest = skill.slice(start + 1);
  const next = rest.search(/\n## /);
  const section = next < 0 ? skill.slice(start) : skill.slice(start, start + 1 + next);
  const out = [];
  let m;
  RULE_LINE.lastIndex = 0;
  while ((m = RULE_LINE.exec(section))) {
    const end = section.indexOf('\n', m.index);
    out.push({ n: Number(m[1]), title: m[2], line: section.slice(m.index, end < 0 ? undefined : end) });
  }
  return out;
}

// 田哥手动改过 SKILL.md 之后，那一刻的写法条目视为田哥认可的版本，AI 不得删改
function protectedRuleLines(voice) {
  const log = voice.read('CHANGELOG.md');
  if (!/田哥手动修改 SKILL\.md/.test(log)) return [];
  return rulesOf(voice.read('SKILL.md')).map((r) => r.line);
}

function validate(oldSkill, next, protectedLines) {
  if (!next.includes('**一句话画像**')) return '缺少一句话画像';
  if (!next.includes('## 十条写法')) return '缺少「十条写法」一节';
  const rules = rulesOf(next);
  if (!rules.length) return '写法条目为空';
  if (rules.length > 10) return `写法超过十条（${rules.length} 条）`;
  const ratio = next.length / Math.max(1, oldSkill.length);
  if (ratio < 0.6 || ratio > 1.6) return `篇幅变化过大（${Math.round(ratio * 100)}%）`;
  if (/【(推断|坐实|事实|工程推断)】/.test(next)) return '出现了标签腔';
  const lost = protectedLines.filter((l) => !next.includes(l));
  if (lost.length) return `改动了田哥手动确认过的 ${lost.length} 条写法`;
  return '';
}

function buildPrompt({ skill, learned, userMessages, drafts, final, title }) {
  const system = [
    '你负责维护田哥的中文文风 skill。田哥刚在写作群里和几位 AI 写完一篇文章。请根据这次写作过程，小步优化文风文件。',
    '',
    '原则：',
    '- 证据主要来自田哥的点评原话：田哥说好的写法要强化，说不好的要避免（写成“应该怎样写”的正面描述）。',
    '- 只在有明确依据时改。没有新依据就不改，返回 changed=false。',
    '- 写法最多十条，每条一行：编号、加粗的写法名、一句说明、田哥原句作证（原句只能来自田哥本人的文字：已有原句或这次点评原话，不能编）。',
    '- 可以改写、合并、替换某一条，也可以把这次的新发现追加到改稿规则的“观察中”；同一类点评在不同文章里出现两三次，才把它升为写法或“已确认”。',
    '- 保持文件其余部分不变，保持原有 Markdown 结构和标题。',
    '- 不写【推断】之类的标签，不写“注意/切记/禁止”式的禁令。',
    '',
    '只输出一个 JSON 对象，不要任何别的文字：',
    '{"changed": true 或 false, "summary": "给田哥看的一两句话：改了什么、依据是田哥哪句话", "skill_md": "完整的新 SKILL.md（changed=false 时给空字符串）", "learned_md": "完整的新 learned-from-edits.md（没有改就给空字符串）"}',
  ].join('\n');
  const user = [
    `# 这篇文章：${title || '（未命名）'}`,
    '',
    '## 田哥在写作群里的全部发言（按时间顺序）',
    userMessages.length ? userMessages.map((m, i) => `${i + 1}. ${clip(m, 1500)}`).join('\n\n') : '（没有读到田哥的发言）',
    '',
    '## 各位 AI 的稿',
    drafts.map((d) => `### ${d.name}\n\n${clip(d.text, 5000)}`).join('\n\n') || '（没有稿）',
    '',
    '## 定稿',
    clip(final, 8000),
    '',
    '## 当前 SKILL.md',
    skill,
    '',
    '## 当前 learned-from-edits.md',
    learned || '（空）',
  ].join('\n');
  return { system, user };
}

function parseResult(text) {
  const s = String(text || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

// 对一篇已定稿的文章做一次文风优化。返回写进 piece.json 的 voice 状态。
async function evolveVoiceFromPiece({ dir, pieces, voice, paths, hubDataDir, model, runner = runModel }) {
  const meta = pieces.readMeta(dir) || {};
  const summaryInfo = pieces.summary(dir);
  const final = pieces.readFinal(dir);
  if (!final.trim()) return { status: 'skipped', reason: '还没有定稿' };
  const drafts = pieces.drafts(dir);
  const userMessages = userMessagesOf(hubDataDir, meta.meetingId);

  // 改动比例：定稿相对最接近的那份稿改了多少
  let ratio = null;
  for (const d of drafts) {
    const r = await runDiffRatio(paths.diffScript, d.file, path.join(dir, 'final.md'));
    if (typeof r === 'number') ratio = ratio == null ? r : Math.min(ratio, r);
  }
  if (ratio != null) voice.addEditRatio({ piece: path.basename(dir), title: summaryInfo.title, ratio });

  const skill = voice.read('SKILL.md');
  const learned = voice.read('learned-from-edits.md');
  const { system, user } = buildPrompt({ skill, learned, userMessages, drafts, final, title: summaryInfo.title });
  const r = await runner('claude', { system, user, model, hubDataDir });
  const out = parseResult(r.text);
  if (!out) return { status: 'failed', ratio, error: '模型输出不是可解析的 JSON' };
  if (!out.changed) {
    voice.log(`AI 读完《${summaryInfo.title || path.basename(dir)}》的写作过程，没有需要改的地方：${String(out.summary || '').slice(0, 200)}`);
    return { status: 'done', changed: false, ratio, summary: out.summary || '没有需要改的地方' };
  }
  const nextSkill = String(out.skill_md || '').trim() ? String(out.skill_md).replace(/\r\n/g, '\n') : skill;
  const problem = validate(skill, nextSkill, protectedRuleLines(voice));
  if (problem) {
    voice.log(`AI 对《${summaryInfo.title || path.basename(dir)}》提出的文风修改没有通过检查，未写回：${problem}`);
    return { status: 'rejected', ratio, error: problem, summary: out.summary || '' };
  }
  const title = summaryInfo.title || path.basename(dir);
  const reason = `AI 根据《${title}》的写作过程优化文风：${String(out.summary || '').slice(0, 300)}`;
  const skillChanged = nextSkill !== skill;
  const nextLearned = String(out.learned_md || '').trim();
  const learnedChanged = !!nextLearned && nextLearned !== learned.trim();
  // 主说明记在先写回的那个文件上；两个都写时第二条只注明文件
  if (skillChanged) voice.writeWithBackup('SKILL.md', nextSkill.endsWith('\n') ? nextSkill : `${nextSkill}\n`, `${reason}（改了 SKILL.md）`);
  if (learnedChanged) voice.writeWithBackup('learned-from-edits.md', `${nextLearned}\n`, skillChanged ? `同一次优化还更新了改稿规则（《${title}》）` : `${reason}（改了改稿规则）`);
  if (!skillChanged && !learnedChanged) voice.log(`${reason}（给出的内容与现有文件一致，未改动）`);
  return { status: 'done', changed: skillChanged || learnedChanged, ratio, summary: out.summary || '' };
}

module.exports = { evolveVoiceFromPiece, validate, rulesOf, userMessagesOf, buildPrompt, parseResult };
