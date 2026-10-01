'use strict';
// core/writing/voice-evolve.js
//
// 写完一篇就自动优化文风 skill（2026-09-30 田哥要求：「每次写作完之后，根据迭代过程把文风的
// Markdown 重新优化」，并且不需要他点确认，但要让他知道改了什么）。
//
// 材料：这篇写作群里田哥的全部点评原话、各位 AI 的稿、汇总定稿、当前 SKILL.md 与改稿规则。
// 做法：交给干净上下文的 Claude，只在有依据时小步修改；结果过几道闸才写回：
//   结构完整（画像 + 十条写法）、写法不超过十条、篇幅不剧烈变化、不带标签腔；
//   田哥手动新增或改写过的条目不允许被改掉；模型运行期间文件被手动改过则不覆盖。
// 写回前备份（两份文件同批，回退一起退），改了什么写进 CHANGELOG，文风页直接展示。
// 同一篇定稿后再改，只有群里有了新点评才再跑，旧点评不重复计数。

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { runModel } = require('./draft-runner.js');
const { rulesOf } = require('./voice-store.js');

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
    .map((m) => String(m.content).replace(/\n*（写作 Tab：[^）]*）\s*$/, '').trim());
}

function runDiffRatio(script, before, after) {
  return new Promise((resolve) => {
    const out = path.join(path.dirname(after), `.diff-${path.basename(before)}`);
    const child = spawn('python', [script, '--before', before, '--after', after, '--out', out], { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } });
    // python 卡住会堵住整条优化队列：一分钟没算完就放弃这份稿的比例
    const timer = setTimeout(() => { try { child.kill(); } catch { /* 已退出 */ } }, 60000);
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.on('close', () => {
      clearTimeout(timer);
      const text = readText(out);
      try { fs.unlinkSync(out); } catch { /* 临时文件 */ }
      const m = text.match(/改动比例[^：]*：(\d+)%/);
      resolve(m ? Number(m[1]) : null);
    });
  });
}

// 田哥手动新增或改写过的写法条目（保存时由 VoiceStore 记下），AI 不得删改
function protectedRuleLines(voice) {
  return voice.protectedRules();
}

