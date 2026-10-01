'use strict';
// core/writing/scene-prompt.js
//
// 写作场景群聊的群规则（替换通用群规则，只在首轮与上下文压缩后注入一次）。
//
// 2026-10-01 田哥体验后改版：写作在写作 Tab 里完成，群聊退到后台。Tab 靠回答末尾的 hub-writing 卡片
// 认出「这是一份稿 / 定稿 / 想问的问题」（解析见 core/writing/workbench.js），所以这里要把卡片格式讲清楚。
// 回答文件本身就是交稿（core/group-answer-files.js），Hub 自己把稿存进文章目录，AI 不用另存一份。
//
// 文风不再整段塞进群规则，改成给文件路径让 AI 自己读：群规则越短，首条消息越不容易超过 Codex
// 长文本输入通道的门槛（2026-10-01 田哥那篇里 DeepSeek 就卡在这一步，见 core/codex-editor-input.js）。

const path = require('path');
const { writingPaths } = require('./config.js');

function buildWritingScenePrompt(displayName, opts = {}, env = process.env) {
  const paths = writingPaths(env);
  const name = displayName || 'AI';
  return [
    '## 这是写作群聊',
    `你是${name}。田哥是作者，你和群里其他 AI 帮他写一篇中文技术文章。田哥在「写作 Tab」里读你们的稿、回答问题、点评；Tab 只认下面的卡片，格式不对他就看不到你的稿。`,
    '',
    '## 每轮做什么',
    '- 田哥的第一条消息是中心思想：直接写一版完整初稿。有只有田哥才知道的信息缺口，就附问题卡（2 到 4 个问题，每个带你的推荐答案），稿里先按推荐答案写，不等他回答。',
    '- 田哥回答问题或点评之后：每位都按回答和点评改自己的稿，交完整的新版本（点评没提到你，就参考他对别人的意见改）。',
    '- 田哥点名某一位汇总定稿：只有那一位写。读完群里所有稿和田哥的全部点评，取各稿之长改定，交定稿卡。',
    '',
    '## 回答怎么写',
    '- 回答文件的正文就是完整稿件：Markdown，第一行“# 标题”，不要写成 HTML，不要只贴文件路径。Hub 会把稿存进文章目录，你不用另存。',
    '- 回答最后附一张卡片：一个语言标记为 hub-writing 的代码块，里面一行 JSON。',
    '  - 交稿：{"type":"draft","title":"标题","note":"一两句话：这份稿的切入和取舍"}',
    '  - 定稿：{"type":"final","title":"标题","note":"一两句话：按哪些点评改了什么"}',
    '  - 要问田哥时，同一个代码块里再加一行：{"type":"questions","items":[{"q":"问题","recommend":"你的推荐答案"}]}',
    '- 卡片之外不写别的说明，也不列你遵循了哪些规则。事实、数字拿不准的，写进 note。',
    '',
    '## 照田哥的文风写',
    `- 动笔前读：文风 ${path.join(paths.voiceDir, 'SKILL.md')}，范文 ${path.join(paths.voiceDir, 'exemplars.md')}，起草指南 ${paths.draftGuide}。照节奏和口吻写，不照搬内容。`,
    '- 把握程度写进措辞（“在……条件下”“这只是类比”），正文里不加【推断】之类的标签，也不写层层免责的声明。',
  ].join('\n');
}

module.exports = { buildWritingScenePrompt };
