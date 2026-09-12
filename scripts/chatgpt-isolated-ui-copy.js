'use strict';
const fs = require('fs'), path = require('path');
module.exports = function patchIsolatedUi(appRoot) {
  const replacements = [
    ['请彻底退出 Codex（包括后台进程），然后重新打开以刷新模型列表。仅退出并重新登录账号或只关闭窗口不算重启。请保持此启动器开启。', '这是 AI Hub 的 ChatGPT 专用环境。配置变更后仅新建或重开 ChatGPT 会话；请保留其他 Codex 会话。使用期间保持此启动器开启。'],
    ['Fully quit Codex, including its background process, then reopen it to refresh the model picker. Signing out and back in or only closing the window is not a restart. Keep this launcher open.', 'This is the isolated AI Hub ChatGPT environment. Reopen only ChatGPT sessions after configuration changes. Keep other Codex sessions running.'],
    ['设置 Codex Web GPT', 'AI Hub · ChatGPT 专用设置'],
    ['安装到 Codex', '配置专用 ChatGPT'],
    ['将 ChatGPT Web 模型添加到 Codex，且不替换原生模型目录。当前自定义路由会被保存，并在关闭 Bridge 时恢复。', '只配置 ChatGPT 专用环境。不会修改普通 Codex 的模型、账号或路由。'],
  ];
  const assets = path.join(appRoot, 'dist', 'assets');
  const files = fs.readdirSync(assets).filter(n => n.endsWith('.js'));
  const content = new Map(files.map(name => [name, fs.readFileSync(path.join(assets, name), 'utf8')]));
  for (const [before, after] of replacements) {
    let count = 0;
    for (const name of files) {
      const text = content.get(name);
      if (!text.includes(before)) continue;
      count += text.split(before).length - 1;
      content.set(name, text.split(before).join(after));
    }
    if (count < 1) throw new Error('Isolated UI copy anchor changed: ' + before.slice(0,30));
  }
  for (const [name, text] of content) fs.writeFileSync(path.join(assets, name), text);
};
