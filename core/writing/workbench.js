'use strict';
// core/writing/workbench.js
//
// 写作 Tab 的「文章工作台」读取器（2026-10-01 田哥要求：写作在 Tab 里完成，群聊退到后台）。
//
// 写作群里每位 AI 的回答就是一份 Markdown 回答文件（core/group-answer-files.js），群聊记录里的
// assistant 消息正文即文件内容。写作群规则（core/writing/scene-prompt.js）要求回答分成两部分：
//
//   <!-- 文章开始 -->            定稿时是 <!-- 定稿开始 --> / <!-- 定稿结束 -->
//   # 标题 + 正文
//   <!-- 文章结束 -->
//   ## 给田哥                    一两句：切入、取舍、拿不准的事实
//   ## 想问田哥                  1. 问题 / 推荐：推荐答案
//
// 2026-10-01 版的 hub-writing JSON 卡片照样认（旧群聊记录里有）：
//   ```hub-writing
//   {"type":"draft"|"final","title":"…","note":"…"}  /  {"type":"questions","items":[{"q":"…","recommend":"…"}]}
//   ```
//
// 本模块把群聊记录、成员会话状态、文章目录合成一份「这篇文章现在什么样」交给渲染层，
// 并把交稿 / 定稿落成文章目录里的文件（drafts/<成员>-v<n>.md、final.md），作品库与文风优化照旧读文件。
//
// 不按格式来的回答不丢：没加标记但像一篇稿（有「# 标题」、有篇幅）的照样按稿收下，标题前的寒暄、
// 末尾的写作说明挪到「给田哥」；真不像稿的整条显示成「AI 的回复」。文章目录里 Hub 没写过的稿件文件
// （旧文章、AI 自己存的）照样列出来。

const fs = require('fs');
const path = require('path');

