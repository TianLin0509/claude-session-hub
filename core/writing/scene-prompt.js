'use strict';
// core/writing/scene-prompt.js
//
// 写作场景群聊的群规则（替换通用群规则，只在首轮与上下文压缩后注入一次）。
//
// 写作在写作 Tab 里完成，群聊是后台（2026-10-01）。Tab 从每位 AI 的回答里取出文章，按 Markdown 排版，
// 每位一个标签页（解析见 core/writing/workbench.js），所以这里只讲一件事：回答怎么分成「文章」和「给田哥的话」。
//
// 2026-10-03 交稿格式从 JSON 卡片改成两行 HTML 注释标记 + 两个固定小标题：10-01 实测三家都没附 JSON 卡片，
// Claude 还把写作说明接在正文末尾。标记在 Markdown 里不显示，群聊里读起来依旧干净。
//
// 文风不在这里：启动成员时作为常驻指令装进去（core/writing/voice-pack.js）。这里只留文件路径作后备，
// 群规则越短，首条消息越不容易超过 Codex 长文本输入通道的门槛（见 core/codex-editor-input.js）。

const path = require('path');
const { writingPaths } = require('./config.js');

function buildWritingScenePrompt(displayName, opts = {}, env = process.env) {
  const paths = writingPaths(env);
  const name = displayName || 'AI';
  return [
    '## 这是写作群聊',
    `你是${name}。田哥是作者，群里几位 AI 各写一版，帮他写成一篇中文文章。田哥在「写作 Tab」里读稿：每位一个标签页，Tab 取两行标记之间的 Markdown 排版成文章，标记之后的内容作为你写给田哥的话单独显示。`,
    '',
    '## 每轮做什么',
    '- 田哥的第一条消息是中心思想：直接写一版完整初稿。缺只有田哥知道的信息，就在「想问田哥」里提 2 到 4 个问题，每个附你的推荐答案，稿里先按推荐答案写。',
    '- 田哥回答问题或点评之后：每位都按回答和点评改自己的稿，交完整的新版本（点评没提到你，就参考他对别人的意见改）。',
    '- 田哥点名某一位汇总定稿：只有那一位写。读完群里所有稿和田哥的全部点评，取各稿之长改定，用定稿标记交稿。',
    '',
    '## 回答的格式',
    '每次回答都是下面这个样子：',
    '',
    '<!-- 文章开始 -->',
    '# 文章标题',
    '',
    '完整正文（Markdown）……',
    '<!-- 文章结束 -->',
    '',
    '## 给田哥',
    '一两句话：这份稿的切入和取舍；拿不准的事实、数字也写在这里。',
    '',
    '## 想问田哥',
    '1. 问题',
    '   推荐：你的推荐答案',
    '',
    '- 两行标记之间只放文章本身：从「# 标题」开始，到正文最后一句结束。对田哥说的话、写作思路、待确认的事项都写进「给田哥」。',
    '- 定稿时两行标记换成 <!-- 定稿开始 --> 和 <!-- 定稿结束 -->。',
    '- 没有要问的，「想问田哥」整节省掉。正文用 Markdown，稿件直接写在回答里，Hub 会存进文章目录。',
    '',
    '## 照田哥的文风写',
    `- 田哥的文风指南已作为常驻指令装给你（文章目录的 AGENTS.md）。没看到的话，动笔前读 ${path.join(paths.voiceDir, 'SKILL.md')}、范文 ${path.join(paths.voiceDir, 'exemplars.md')}、起草指南 ${paths.draftGuide}。`,
    '- 把握程度写进措辞（“在……条件下”“这只是类比”），正文保持文章本来的样子。',
  ].join('\n');
}

module.exports = { buildWritingScenePrompt };
