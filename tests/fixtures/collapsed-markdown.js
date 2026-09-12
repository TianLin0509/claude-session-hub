'use strict';
module.exports = '**折叠也要看清重点：' + '完整加粗内容不能在旧的二百四十字符边界被截断。'.repeat(12) + '**\n\n'
  + '- 第一项 **粗体**\n- 第二项 `inlineCode`\n\n'
  + '| 检查 | 结果 |\n| --- | --- |\n| Markdown | 正常 |\n\n'
  + '```javascript\nconst answer = "<safe>";\nconsole.log(answer);\n```\n\n'
  + '[项目说明](https://example.com/guide)\n\n'
  + '<script>window.__markdownInjected = true</script>\n\n'
  + Array.from({length:36}, (_, i) => `${i + 1}. 完整正文保留用于展开、复制和历史回放。`).join('\n')
  + '\n\nEND-OF-MARKDOWN-ANSWER';