const CARD = /^```hub-writing[ \t]*\r?\n([\s\S]*?)^```[ \t]*$/gm;
const TYPES = new Set(['draft', 'final', 'questions']);
const MAX_QUESTIONS = 8;

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }
function cjk(text) { return (String(text || '').match(/[一-鿿]/g) || []).length; }
function clip(s, n) { const t = String(s == null ? '' : s).trim(); return t.length > n ? t.slice(0, n) : t; }
function norm(text) { return String(text || '').replace(/\s+/g, ''); }
function slugOf(name) { return String(name || 'AI').replace(/[\\/:*?"<>|\s]+/g, '-'); }
function titleOf(markdown) {
  const m = String(markdown || '').match(/^#\s+(.+)$/m);
  return m ? m[1].trim().replace(/^《|》$/g, '') : '';
}

// 卡片内容是 JSON；一个代码块里放多行 JSON（每行一张）也认。坏卡片记进 errors，不影响正文。
function parseCards(text) {
  const src = String(text || '').replace(/\r\n/g, '\n');
  const cards = [];
  const errors = [];
  CARD.lastIndex = 0;
  const body = src.replace(CARD, (_all, inner) => {
    const raw = inner.trim();
    const chunks = (() => { try { JSON.parse(raw); return [raw]; } catch { return raw.split('\n').map((l) => l.trim()).filter(Boolean); } })();
    for (const chunk of chunks) {
      let card = null;
      try { card = JSON.parse(chunk); } catch { errors.push('卡片不是合法 JSON'); continue; }
      if (!card || !TYPES.has(card.type)) { errors.push(`不认识的卡片类型：${card && card.type}`); continue; }
      if (card.type === 'questions') {
        const items = (Array.isArray(card.items) ? card.items : []).slice(0, MAX_QUESTIONS)
          .map((it) => ({ q: clip(it && it.q, 300), recommend: clip(it && it.recommend, 300) }))
          .filter((it) => it.q);
        if (items.length) cards.push({ type: 'questions', items });
      } else {
        cards.push({ type: card.type, title: clip(card.title, 120), note: clip(card.note, 400) });
      }
    }
    return '';
  }).trim();
  return { cards, body, errors };
}

const MARK = /<!--\s*(文章|定稿|article|final)\s*(开始|结束|start|end)\s*-->/gi;
const SECTION = /^#{2,3}\s*(给田哥|想问田哥)\s*[:：]?\s*$/;
// 稿件开头 / 末尾常见的「写给田哥的话」：挪出正文，放进「给田哥」
const META_PARA = /^[*_]{0,2}(本稿|这份稿|这一稿|此稿|这版|这一版|以上|待田哥|待确认|田哥[，,：:]|说明[:：]|写作说明|注[:：])/;

// 两行标记切出文章。只有开始标记时，文章到「## 给田哥 / ## 想问田哥」或全文结束
function splitMarked(text) {
  const marks = [];
  MARK.lastIndex = 0;
  let m;
  while ((m = MARK.exec(text))) {
    marks.push({ at: m.index, end: m.index + m[0].length, final: /定稿|final/i.test(m[1]), open: /开始|start/i.test(m[2]) });
  }
  const start = marks.find((x) => x.open);
  if (!start) return null;
  const close = marks.find((x) => !x.open && x.at > start.at);
  let stop = close ? close.at : text.length;
  if (!close) {
    let off = start.end;
    for (const line of text.slice(start.end).split('\n')) {
      if (SECTION.test(line.trim())) { stop = off; break; }
      off += line.length + 1;
    }
  }
  const article = text.slice(start.end, stop).trim();
  const rest = `${text.slice(0, start.at)}\n${text.slice(close ? close.end : stop)}`.replace(MARK, '').trim();
  return { article, kind: start.final ? 'final' : 'draft', rest };
}

// 「## 给田哥」「## 想问田哥」两节拿出来，其余原样返回。一节到下一个一、二级标题为止
function takeSections(text) {
  const keep = [];
  const buf = { 给田哥: [], 想问田哥: [] };
  let cur = null;
  for (const line of String(text || '').split('\n')) {
    const hit = line.trim().match(SECTION);
    if (hit) { cur = hit[1]; continue; }
    if (cur && /^#{1,2}\s/.test(line)) cur = null;
    (cur ? buf[cur] : keep).push(line);
  }
  return { note: buf.给田哥.join('\n').trim(), questions: parseQuestionList(buf.想问田哥.join('\n')), rest: keep.join('\n').trim() };
}

// 「1. 问题 / 推荐：答案」；也认「- 问题」和同一行末尾的「（推荐：…）」
function parseQuestionList(text) {
  const items = [];
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const rec = line.match(/^(?:[-*]\s*)?(?:\*\*)?(?:推荐答案|推荐|建议)(?:\*\*)?\s*[:：]\s*(.+)$/);
    if (rec && items.length) { items[items.length - 1].recommend = clip(rec[1], 300); continue; }
    const item = line.match(/^(?:\d+[.、)）]|[-*])\s*(.+)$/);
    if (item) {
      const inline = item[1].match(/^(.*?)[（(]\s*(?:推荐|建议)\s*[:：]\s*(.+?)[)）]\s*$/);
      items.push(inline ? { q: clip(inline[1], 300), recommend: clip(inline[2], 300) } : { q: clip(item[1], 300), recommend: '' });
    } else if (items.length && !items[items.length - 1].recommend) {
      items[items.length - 1].q = clip(`${items[items.length - 1].q} ${line}`, 300);
    }
  }
  // 问题里常带 Markdown 加粗，问题卡是纯文字，去掉星号
  const plain = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/^\*+|\*+$/g, '').trim();
  return items.map((it) => ({ q: plain(it.q), recommend: plain(it.recommend) })).filter((it) => it.q).slice(0, MAX_QUESTIONS);
}

// 没加标记：从「# 标题」起算文章，标题前的寒暄、末尾的写作说明挪到「给田哥」。
// 标题后第一段就在跟田哥说话（「田哥，我建议……」）的，是在商量，不是稿。
function guessArticle(text) {
  const src = String(text || '').trim();
  const h1 = src.match(/^#\s+\S.*$/m);
  if (!h1) return null;
  const pre = src.slice(0, h1.index).trim();
  if (cjk(pre) > 200) return null;
  const paras = src.slice(h1.index).split(/\n{2,}/);
  const firstBody = paras.slice(1).find((p) => p.trim());
  if (firstBody && /^田哥[，,]/.test(firstBody.trim())) return null;
  const tail = [];
  while (paras.length > 1) {
    const last = paras[paras.length - 1].trim();
    if (!last || /^(-{3,}|\*{3,}|_{3,})$/.test(last)) { paras.pop(); continue; }
    if (META_PARA.test(last)) { tail.unshift(paras.pop().trim()); continue; }
    break;
  }
  const article = paras.join('\n\n').trim();
  if (cjk(article) < 150) return null;
  return { article, meta: [pre, ...tail].filter(Boolean).join('\n\n') };
}

/**
 * 一条回答 → 文章 + 写给田哥的话 + 问题。
 *   article  文章 Markdown（没有就是空串）；kind 'draft' | 'final'
 *   note     AI 写给田哥的话；hint 是 Hub 自己的说明（如「没加文章标记，按稿收下」）
 *   rest     不是稿时剩下的话（整条显示它）；hadCard 有交稿卡 / 文章标记
 */
function extractAnswer(content) {
  const { cards, body, errors } = parseCards(content);
  const card = cards.find((c) => c.type === 'final') || cards.find((c) => c.type === 'draft') || null;
  const questions = cards.filter((c) => c.type === 'questions').flatMap((c) => c.items);
  const marked = splitMarked(body);
  const sec = takeSections(marked ? marked.rest : body);
  questions.push(...sec.questions.filter((q) => !questions.some((x) => x.q === q.q)));
  const notes = [card && card.note, sec.note];
  let article = '';
  let kind = '';
  let hint = '';
  let rest = '';
  if (marked) {
    article = marked.article;
    kind = card && card.type === 'final' ? 'final' : marked.kind;
    if (!article) { hint = '这条回答有文章标记，但标记之间是空的'; rest = sec.rest; } else notes.unshift(sec.rest);
  } else if (card) {
    article = sec.rest;
    kind = card.type;
    if (!article) hint = '这条回答只附了卡片，没有正文';
  } else {
    const g = guessArticle(sec.rest);
    if (g) {
      article = g.article;
      kind = 'draft';
      notes.push(g.meta);
      hint = errors.length ? `卡片没读懂（${errors[0]}），按稿件收下` : '没加文章标记，Hub 按稿件收下';
    } else {
      rest = sec.rest;
      if (errors.length) hint = `卡片没读懂：${errors[0]}`;
    }
  }
  return {
    article, kind, hint, rest, questions,
    title: (card && card.title) || titleOf(article),
    note: clip(notes.filter(Boolean).join('\n\n'), 1200),
    hadCard: !!(marked || card),
  };
}

// 群聊里一位成员这一轮的状态：以派发记录（attempt）为准
function statusOf(attempt) {
  const s = attempt && attempt.status;
  if (!s) return 'idle';
  if (s === 'completed') return 'done';
  if (['errored', 'failed', 'error', 'absent', 'submission_unknown'].includes(s)) return 'error';
  if (['interrupted', 'superseded'].includes(s)) return 'stopped';
  return 'working';
}

function failureText(attempt, message) {
  const f = (attempt && attempt.failure) || (message && message.failure) || null;
  return clip((f && (f.detail || f.summary)) || (attempt && attempt.reason) || '', 300);
}

/**
 * 纯函数：群聊状态 + 成员 + 文章目录里的稿件文件 → 工作台视图（不写盘）。
 *   state    群聊记录（arena-prompts/<id>-groupchat.json）
 *   members  [{ sid, memberId, name, kind, dormant }]，按群成员顺序
 *   files    [{ name, text, mtime }]：drafts/ 下 Hub 没写过的 .md
 *   final    final.md 正文（可空）
 */
function buildView({ state, members = [], files = [], final = '' }) {
  const messages = Array.isArray(state && state.messages) ? state.messages : [];
  const attempts = Object.values((state && state.attempts) || {});
  // 只算田哥真说的话：排除 Hub 派工卡片与系统提示（与群聊上下文同一个判定）
  const { isUserSpeech } = require('../group-chat-transcript.js');
  const userMsgs = messages.filter((m) => isUserSpeech(m) && String(m.content || '').trim());
  const latestTurn = Math.max(0, Number(state && state.currentTurn) || 0, ...messages.map((m) => Number(m && m.turnNum) || 0));

  // 成员：群成员顺序优先；群聊记录里出现、但成员表里没有的（换过人）补在后面
  const bySid = new Map();
  members.forEach((m, i) => bySid.set(m.sid, { ...m, order: i, items: [] }));
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !m.sid) continue;
    if (!bySid.has(m.sid)) bySid.set(m.sid, { sid: m.sid, memberId: m.memberId || '', name: m.speaker || 'AI', kind: '', order: 1000 + bySid.size, items: [] });
    const mem = bySid.get(m.sid);
    if (m.speaker && (!mem.name || mem.name === mem.kind || mem.named === false)) mem.name = m.speaker;
  }

  // 田哥在 Tab 里点名「请 X 汇总定稿」的那一轮：X 这一轮交的稿就是定稿，忘了附定稿卡也认
  const finalizeBy = new Map();
  for (const m of userMsgs) {
    const hit = String(m.content).match(/^请 (.+?) 汇总定稿/);
    if (hit) finalizeBy.set(Number(m.turnNum) || 0, hit[1]);
  }
  const questions = [];
  let finalItem = null;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !m.sid || m.supplementReply) continue;
    const content = String(m.content || '');
    if (!content.trim()) continue;
    const mem = bySid.get(m.sid);
    const a = extractAnswer(content);
    const turn = Number(m.turnNum) || 0;
    const base = { sid: m.sid, turn, at: Number(m.updatedAt || m.createdAt) || 0, messageId: m.id || '' };
    a.questions.forEach((it, i) => questions.push({ ...it, from: mem.name, sid: m.sid, turn, key: `${m.id || turn}:${i}` }));
    const article = a.article.trim();
    if (article && (a.kind === 'final' || (finalizeBy.get(turn) === mem.name && cjk(article) >= 150))) {
      const item = { ...base, kind: 'final', implicit: a.kind !== 'final', title: a.title, note: a.note,
        hint: a.kind === 'final' ? a.hint : '这一轮点名汇总定稿，没用定稿标记，Hub 按定稿收下', text: article, chars: cjk(article) };
      mem.items.push(item);
      if (!finalItem || item.turn >= finalItem.turn) finalItem = { ...item, from: mem.name };
    } else if (article) {
      mem.items.push({ ...base, kind: 'draft', implicit: !!a.hint, title: a.title, note: a.note, hint: a.hint, text: article, chars: cjk(article) });
    } else if (a.hadCard) {
      // 只有卡片 / 标记、没有正文（AI 把稿存到别处了）：不当稿件，免得落盘成空文件
      mem.items.push({ ...base, kind: 'reply', title: '', note: '', hint: a.hint, text: a.rest || a.note || content.trim(), chars: 0 });
    } else if (a.rest || a.note) {
      // 没按格式交稿：剩下的话原样给田哥看，不丢（只提了问题的，问题卡里已经有了）
      const text = a.rest || a.note;
      mem.items.push({ ...base, kind: 'reply', title: titleOf(text), note: a.rest ? a.note : '', hint: a.hint, text, chars: cjk(text) });
    }
  }

  // drafts/ 里 Hub 没写过的文件：按文件名前缀归到成员；内容与已有一份相同就不重复列
  const shown = new Set();
  for (const mem of bySid.values()) for (const it of mem.items) shown.add(norm(it.text));
  const orphan = [];
  for (const f of files) {
    if (!f.text.trim() || shown.has(norm(f.text))) continue;
    const item = { sid: '', turn: 0, at: f.mtime || 0, kind: 'file', file: f.name, title: titleOf(f.text), note: `文章目录里的文件 drafts/${f.name}`, text: f.text, chars: cjk(f.text) };
    const owner = [...bySid.values()].find((mem) => f.name === `${slugOf(mem.name)}.md` || f.name.startsWith(`${slugOf(mem.name)}-`));
    if (owner) owner.items.push({ ...item, sid: owner.sid }); else orphan.push(item);
  }

  // 每位成员这一轮的状态
  const latestAttempt = new Map();
  for (const a of attempts) {
    if (!a || !a.sid) continue;
    const prev = latestAttempt.get(a.sid);
    if (!prev || (Number(a.turnNum) || 0) > (Number(prev.turnNum) || 0) || ((Number(a.turnNum) || 0) === (Number(prev.turnNum) || 0) && (Number(a.updatedAt || a.createdAt) || 0) >= (Number(prev.updatedAt || prev.createdAt) || 0))) latestAttempt.set(a.sid, a);
  }
  const columns = [...bySid.values()].sort((a, b) => a.order - b.order).map((mem) => {
    const items = mem.items.sort((a, b) => (a.turn - b.turn) || (a.at - b.at));
    let v = 0;
    for (const it of items) if (it.kind === 'draft' || it.kind === 'final') it.version = ++v;
    const attempt = latestAttempt.get(mem.sid);
    const message = messages.filter((m) => m && m.role === 'assistant' && m.sid === mem.sid).pop();
    let status = statusOf(attempt);
    if (mem.dormant && status === 'idle') status = 'dormant';
    return {
      sid: mem.sid, memberId: mem.memberId || (attempt && attempt.memberId) || '', name: mem.name, kind: mem.kind || (attempt && attempt.kind) || '',
      status, turn: Number(attempt && attempt.turnNum) || 0, error: status === 'error' || status === 'stopped' ? failureText(attempt, message) : '',
      items,
    };
  });
  if (orphan.length) columns.push({ sid: '', memberId: '', name: '其他稿件文件', kind: 'file', status: 'idle', turn: 0, error: '', items: orphan });

  const finalText = String(final || '').trim();
  const finalView = finalItem ? { title: finalItem.title, note: finalItem.note, text: finalItem.text, from: finalItem.from, chars: finalItem.chars }
    : finalText ? { title: titleOf(finalText), note: '', text: finalText, from: '', chars: cjk(finalText) } : null;

  const allItems = columns.flatMap((c) => c.items);
  const drafts = allItems.filter((it) => it.kind !== 'reply' || it.chars >= 300);
  // 「你点评」只看群里交的稿之后田哥有没有再说话；文章目录里的散文件（turn 0）不算
  const inGroup = drafts.filter((it) => it.turn > 0);
  const firstDraftAt = inGroup.length ? Math.min(...inGroup.map((it) => it.turn)) : Infinity;
  const steps = {
    idea: userMsgs.length > 0,
    draft: drafts.length > 0,
    review: userMsgs.some((m) => (Number(m.turnNum) || 0) > firstDraftAt),
    revise: columns.some((c) => c.items.filter((it) => it.kind !== 'reply').length >= 2),
    final: !!finalView,
  };

  // 还没过去的问题：最新一轮里提出的（田哥一开口就进入新一轮，问题自然收起）
  const pending = questions.filter((q) => q.turn === latestTurn);
  // 标题：定稿 > 最新交稿 > 最新一份带标题的回复或文件
  const byRecent = (a, b) => (b.turn - a.turn) || (b.at - a.at);
  const latestDraft = allItems.filter((it) => it.kind === 'draft' && it.title).sort(byRecent)[0]
    || allItems.filter((it) => it.title).sort(byRecent)[0];
  return {
    // 写作 Tab 发中心思想时附的格式提醒不算田哥的想法
    idea: userMsgs.length ? String(userMsgs[0].content).replace(/\n*（写作 Tab：[^）]*）\s*$/, '').trim() : '',
    title: (finalView && finalView.title) || (latestDraft && latestDraft.title) || '',
    latestTurn,
    running: columns.some((c) => c.status === 'working'),
    steps,
    questions: pending,
    columns,
    final: finalView,
  };
}

