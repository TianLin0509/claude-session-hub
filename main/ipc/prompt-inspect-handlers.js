'use strict';
// 卡片上的「查看完整 Prompt」入口。渲染进程只拿结构化结果，不做任何文件系统访问。

const { buildInspection } = require('../../core/prompt-inspect.js');

function registerPromptInspectIpc(ipcMain, deps) {
  const { sessionManager } = deps;

  ipcMain.handle('prompt-inspect', (_e, payload) => {
    const req = payload && typeof payload === 'object' ? payload : {};
    let cwd = typeof req.cwd === 'string' && req.cwd ? req.cwd : null;
    let kind = typeof req.kind === 'string' && req.kind ? req.kind : null;

    if ((!cwd || !kind) && req.sessionId && sessionManager) {
      const s = sessionManager.getSession(req.sessionId);
      if (s) {
        if (!cwd) cwd = s.cwd || null;
        if (!kind) kind = s.kind || null;
      }
    }
    if (!cwd) return { ok: false, error: '这个会话没有记录 cwd，无法还原注入内容' };

    try {
      return { ok: true, data: buildInspection({ cwd, kind: kind || 'claude' }) };
    } catch (error) {
      return { ok: false, error: (error && error.message) ? error.message : String(error) };
    }
  });
}

module.exports = { registerPromptInspectIpc };
