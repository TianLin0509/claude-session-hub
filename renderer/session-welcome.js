'use strict';
const path = require('path');

function renderSessionWelcome(session, escapeHtml) {
  const kind = String(session?.kind || 'claude').replace(/-resume$/, '');
  const provider = kind==='deepseek-acp' ? 'deepseek' : ['claude', 'codex', 'gemini', 'kimi', 'deepseek','qwen','glm'].includes(kind) ? kind : 'claude';
  const label = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini', kimi: 'Kimi', deepseek: 'DeepSeek',qwen:'千问 · Qwen Code',glm:'智谱 · ZCode' }[provider];
  const mark=['qwen','glm'].includes(provider) ? `<span aria-label="${label}">${provider==='qwen'?'QW':'GLM'}</span>`
    : `<img src="assets/ai-logos/${provider}.svg" alt="${label}" />`;
  const cwd = session?.cwd || '';
  const project = session?.workspaceLabel || path.basename(cwd) || '当前工作区';
  const actions = [
    ['梳理项目', '先了解结构，再决定下一步', '请先梳理当前项目的结构与主要入口，简要说明各部分的作用，先不要修改代码。', '<path d="M3 7h7l2 2h9v10H3Z"/><path d="M3 7V4h7l2 3"/>'],
    ['实现想法', '把目标变成可执行的改动', '我想在当前项目实现一个功能：', '<path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/>'],
    ['排查问题', '从现象和证据开始定位', '请帮我排查这个问题，先确认原因再修改。现象是：', '<circle cx="10" cy="10" r="6"/><path d="m15 15 6 6M10 7v4m0 2v.1"/>'],
  ];
  return `<section class="msg-overlay-placeholder session-welcome" aria-label="新会话欢迎页">
    <div class="session-welcome-mark">${mark}</div>
    <span class="session-welcome-eyebrow">和 ${label} 一起开始</span>
    <h2>今天，想完成什么？</h2>
    <p class="session-welcome-intro">描述你的目标，或从下面选一个起点。</p>
    <div class="session-welcome-project" title="${escapeHtml(cwd)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7V5h7l2 2h9v12H3Z"/></svg><span>${escapeHtml(project)}</span></div>
    <div class="session-welcome-actions">${actions.map(([title, detail, prompt, icon]) => `<button type="button" data-welcome-prompt="${escapeHtml(prompt)}" title="填入输入框，确认后再发送；已有草稿会保留"><svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><strong>${title}</strong><small>${detail}</small></button>`).join('')}</div>
    <p class="session-welcome-hint">消息、文件或一个还没成形的想法，都可以从这里开始。</p>
  </section>`;
}
module.exports = { renderSessionWelcome };