/**
 * 把交稿落成 drafts/<成员>-v<n>.md、定稿落成 final.md。只写内容有变化的。
 *   written    Hub 写过的稿件文件名（存进 piece.json，下次列「其他稿件文件」时排除）
 *   finalHash  上次落盘的定稿卡正文指纹：只有群里出了新的定稿卡才写 final.md。田哥直接改过 final.md，
 *              下一轮轮询不会把它改回去——他改的正是文风优化要学的东西。
 * 定稿不再另存一份到 drafts/：文风优化拿 final.md 和 drafts/ 比改动比例，存了就永远是 0%。
 */
function materialize(dir, view, { written = [], finalHash = '' } = {}) {
  const draftsDir = path.join(dir, 'drafts');
  const names = new Set(written);
  for (const col of view.columns) {
    if (!col.sid) continue;
    for (const it of col.items) {
      if (it.kind !== 'draft' || !it.text.trim()) continue;
      const name = `${slugOf(col.name)}-v${it.version}.md`;
      const file = path.join(draftsDir, name);
      const text = `${it.text.trim()}\n`;
      if (readText(file) !== text) { fs.mkdirSync(draftsDir, { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
      names.add(name);
      it.file = name;
    }
  }
  let hash = finalHash;
  if (view.final && view.final.from && view.final.text.trim()) {
    const text = `${view.final.text.trim()}\n`;
    const next = require('crypto').createHash('sha1').update(text).digest('hex');
    const file = path.join(dir, 'final.md');
    if (next !== finalHash || !readText(file).trim()) { fs.writeFileSync(file, text, 'utf8'); hash = next; }
  }
  return { written: [...names].sort(), finalHash: hash };
}

module.exports = { parseCards, extractAnswer, splitMarked, takeSections, parseQuestionList, guessArticle, buildView, materialize, slugOf, titleOf, statusOf };