// 改稿规则文件的闸：不能被截断成空壳，也不能带标签腔
function validateLearned(oldText, next) {
  if (!next.trim()) return '改稿规则为空';
  if (oldText.trim().length > 200 && next.length < oldText.trim().length * 0.5) return `改稿规则篇幅缩水过多（${Math.round((next.length / oldText.trim().length) * 100)}%）`;
  if (/【(推断|坐实|事实|工程推断)】/.test(next)) return '改稿规则里出现了标签腔';
  return '';
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

function buildPrompt({ skill, learned, userMessages, drafts, final, title, usedCount = 0 }) {
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
    usedCount > 0 ? `（这篇之前优化过一次：前 ${usedCount} 条已经用过，只作上下文；这次的依据只看第 ${usedCount + 1} 条起的新发言，同一句点评不要重复计数。）` : '',
    userMessages.length ? userMessages.map((m, i) => `${i + 1}. ${i < usedCount ? '（已用过）' : ''}${clip(m, 1500)}`).join('\n\n') : '（没有读到田哥的发言）',
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
  const title = summaryInfo.title || path.basename(dir);
  // 同一篇定稿后又改过：只有群里出现了新的点评才值得再优化一次，旧点评不重复计数
  // userCount 只在成功跑完时更新，排队、运行、失败都原样保留（见 writing-handlers 的 pump）
  const usedCount = Number(meta.voice && meta.voice.userCount) || 0;
  if (usedCount > 0 && userMessages.length <= usedCount) {
    return { status: 'done', changed: false, userCount: usedCount, summary: '定稿有更新，但群里没有新的点评，文风不用再改' };
  }

  // 改动比例：定稿相对最接近的那份稿改了多少
  let ratio = null;
  for (const d of drafts) {
    const r = await runDiffRatio(paths.diffScript, d.file, path.join(dir, 'final.md'));
    if (typeof r === 'number') ratio = ratio == null ? r : Math.min(ratio, r);
  }
  if (ratio != null) voice.addEditRatio({ piece: path.basename(dir), title: summaryInfo.title, ratio });

  const skill = voice.read('SKILL.md');
  const learned = voice.read('learned-from-edits.md');
  const { system, user } = buildPrompt({ skill, learned, userMessages, drafts, final, title: summaryInfo.title, usedCount });
  let r = await runner('claude', { system, user, model, hubDataDir });
  let out = parseResult(r.text);
  if (!out) {
    // 整份 SKILL.md 塞进 JSON 字符串，模型偶尔漏转义（2026-10-01 E2E 里 haiku 出过）：提醒一句再试一次
    r = await runner('claude', { system: `${system}\n\n上一次输出不是合法 JSON。这次只输出一个 JSON 对象：字符串里的换行写成 \\n，双引号写成 \\"，不要用代码块包起来。`, user, model, hubDataDir });
    out = parseResult(r.text);
  }
  if (!out) return { status: 'failed', ratio, error: '模型输出不是可解析的 JSON' };
  const userCount = userMessages.length;
  if (!out.changed) {
    voice.log(`AI 读完《${title}》的写作过程，没有需要改的地方：${String(out.summary || '').slice(0, 200)}`);
    return { status: 'done', changed: false, ratio, userCount, summary: out.summary || '没有需要改的地方' };
  }
  const nextSkill = String(out.skill_md || '').trim() ? String(out.skill_md).replace(/\r\n/g, '\n') : skill;
  const nextLearned = String(out.learned_md || '').trim() ? `${String(out.learned_md).replace(/\r\n/g, '\n').trim()}\n` : '';
  const skillChanged = nextSkill !== skill;
  const learnedChanged = !!nextLearned && nextLearned.trim() !== learned.trim();
  const reject = (problem) => {
    voice.log(`AI 对《${title}》提出的文风修改没有通过检查，未写回：${problem}`);
    return { status: 'rejected', ratio, error: problem, summary: out.summary || '' };
  };
  const problem = (skillChanged && validate(skill, nextSkill, protectedRuleLines(voice))) || (learnedChanged && validateLearned(learned, nextLearned)) || '';
  if (problem) return reject(problem);
  // 模型要跑几分钟；这期间田哥手动保存过的话，拿旧快照改出来的全文不能覆盖他的改动
  if ((skillChanged && voice.read('SKILL.md') !== skill) || (learnedChanged && voice.read('learned-from-edits.md') !== learned)) {
    return reject('文风文件在优化期间被手动改过，这次不覆盖；可以点「重新优化文风」再跑一次');
  }
  const reason = `AI 根据《${title}》的写作过程优化文风：${String(out.summary || '').slice(0, 300)}`;
  const batch = voice.newBatch();
  // 主说明记在先写回的那个文件上；两个都写时第二条只注明文件。两份共用一个备份批次，回退一起退
  if (skillChanged) voice.writeWithBackup('SKILL.md', nextSkill.endsWith('\n') ? nextSkill : `${nextSkill}\n`, `${reason}（改了 SKILL.md）`, batch);
  if (learnedChanged) voice.writeWithBackup('learned-from-edits.md', nextLearned, skillChanged ? `同一次优化还更新了改稿规则（《${title}》）` : `${reason}（改了改稿规则）`, batch);
  if (!skillChanged && !learnedChanged) voice.log(`${reason}（给出的内容与现有文件一致，未改动）`);
  return { status: 'done', changed: skillChanged || learnedChanged, ratio, userCount, summary: out.summary || '' };
}

module.exports = { evolveVoiceFromPiece, validate, validateLearned, rulesOf, userMessagesOf, buildPrompt, parseResult };
