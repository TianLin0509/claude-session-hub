'use strict';
// core/study-workflow.js
//
// 学习 Tab 的串行工作流定义（2026-09-01，与用户对齐）。
//
// 这个模块只定义「哪几棒、每棒给谁、发什么 prompt、产出落到哪个文件」，
// 不碰 PTY、不碰定时器、不碰 Session 生命周期——那些在 main/ipc/study-handlers.js。
// 拆开的理由：工作流的形状是会被反复调整的产品决策，PTY 编排是稳定的基础设施，
// 两者放一起会让每次调整都得重读几百行进程管理代码。
//
// ── 一条必须守住的架构边界 ──────────────────────────────────────
// Claude **不去调用** Codex。两者都是 Hub 里真实的实体 Session（有卡片、有 PTY、
// 有历史、可恢复、可休眠），和 Agent 联赛里的参赛 Agent 完全同构。
// 编排器住在 Hub 主进程里，按棒次分别向两个 Session 的 PTY 写 prompt、
// 等各自的 turn-complete，再把上一棒的产出作为下一棒的输入。
//
// 也就是说：这里是「群聊式串行工作流」，不是「Claude 带了个 codex 工具」。
// 前者你随时能打开任一 Session 看它在想什么、插话、纠正；后者你只能看结果。
// ──────────────────────────────────────────────────────────────
//
// 三棒（为什么是三棒而不是两棒：Codex 审出来的问题得有人改，
// 让审阅者自己改会丢掉「审阅」这个角色的独立性，所以最后一棒交回 Claude）：
//
//   T1 draft    · Claude · 检索三源 → 写正文 + 画机制图 SVG → 出 .src.html
//                        同时写一份给 Codex 的画图任务单 figures.json
//   T2 review   · Codex  · 读 .src.html 审阅正文（挑事实错、指出讲不清的地方）
//                        + 按任务单生成类比图 PNG → 出 review.md + assets/*.png
//   T3 finalize · Claude · 吸收审阅意见修订 → build（内联图）→ 七道红线自检 → 定稿
//
// 任一棒失败都不静默跳过：标记该棒 failed，保留 Session 供人工检查，
// 当日卡片顶部写明缺了哪一棒（STANDARD.md 铁律 4「降级必须明说」）。

const path = require('path');

const STAGES = Object.freeze(['draft', 'review', 'finalize']);

const STAGE_META = Object.freeze({
  draft: Object.freeze({
    order: 1,
    actor: 'claude',
    label: '初稿',
    desc: 'Claude 检索三源、撰写正文、绘制机制图',
    // 检索 + 长文写作 + 多张 SVG，是三棒里最重的一棒
    timeoutMs: 45 * 60 * 1000,
  }),
  review: Object.freeze({
    order: 2,
    actor: 'codex',
    label: '审阅与配图',
    desc: 'Codex 审阅正文并生成形象类比图',
    // 单张图约 1-2 分钟，三张图 + 审阅，留足余量
    timeoutMs: 40 * 60 * 1000,
  }),
  finalize: Object.freeze({
    order: 3,
    actor: 'claude',
    label: '修订与定稿',
    desc: 'Claude 吸收审阅意见、构建自包含 HTML、跑七道红线',
    timeoutMs: 30 * 60 * 1000,
  }),
});

function stageAfter(stage) {
  const i = STAGES.indexOf(stage);
  return i >= 0 && i + 1 < STAGES.length ? STAGES[i + 1] : null;
}

function isTerminalStage(stage) {
  return stage === STAGES[STAGES.length - 1];
}

/** 当日各产物的相对路径，供三棒之间交接与 UI 读取。 */
function lessonPaths(studyRoot, date, lessonId) {
  const base = `${date}-${lessonId}`;
  return {
    base,
    srcHtml: path.join(studyRoot, 'days', `${base}.src.html`),
    outHtml: path.join(studyRoot, 'days', `${base}.html`),
    review: path.join(studyRoot, 'days', `${base}-review.md`),
    figures: path.join(studyRoot, 'days', 'assets', base, 'figures.json'),
    assetDir: path.join(studyRoot, 'days', 'assets', base),
    sourceDir: path.join(studyRoot, 'sources', date),
  };
}

