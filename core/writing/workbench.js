'use strict';
// core/writing/workbench.js
//
// 写作 Tab 的「文章工作台」读取器（2026-10-01 田哥要求：写作在 Tab 里完成，群聊退到后台）。
//
// 写作群里每位 AI 的回答就是一份 Markdown 回答文件（core/group-answer-files.js），群聊记录里的
// assistant 消息正文即文件内容。写作群规则要求回答末尾附一张卡片：
//
//   ```hub-writing
//   {"type":"draft","title":"…","note":"…"}        交稿：回答正文就是这份稿
//   {"type":"final","title":"…","note":"…"}        定稿：回答正文就是定稿
//   {"type":"questions","items":[{"q":"…","recommend":"…"}]}   想先问田哥的问题
//   ```
//
// 本模块把群聊记录、成员会话状态、文章目录合成一份「这篇文章现在什么样」交给渲染层，
// 并把交稿 / 定稿落成文章目录里的文件（drafts/<成员>-v<n>.md、final.md），作品库与文风优化照旧读文件。
//
// 不按格式来的回答不丢：没有卡片的回答整条显示成「AI 的回复」；文章目录里 Hub 没写过的稿件文件
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
    if (m.speaker && (!mem.name || mem.name === mem.kind)) mem.name = m.speaker;
  }

  const questions = [];
  let finalItem = null;
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !m.sid || m.supplementReply) continue;
    const content = String(m.content || '');
    if (!content.trim()) continue;
    const mem = bySid.get(m.sid);
    const { cards, body, errors } = parseCards(content);
    const turn = Number(m.turnNum) || 0;
    const base = { sid: m.sid, turn, at: Number(m.updatedAt || m.createdAt) || 0, messageId: m.id || '' };
    const draftCard = cards.find((c) => c.type === 'draft');
    const finalCard = cards.find((c) => c.type === 'final');
    for (const c of cards.filter((x) => x.type === 'questions')) {
      c.items.forEach((it, i) => questions.push({ ...it, from: mem.name, sid: m.sid, turn, key: `${m.id || turn}:${i}` }));
    }
    if (finalCard) {
      const item = { ...base, kind: 'final', title: finalCard.title || titleOf(body), note: finalCard.note, text: body, chars: cjk(body) };
      mem.items.push(item);
      if (!finalItem || item.turn >= finalItem.turn) finalItem = { ...item, from: mem.name };
    } else if (draftCard) {
      mem.items.push({ ...base, kind: 'draft', title: draftCard.title || titleOf(body), note: draftCard.note, text: body, chars: cjk(body) });
    } else if (!cards.length || cjk(body) >= 200) {
      // 没按格式交稿：整条回答原样给田哥看，不丢
      mem.items.push({ ...base, kind: 'reply', title: titleOf(body), note: errors.length ? `卡片没读懂：${errors[0]}` : '', text: body || content.trim(), chars: cjk(body || content) });
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
  const firstDraftAt = drafts.length ? Math.min(...drafts.map((it) => it.turn || 0)) : Infinity;
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
    idea: userMsgs.length ? String(userMsgs[0].content).trim() : '',
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
 * 把交稿 / 定稿落成文章目录里的文件。只写内容有变化的；返回 Hub 写过的稿件文件名清单（存进 piece.json，
 * 下次列「其他稿件文件」时排除）。定稿文件已存在且内容不同（AI 或田哥直接改过）时以卡片为准覆盖——
 * 定稿卡总是群里最新的定稿。
 */
function materialize(dir, view, written = []) {
  const draftsDir = path.join(dir, 'drafts');
  const names = new Set(written);
  for (const col of view.columns) {
    if (!col.sid) continue;
    for (const it of col.items) {
      if (it.kind !== 'draft' && it.kind !== 'final') continue;
      const name = `${slugOf(col.name)}-v${it.version}.md`;
      const file = path.join(draftsDir, name);
      const text = `${it.text.trim()}\n`;
      if (readText(file) !== text) { fs.mkdirSync(draftsDir, { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
      names.add(name);
      it.file = name;
    }
  }
  if (view.final && view.final.from) {
    const file = path.join(dir, 'final.md');
    const text = `${view.final.text.trim()}\n`;
    if (readText(file) !== text) fs.writeFileSync(file, text, 'utf8');
  }
  return [...names].sort();
}

module.exports = { parseCards, buildView, materialize, slugOf, titleOf, statusOf };
