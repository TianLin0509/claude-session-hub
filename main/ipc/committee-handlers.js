'use strict';

/**
 * 投委会 IPC（task#5）。
 * committee:start —— 开投委会：fire-and-forget 启动五幕编排，立即返回 {status:'started'}；
 * 进度（幕次/双榜/主席报告）通过 sendToRenderer('committee:progress') 事件流推给 renderer。
 * 符合「弹窗一键开始 → 全自动跑完 → 自动退出」：renderer 不阻塞等待，靠事件流渲染。
 */
function registerCommitteeIpc(ipcMain, deps) {
  const {
    committeeConductor,
    logger = console,
    history,
    getHubDataDir,
    screenerScore = require('../../core/screener-score'),
    screenerPause = (ms) => new Promise(resolve => setTimeout(resolve, ms)),
  } = deps;

  ipcMain.handle('committee:start', async (_e, args = {}) => {
    if (!committeeConductor) return { status: 'error', reason: 'conductor 未装配' };
    const meetingId = args.meetingId;
    const stocks = Array.isArray(args.stocks) ? args.stocks : [];
    const rounds = args.rounds;
    if (!meetingId) return { status: 'error', reason: 'meetingId 缺失' };
    if (!stocks.length) return { status: 'error', reason: '未指定标的（代码/名）' };
    // 不 await：全自动后台跑，renderer 监听 committee:progress 渲染幕次/双榜，跑完自动回自由聊。
    Promise.resolve()
      .then(() => committeeConductor.run(meetingId, { stocks, rounds }))
      .catch(err => logger.error('[committee:start] run threw:', err && err.message));
    return { status: 'started', meetingId, stocks, rounds };
  });

  // 过往投委会：历史摘要列表 + 单场详情（点3a「随时唤起过往投委会」+ 点4 回看每幕每个 AI 的发言）。
  ipcMain.handle('committee:history:list', async () => {
    try { return { status: 'ok', items: history && getHubDataDir ? history.listRecords(getHubDataDir(), 50) : [] }; }
    catch (e) { logger.error('[committee:history:list]', e && e.message); return { status: 'error', reason: e && e.message, items: [] }; }
  });
  ipcMain.handle('committee:history:get', async (_e, { id } = {}) => {
    try { return { status: 'ok', record: history && getHubDataDir ? history.getRecord(getHubDataDir(), id) : null }; }
    catch (e) { logger.error('[committee:history:get]', e && e.message); return { status: 'error', reason: e && e.message }; }
  });

  // 技术初筛：与投委会五幕解耦，但仍在投研 Hub 内给可见进度和结果面板。
  ipcMain.handle('committee:screener:run', async (event, args = {}) => {
    const meetingId = args.meetingId || '';
    const runId = args.runId || ('scr-' + Date.now());
    const send = (payload) => {
      try {
        if (event && event.sender && typeof event.sender.send === 'function') {
          event.sender.send('committee:screener:progress', Object.assign({ meetingId, runId }, payload));
        }
      } catch (e) {
        logger.warn && logger.warn('[committee:screener] progress send failed:', e && e.message);
      }
    };
    try {
      send({ type: 'start', stage: '启动', percent: 5, message: '正在进入当天技术初筛' });
      await screenerPause(60);
      send({ type: 'progress', stage: '读取快照', percent: 35, message: '读取 kline-screener 最新快照' });
      const result = screenerScore.latestSnapshot({ limit: args.limit || 12 });
      await screenerPause(60);
      send({ type: 'progress', stage: '生成榜单', percent: 75, message: '按追涨/蓄势两种模式排序' });
      await screenerPause(60);
      send({ type: 'done', stage: '完成', percent: 100, message: '技术初筛结果已生成', result });
      return { status: 'ok', meetingId, runId, result };
    } catch (e) {
      const reason = (e && e.message) || '技术初筛失败';
      send({ type: 'error', stage: '失败', percent: 100, message: reason, reason });
      return { status: 'error', meetingId, runId, reason };
    }
  });
}

module.exports = { registerCommitteeIpc };