/* ───────────────────────── prompt 构建 ─────────────────────────
 * 三棒的 prompt 都刻意做成「自包含指令 + 让它自己去读文件」，
 * 而不是把文件内容塞进 prompt。两个理由：
 *   1) 常驻 Session 会被 compaction，塞进去的内容会被压掉，让它自己读永远是新的；
 *   2) 用户白天会和这两个 Session 聊天，上下文里已经有别的东西，
 *      prompt 越短越不容易把当日任务淹没。
 */

function draftPrompt(ctx) {
  const p = lessonPaths(ctx.studyRoot, ctx.date, ctx.lessonId);
  return [
    `【学习卡生成 · 第 1 棒 / 共 3 棒 · 你是主笔】`,
    ``,
    `今天是 ${ctx.date}，要出的是 ${ctx.lessonId}。`,
    ``,
    `先读这四份（它们会被迭代，每次都要重读，不要凭记忆）：`,
    `  ${path.join(ctx.studyRoot, 'STANDARD.md')}      ← 制作标准，一切以它为准`,
    `  ${path.join(ctx.studyRoot, 'PROMPT_DAILY.md')}  ← 执行流程`,
    `  ${path.join(ctx.studyRoot, 'PLAN.md')}          ← 找到 ${ctx.lessonId} 的主题与候选来源`,
    `  ${path.join(ctx.studyRoot, 'LEARNER.md')}       ← 学习者画像、复习队列、难度档位`,
    `再读 ${path.join(ctx.studyRoot, 'FEEDBACK.jsonl')} 的全部「长期」项和最近 3 条「当日」项。`,
    ``,
    `然后完成第 1 棒：`,
    `  1. 三源检索并落盘到 ${p.sourceDir}（官方文档 / 论文仓库 / 本机 Hub 代码），每条记来源号、URL 或路径、抓取时间、被引用的原句。抓不到就明说，不要用记忆顶上。`,
    `  2. 按 STANDARD 的六段结构写出 ${p.srcHtml}，含你自己画的机制图（内联 SVG），类比图位置留 @@IMG:名字@@ 占位。`,
    `  3. 写画图任务单 ${p.figures}，JSON 数组，每项 { "name": "占位名", "prompt": "画面描述", "why": "这张图要帮读者理解什么" }。`,
    `     画面描述里必须原样带上 STANDARD 第 1 节的风格锁，并强调图中不出现任何文字。`,
    ``,
    `注意：不要自己去生成图片。第 2 棒有一个真实的 Codex Session 负责画，它会读你的任务单。`,
    `完成后回复一行：DRAFT_DONE ${p.base}`,
  ].join('\n');
}

function reviewPrompt(ctx) {
  const p = lessonPaths(ctx.studyRoot, ctx.date, ctx.lessonId);
  return [
    `【学习卡生成 · 第 2 棒 / 共 3 棒 · 你是审稿人兼插画作者】`,
    ``,
    `Claude 已完成 ${ctx.date} ${ctx.lessonId} 的初稿。你有两件事，都要做：`,
    ``,
    `一、审阅正文 ${p.srcHtml}`,
    `   读 ${path.join(ctx.studyRoot, 'STANDARD.md')} 了解标准，然后挑毛病。重点看四类问题：`,
    `     · 事实错误或引用与原文对不上（可以去核对 ${p.sourceDir} 里的来源）`,
    `     · 「白话」段偷偷用术语解释术语，或没回答「不这么做会怎样」`,
    `     · 「形象例子」只是修辞，追问一层就对应不上机制`,
    `     · 选择题的干扰项太送分（明显荒谬 = 浪费一题）`,
    `   把意见写进 ${p.review}，每条给出：位置、问题、建议怎么改。`,
    `   **有意见就直说，不要客气。** 没有问题的段落不用夸，跳过即可。`,
    `   如果你认为某个知识点讲得不对，明确写「建议重写」。`,
    ``,
    `二、按任务单画图 ${p.figures}`,
    `   用你的图像生成能力，为任务单里每一项生成 PNG，保存到 ${p.assetDir}，文件名就是 name 字段加 .png。`,
    `   严格按任务单里的风格锁执行，三张风格必须一致，图中不要出现任何文字。`,
    ``,
    `完成后回复一行：REVIEW_DONE <审阅意见条数> <生成图片张数>`,
  ].join('\n');
}

