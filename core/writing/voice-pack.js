'use strict';
// core/writing/voice-pack.js
//
// 把田哥的文风作为「常驻指令」装进写作群的每位成员（2026-10-03 田哥要求：文风要导入，让 AI 遵守）。
//
// 之前群规则只给文风文件的路径、让 AI 自己去读：读不读、读多少全看模型（10-01 那篇里 Codex 先回了一大段
// 闲聊，Claude 在稿末追加了写作说明）。现在每次启动或唤醒写作成员时，把文风指南、真实改稿偏好、起草指南
// 拼成一份文件，写进文章目录的 AGENTS.md：
//   - Codex / DeepSeek（都是 Codex CLI）：文章目录有 .vibe-root，是项目根，AGENTS.md 会作为项目指令自动加载
//   - Claude：同一个文件经 --append-system-prompt-file 追加进系统提示（写作成员关掉了 CLAUDE.md）
// 群规则仍然只讲交稿格式（core/writing/scene-prompt.js），两边各管一件事。
//
// Codex 对项目指令有 32 KiB 上限（project_doc_max_bytes），超出部分被截掉。所以只拼核心三份，
// 范文与各类参考给绝对路径，让 AI 按 SKILL.md 的「按需参考」挑着读。

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
    '# 写作须知：田哥的文风',
    '',
    '你在 Hub 的写作群里帮田哥写中文文章。下面三份是田哥的文风指南、真实改稿偏好和起草指南，起草、改稿、定稿都照它们写。',
    `- 文中提到的 references/、exemplars.md 都在 ${paths.voiceDir}。动笔前从 exemplars.md 挑两三段与本篇用途相近的范文读原文，难点再按「按需参考」表读对应文件。`,
    '- 照范文的节奏、句长和口吻写，内容按本篇的材料重新组织。',
    '- 交稿格式以群规则为准：文章放在「<!-- 文章开始 -->」「<!-- 文章结束 -->」两行之间，写给田哥的话放在后面。',
    '- 本文件由 Hub 按文风 skill 自动生成，每次启动写作成员时刷新；改文风请改 skill 本身。',
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
