'use strict';
// core/writing/voice-pack.js
//
// 写作成员的系统指令（2026-10-03 田哥要求：文风要导入，让 AI 遵守；2026-10-11 要求：写作成员是写文章的大师，
// 不是编程助手，上下文完全为写作而生）。
//
// 每次启动或唤醒写作成员时，把「你是谁」、文风指南、真实改稿偏好、起草指南拼成一份文件，写进文章目录的
// AGENTS.md，作为成员唯一的基础指令（见 core/writing/member-opts.js）：
//   - Claude：--system-prompt-file 换掉 Claude Code 自带的编程助手系统提示
//   - Codex / DeepSeek（都是 Codex CLI）：model_instructions_file 换掉编程助手的基础指令；写作专用配置目录里
//     project_doc_max_bytes = 0，不再把它当项目文档重复加载
// 群规则只讲每轮做什么与交稿格式（core/writing/scene-prompt.js），两边各管一件事。
//
// 范文与各类参考给绝对路径，让 AI 按 SKILL.md 的「按需参考」挑着读。篇幅仍控制在 30 KiB 内。

const fs = require('fs');
const path = require('path');
const { writingPaths } = require('./config.js');

const PACK_NAME = 'AGENTS.md';
const MAX_BYTES = 30 * 1024;

function readText(file) { try { return fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } }

function stripFrontmatter(text) {
  return String(text || '').replace(/^---\n[\s\S]*?\n---\n*/, '').trim();
}

// SKILL.md 里的相对链接（references/xx.md、exemplars.md）换成绝对路径：AI 的工作目录是文章目录，不是 skill 目录
function absolutizeLinks(text, baseDir) {
  return String(text || '').replace(/\]\((?!https?:|[a-zA-Z]:[\\/]|\/)([^)\s]+\.md)\)/g, (_all, rel) => `](${path.join(baseDir, rel)})`);
}

// 文件按字节截断时不劈开多字节字符，截断处写明原文件位置
function capBytes(text, maxBytes, source) {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= maxBytes) return text;
  let cut = buf.subarray(0, maxBytes).toString('utf8').replace(/�+$/, '');
  cut = cut.slice(0, cut.lastIndexOf('\n') > 0 ? cut.lastIndexOf('\n') : cut.length);
  return `${cut}\n\n（篇幅所限到此为止，完整内容见 ${source}）`;
}

function buildVoicePack(paths = writingPaths()) {
  const skillFile = path.join(paths.voiceDir, 'SKILL.md');
  const skill = stripFrontmatter(readText(skillFile));
  const learned = readText(path.join(paths.voiceDir, 'learned-from-edits.md')).trim();
  const draft = readText(paths.draftGuide).trim();
  if (!skill && !draft) return '';

  const parts = [
    '# 写作须知',
    '',
    '## 你是谁',
    '',
    '你是一位中文写作者，和田哥一起写文章。田哥出想法、定方向、改定稿；你把文章写出来，写得让读者愿意一口气读完、读完有收获、过几天还记得。你的功夫全在文字上：想清楚一个判断，找到最打动人的讲法，用最准确的词把它说出来。',
    '',
    '- 读材料：田哥给的会话记录、实验数据、旧文，都可以用工具打开来读；需要核实或补充的资料，可以上网查。',
    '- 交稿：按群里的要求把这一轮的回答写进指定的文件。交稿格式以群规则为准：文章放在「<!-- 文章开始 -->」「<!-- 文章结束 -->」两行之间，写给田哥的话放在后面。',
    `- 下面依次是田哥的文风指南、他真实改稿中的偏好、起草指南。文中提到的 references/、exemplars.md 都在 ${paths.voiceDir}。动笔前从 exemplars.md 挑两三段与本篇用途相近的范文读原文，照范文的节奏、句长和口吻写，内容按本篇的材料重新组织；难点再按「按需参考」表读对应文件。`,
  ];
  if (skill) parts.push('', '---', '', absolutizeLinks(skill, paths.voiceDir));
  if (learned) parts.push('', '---', '', learned.replace(/^#\s/m, '## '));
  if (draft) parts.push('', '---', '', draft.replace(/^#\s+起草\s*$/m, '# 起草指南'));
  return `${capBytes(parts.join('\n'), MAX_BYTES, skillFile)}\n`;
}

/** 把文风包写进文章目录；内容没变就不写。返回文件路径，没写成返回 null（调用方照常启动成员）。 */
function writeVoicePack(dir, paths = writingPaths()) {
  if (!dir || !fs.existsSync(dir)) return null;
  try {
    if (!fs.statSync(dir).isDirectory()) return null;
    const text = buildVoicePack(paths);
    if (!text) return null;
    const file = path.join(dir, PACK_NAME);
    if (readText(file) !== text) fs.writeFileSync(file, text, 'utf8');
    return file;
  } catch (err) {
    console.warn('[writing] 文风包没写成：', dir, err && err.message);
    return null;
  }
}

module.exports = { buildVoicePack, writeVoicePack, absolutizeLinks, PACK_NAME, MAX_BYTES };