function finalizePrompt(ctx) {
  const p = lessonPaths(ctx.studyRoot, ctx.date, ctx.lessonId);
  return [
    `【学习卡生成 · 第 3 棒 / 共 3 棒 · 你来定稿】`,
    ``,
    `Codex 已经审阅完并画好了图。完成最后一棒：`,
    ``,
    `  1. 读它的审阅意见 ${p.review}。`,
    `     **逐条处理，不要照单全收也不要一概不理**——同意就改，不同意就在定稿末尾的「审阅回应」里写明为什么不改。`,
    `     用户会看到这段回应，它本身就是有价值的技术讨论。`,
    `  2. 修订 ${p.srcHtml}。`,
    `  3. 构建：node scripts/build-lesson.js days/${p.base}.src.html`,
    `  4. 自检：node scripts/check-lesson.js days/${p.base}.html`,
    `     不过就按提示修后重跑，最多 2 次。两次仍不过，在卡片顶部写明未通过项再落盘——不许静默输出。`,
    `  5. 更新 ${path.join(ctx.studyRoot, 'LEARNER.md')} 的术语状态与复习队列。`,
    ``,
    `完成后回复一行：LESSON_DONE ${p.base} <红线通过情况>`,
  ].join('\n');
}

const PROMPT_BUILDERS = Object.freeze({
  draft: draftPrompt,
  review: reviewPrompt,
  finalize: finalizePrompt,
});

/**
 * @param {'draft'|'review'|'finalize'} stage
 * @param {{studyRoot:string, date:string, lessonId:string}} ctx
 */
function buildStagePrompt(stage, ctx) {
  const build = PROMPT_BUILDERS[stage];
  if (!build) throw new Error(`未知阶段：${stage}`);
  if (!ctx || !ctx.studyRoot || !ctx.date || !ctx.lessonId) {
    throw new Error('buildStagePrompt 需要 studyRoot / date / lessonId');
  }
  return build(ctx);
}

/**
 * 从这一棒的最后一段回复里判断它是不是真做完了。
 *
 * 为什么要这一层：turn-complete 只说明「这一轮说完了」，不说明「活干完了」。
 * 模型可能中途说「我先看看文件」然后停下。约定一个完成口令，配合产物文件是否存在
 * 双重判定，比只信 turn-complete 稳。
 */
function stageDoneSignal(stage) {
  return { draft: 'DRAFT_DONE', review: 'REVIEW_DONE', finalize: 'LESSON_DONE' }[stage] || null;
}

function detectStageDone(stage, replyText) {
  const token = stageDoneSignal(stage);
  if (!token) return false;
  return new RegExp(`\\b${token}\\b`).test(String(replyText || ''));
}

/** 这一棒该产出哪些文件——存在性由编排器校验，缺了就算这棒没干完。 */
function stageArtifacts(stage, studyRoot, date, lessonId) {
  const p = lessonPaths(studyRoot, date, lessonId);
  if (stage === 'draft') return [p.srcHtml, p.figures];
  if (stage === 'review') return [p.review];   // 图片张数由任务单动态决定，另行校验
  if (stage === 'finalize') return [p.outHtml];
  return [];
}

module.exports = {
  STAGES,
  STAGE_META,
  stageAfter,
  isTerminalStage,
  lessonPaths,
  buildStagePrompt,
  stageDoneSignal,
  detectStageDone,
  stageArtifacts,
};
