'use strict';

// 「引用会话」的两个 IPC：列出可引用的会话、把选中会话解析成聊天记录 md 路径。
// 设计说明见 core/session-reference.js。

const fs = require('node:fs');
const { referenceableRows } = require('../../core/session-reference.js');

// md 在每次提交/每轮结束后由索引自动重写，绝大多数时候已是最新，直接用、零等待。
// 只有原始记录比 md 新（源会话正在回答，或索引还没跟上）才显式刷新一次；
// 全量刷新在冷启动或别的刷新进行中时可能要几分钟，所以只等这么久，
// 超时就用已有的 md，并如实告诉用户可能缺最近的内容。
const DEFAULT_REFRESH_TIMEOUT_MS = 5000;
const HEADER_BYTES = 4096;

// md 头部写着「- 原始记录：<路径>」（core/session-transcript-md.js）。
// 读不到或没有这一行（例如群聊来源）一律当作「不确定是否最新」。
function mdIsCurrent(mdPath) {
  let fd = null;
  try {
    fd = fs.openSync(mdPath, 'r');
    const buffer = Buffer.alloc(HEADER_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, HEADER_BYTES, 0);
    const match = buffer.subarray(0, bytes).toString('utf8').match(/^- 原始记录：(.+)$/m);
    if (!match) return false;
    return fs.statSync(match[1].trim()).mtimeMs <= fs.fstatSync(fd).mtimeMs;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}

function registerSessionReferenceIpc(ipcMain, deps = {}) {
  const searchService = deps.searchService || null;
  const getSearchSnapshot = typeof deps.getSearchSnapshot === 'function'
    ? deps.getSearchSnapshot
    : () => ({ sessions: [], meetings: [] });
  const getMeeting = typeof deps.getMeeting === 'function' ? deps.getMeeting : () => null;
  const isCurrent = typeof deps.mdIsCurrent === 'function' ? deps.mdIsCurrent : mdIsCurrent;
  const refreshTimeoutMs = Number(deps.refreshTimeoutMs) || DEFAULT_REFRESH_TIMEOUT_MS;
  const logger = deps.logger || console;

  async function refreshWithin() {
    let timer = null;
    const refreshed = Promise.resolve()
      .then(() => searchService.refresh(getSearchSnapshot(), { immediate: true }))
      .then(() => true, error => {
        logger.warn('[session-reference] refresh failed:', error && error.message);
        return false;
      });
    const timeout = new Promise(resolve => { timer = setTimeout(() => resolve(false), refreshTimeoutMs); });
    try {
      return await Promise.race([refreshed, timeout]);
    } finally {
      clearTimeout(timer);
    }
  }

  ipcMain.handle('session-reference:list', (_e, { excludeSessionId = '' } = {}) => {
    const snapshot = getSearchSnapshot() || {};
    return referenceableRows(snapshot.sessions, {
      excludeId: excludeSessionId,
      meetingTitleOf: meetingId => {
        const meeting = getMeeting(meetingId);
        return meeting ? meeting.title : null;
      },
    });
  });

  ipcMain.handle('session-reference:resolve', async (_e, { sessionId = '' } = {}) => {
    const id = String(sessionId || '');
    if (!id) return { ok: false, error: 'missing-session', message: '没有指定要引用的会话' };
    if (!searchService || typeof searchService.transcriptFor !== 'function') {
      return { ok: false, error: 'search-unavailable', message: '会话索引不可用，无法生成聊天记录' };
    }
    const lookup = async () => {
      try {
        return { found: await searchService.transcriptFor({ hubSessionId: id }) };
      } catch (error) {
        return { error: `读取聊天记录失败：${error && error.message}` };
      }
    };
    const usable = found => !!(found && found.path && found.exists);

    let { found, error } = await lookup();
    let fresh = usable(found) && isCurrent(found.path);
    if (!fresh && typeof searchService.refresh === 'function') {
      const refreshed = await refreshWithin();
      ({ found, error } = await lookup());
      fresh = refreshed && usable(found);
    }
    if (error) return { ok: false, error: 'transcript-lookup-failed', message: error };
    if (!usable(found)) {
      return {
        ok: false,
        error: 'transcript-missing',
        message: '这个会话还没有可读取的聊天记录：至少要完成一轮对话，且来源需被会话搜索支持；'
          + '若会话索引正在建立，请稍后再试',
      };
    }
    return { ok: true, path: found.path, title: found.title || '', fresh };
  });
}

module.exports = { mdIsCurrent, registerSessionReferenceIpc };
