'use strict';
// Explicit live quality check. No keys or provider bodies are written to evidence.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { createPromptPolisher } = require('../core/prompt-polish');
const polish = createPromptPolisher({ getConfig: () => require('../core/hub-config').getConfig() });
const cases = [
  { name: '语音讨论与阶段边界', text: '之前看到过有一个功能叫优化Prompt，意思是比如说我输入一段话之后可以点击那个按钮，然后帮我把这个Prompt优化成给Agent更好的文字。你觉得这个对我们AI Hub有没有必要？是不是应该在AI Hub里面加这样一个按键？按钮放在发送键旁边，只有我点了才把输入框信息发到DeepSeek API整理。这个有没有帮助，你觉得需不需要做？', check: t => { assert(/[？?]/.test(t)); assert(t.includes('DeepSeek')); assert(t.includes('API')); assert(/发送/.test(t)); } },
  { name: '明确执行与等待审批', text: '嗯，你就先做一下这个按钮吧，用 DeepSeek 4.1 Flash，对，只整理当前输入框的文字。开发完先测试，等我说合入以后再合入，生产 AI Hub 不要重启。', check: t => { assert(t.includes('DeepSeek 4.1 Flash')); assert(t.includes('合入')); assert(/等|确认|批准/.test(t)); assert(/不.*重启/.test(t)); } },
  { name: '路径数字条件完整', text: '帮我看一下 `C:\\AIWork\\调度实验\\数据.csv`，对，先算一下平均吞吐，保留 2 位小数，只看 SINR >= 10 dB 的样本。别修改原文件。如果缺少 throughput 这一列就告诉我，我还没决定是否做图。', check: t => { for (const s of ['`C:\\AIWork\\调度实验\\数据.csv`', '2', 'SINR >= 10 dB', 'throughput']) assert(t.includes(s), s); assert(/未|没|尚/.test(t)); } },
  { name: '简短上下文指代', text: '按刚才那个方案改。', check: t => assert.equal(t, '按刚才那个方案改。') },
  { name: '引用代码逐字保留', text: '嗯先解释这段代码为什么报错，暂时只分析原因。\n```js\nconst limit = 10;\nconsole.log(limit.toFixed(2));\n```\n还有这条命令 `node --check app.js` 是什么意思？', check: t => { assert(t.includes('```js\nconst limit = 10;\nconsole.log(limit.toFixed(2));\n```')); assert(t.includes('`node --check app.js`')); assert(/[？?]/.test(t)); } },
];
async function main() {
  const evidence = [];
  for (const item of cases) {
    const result = await polish(item.text); item.check(result.text);
    evidence.push({ name: item.name, input: item.text, ...result, passed: true });
  }
  const out = path.resolve(__dirname, '../artifacts/20261001-prompt-polish-codex1/20261001-live-quality-codex1.json');
  fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify({ ok: true, out, results: evidence }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
