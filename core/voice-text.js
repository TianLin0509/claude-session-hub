'use strict';
// 语音文字的整理与「背景」拼装：
// - cleanFillers：去掉独立的语气词（嗯、呃、啊……），不碰词语里的字（额度、好啊）。
// - 词库：voice-input.json 的 global = { terms（通用热词，所有项目）, personal（个人背景，只给本地模型） }。
// - 动态背景：当前会话最近的对话（Hub 的聊天记录 md 末尾），只给本地模型，不上传云端。
const fs = require('node:fs');

const FILLER = '(?:嗯+|呃+|额+|啊+|唔+|哦+|噢+|欸+|诶+|哎+|呣+)';
const SEP = '[，。！？、；：,.!?;:…\\s]';
// 独立语气词：出现在开头或标点后，且后面紧跟标点或结尾（「好啊」「额度」不受影响）
const STANDALONE = new RegExp(`(^|${SEP})${FILLER}(?=${SEP}|$)${SEP}*`, 'g');
// 「嗯、呃」几乎不作句末语气词：紧跟在词后、后面是标点或结尾时也去掉（「好啊」的「啊」、「金额」的「额」不在此列）
const TRAILING = new RegExp(`(?:嗯+|呃+|唔+|呣+)(?=${SEP}|$)`, 'g');
function cleanFillers(text) {
  let out = String(text || ''), prev;
  do { prev = out; out = out.replace(STANDALONE, '$1').replace(TRAILING, ''); } while (out !== prev);
  return out
    .replace(/^[，。、；：,.;:\s]+/, '')          // 开头残留的标点
    .replace(/([，、；：,;:])\s*(?=[，。！？,.!?])/g, '') // 逗号接句号：留后者
    .replace(/([，。！？])\1+/g, '$1')
    .trim();
}

const LIMITS = { terms: 300, termLength: 60, personal: 2000, dynamic: 1500 };
function normalizeGlobal(value = {}) {
  const terms = [...new Set(String(value.terms || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean))];
  if (terms.length > LIMITS.terms || terms.some(t => t.length > LIMITS.termLength)) throw new Error(`通用热词最多 ${LIMITS.terms} 个，每个不超过 ${LIMITS.termLength} 字`);
  const personal = String(value.personal || '').trim();
  if ([...personal].length > LIMITS.personal) throw new Error(`个人背景最多 ${LIMITS.personal} 字`);
  return { terms: terms.join('\n'), personal };
}
const termList = s => String(s || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean);

// 云端（Token Plan / 实时 API / 按量流式）用的词表：项目术语优先，再补通用热词，最多 80 个；不含个人背景与动态背景。
function cloudProfile(profile = {}, global = {}) {
  const terms = [...new Set([...termList(profile.terms), ...termList(global.terms)])].slice(0, 80);
  return { terms: terms.join('\n'), context: String(profile.context || '') };
}
// 本地模型的背景文本：个人背景 + 全部热词 + 项目说明 + 最近对话（本机处理，不上传）。实测近千字背景不拖慢识别。
function localBackground(profile = {}, global = {}, dynamic = '') {
  const terms = [...new Set([...termList(profile.terms), ...termList(global.terms)])];
  return [String(global.personal || '').trim(), terms.length ? '常用词：' + terms.join('、') : '',
    String(profile.context || '').trim(), dynamic ? '最近的对话：' + dynamic : ''].filter(Boolean).join('\n');
}

// 聊天记录 md 的末尾若干字：去掉标题、工具行、来源说明，只留对话文字。
function recentFromTranscript(file, maxChars = LIMITS.dynamic) {
  try {
    const stat = fs.statSync(file);
    const fd = fs.openSync(file, 'r');
    const size = Math.min(stat.size, maxChars * 6);
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size); fs.closeSync(fd);
    const text = buf.toString('utf8').split(/\r?\n/)
      .filter(line => line.trim() && !/^(#|>|- (来源|工作目录|原始记录|Hub 会话|生成)：)/.test(line.trim()))
      .join(' ').replace(/\s+/g, ' ');
    return [...text].slice(-maxChars).join('');
  } catch { return ''; }
}

module.exports = { cleanFillers, normalizeGlobal, cloudProfile, localBackground, recentFromTranscript, LIMITS };
