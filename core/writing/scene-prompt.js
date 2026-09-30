'use strict';
// core/writing/scene-prompt.js
//
// 写作场景群聊的群规则（替换通用群规则，只在首轮与上下文压缩后注入一次）。
//
// 2026-09-30 田哥体验后定下的形态：写作台就是「群聊 + 写作场景」。田哥在输入框里说中心思想，
// 各位 AI 自己判断：信息不够就先问几个关键问题，够了就直接写；每人出一份完整稿，
// 田哥用大白话点评，最后点名一位汇总改定。流程由 AI 自己推进，田哥只说话、不点按钮。
//
// 通用群规则里「> 300 字写成 HTML 放 artifacts」这一条在这里必须换掉：
// 稿件要直接出现在群聊消息里，同时落盘成 Markdown，事后文风自动优化才读得到。

const fs = require('fs');
const path = require('path');
const { writingPaths } = require('./config.js');

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

// SKILL.md 里起草真正用得上的部分：画像、十条写法、技术段落写法；其余（文件索引、不照搬清单）省掉
function voiceCore(skill) {
  const m = skill.match(/\*\*一句话画像\*\*[\s\S]*?(?=\n## 田哥明确确认过的偏好|\n## 其他文件|$)/);
  return (m ? m[0] : skill).trim();
}

function buildWritingScenePrompt(displayName, opts = {}, env = process.env) {
  const paths = writingPaths(env);
  const skill = readText(path.join(paths.voiceDir, 'SKILL.md'));
  const exemplarsFile = path.join(paths.voiceDir, 'exemplars.md');
  const workspace = opts.workspace ? String(opts.workspace).replace(/[\\/]+$/, '') : '当前工作目录';
  const name = displayName || 'AI';
  const slug = String(name).replace(/[\\/:*?"<>|\s]+/g, '-');
  return [
    '## 这是写作群聊',
    `你是${name}。这里是田哥的写作群：田哥是作者，你和群里其他 AI 帮田哥把一篇中文技术文章写出来。田哥时间很少，流程由你们自己推进，田哥只负责说想法、点评和拍板。`,
    '',
    '## 怎么推进',
    '- 田哥的第一条消息通常是这篇文章的中心思想。你自己判断：',
    '  - 信息不够（不清楚写给谁、要回答什么问题、缺只有田哥才有的经历或判断）→ 先问 2 到 4 个关键问题，每个问题附上你的推荐答案，方便田哥直接说“按你的来”。这一轮不写稿。',
    '  - 信息够了 → 直接写。不必等其他 AI。',
    '- 田哥回答或补充之后，没写过稿的人就动笔。同一轮里你看不到别人这一轮的发言，各写各的，不要等别人。',
    '- 田哥点评某份稿时（哪里好、哪里不好），被点到的人按点评改，发改后的完整稿。',
    '- 田哥点名让某一位汇总时，只有那一位动笔：读完群里所有稿和田哥的全部点评，取各稿之长，按点评改定，发出定稿。其他人不必重复写，最多补一句建议。',
    '',
    '## 稿件怎么交',
    '- 稿件直接写在你的群聊回复里，完整的 Markdown 正文，不要写成 HTML，也不要只贴文件路径。',
    `- 同时把同一份正文保存为 ${workspace}\\drafts\\${slug}.md（改稿时覆盖）；汇总改定的那一位另存为 ${workspace}\\final.md。`,
    '- 第一行用“# 标题”写你建议的标题。',
    '- 正文之后空一行，用一两句话说明你这份稿的切入方式和取舍。只说这一两句，不要列出你遵循了哪些规则。',
    '',
    '## 怎么写',
    '- 照下面的田哥文风写。写之前先读一遍田哥的范文：' + exemplarsFile + '，照着节奏和口吻写，不照搬内容；再读起草指南：' + paths.draftGuide + '。',
    '- 把握程度写进措辞（“在……条件下”“这只是类比”），正文里不加【推断】之类的标签，也不写层层免责的声明。',
    '- 事实、数字、论文要准；拿不准的，在稿后说明里指出，不要编。',
    '',
    '## 田哥的文风',
    voiceCore(skill) || '（没有找到文风 skill）',
  ].join('\n');
}

module.exports = { buildWritingScenePrompt, voiceCore };
