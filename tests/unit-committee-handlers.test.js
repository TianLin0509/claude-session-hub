'use strict';
/**
 * 投委会 IPC 装配单测（task#5）。mock ipcMain/conductor，验证 committee:start：
 * fire-and-forget 立即返回 started、参数校验、conductor 未装配/抛错的兜底。
 */
const assert = require('assert');
const path = require('path');
const { registerCommitteeIpc } = require(path.join(__dirname, '..', 'main', 'ipc', 'committee-handlers.js'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

function mkIpc() { const h = {}; return { ipc: { handle: (ch, fn) => { h[ch] = fn; } }, h }; }
const silent = { error: () => {}, warn: () => {} };

(async () => {
  // ── 正常注册 + fire-and-forget ──
  const runCalls = [];
  const conductor = { run: async (mid, opts) => { runCalls.push({ mid, opts }); return { status: 'completed' }; } };
  const { ipc, h } = mkIpc();
  registerCommitteeIpc(ipc, { committeeConductor: conductor });
  ok(typeof h['committee:start'] === 'function', '注册 committee:start handler');

  const r = await h['committee:start'](null, { meetingId: 'm1', stocks: [{ code: '688256', name: '寒武纪' }], rounds: 4 });
  ok(r.status === 'started', 'fire-and-forget：立即返回 started（不阻塞等 conductor 跑完）');
  ok(r.meetingId === 'm1' && r.rounds === 4, 'started 回执含 meetingId/rounds');
  await new Promise(res => setImmediate(res)); // 让 fire-and-forget 的 run 触发
  ok(runCalls.length === 1 && runCalls[0].mid === 'm1', 'conductor.run 被异步调用');
  ok(runCalls[0].opts.rounds === 4 && runCalls[0].opts.stocks[0].code === '688256', 'run 透传 stocks/rounds');

  // ── 参数校验 ──
  const e1 = await h['committee:start'](null, { meetingId: 'm1', stocks: [] });
  ok(e1.status === 'error' && e1.reason.includes('标的'), '空标的→error');
  const e2 = await h['committee:start'](null, { stocks: [{ code: 'x' }] });
  ok(e2.status === 'error' && e2.reason.includes('meetingId'), '缺 meetingId→error');

  // ── conductor 未装配 ──
  const { ipc: ipc2, h: h2 } = mkIpc();
  registerCommitteeIpc(ipc2, {});
  const e3 = await h2['committee:start'](null, { meetingId: 'm1', stocks: [{ code: 'x' }] });
  ok(e3.status === 'error' && e3.reason.includes('未装配'), 'conductor 未装配→error');

  // ── conductor.run 抛错：仍返回 started，错误被 catch，不崩 IPC ──
  const { ipc: ipc3, h: h3 } = mkIpc();
  registerCommitteeIpc(ipc3, { committeeConductor: { run: async () => { throw new Error('boom'); } }, logger: silent });
  const r3 = await h3['committee:start'](null, { meetingId: 'm1', stocks: [{ code: 'x' }] });
  ok(r3.status === 'started', 'conductor 抛错时仍返回 started（错误被 catch）');
  await new Promise(res => setImmediate(res)); // 让 catch 触发，确认不抛出未捕获异常

  // ── 技术初筛 IPC：独立于投委会，返回最新快照并推送进度事件 ──
  const { ipc: ipc4, h: h4 } = mkIpc();
  const fakeSnapshot = {
    end_date: '20260630',
    generated: '2026-06-30 15:37:18',
    total: 2,
    chase_count: 1,
    setup_count: 1,
    top_chase: [{ code: '300420', name: '五洋自控', chase_score: 98.5 }],
    top_setup: [{ code: '603823', name: '百合花', setup_score: 88 }],
  };
  registerCommitteeIpc(ipc4, {
    committeeConductor: conductor,
    logger: silent,
    screenerScore: { latestSnapshot: () => fakeSnapshot },
    screenerPause: async () => {},
  });
  ok(typeof h4['committee:screener:run'] === 'function', '注册 committee:screener:run handler');
  const sent = [];
  const rr = await h4['committee:screener:run']({ sender: { send: (ch, payload) => sent.push({ ch, payload }) } }, { meetingId: 'm1', runId: 'r1', limit: 5 });
  ok(rr.status === 'ok' && rr.result.top_chase[0].name === '五洋自控', 'screener:run 返回技术初筛结果');
  ok(sent.length >= 3 && sent.some(x => x.ch === 'committee:screener:progress' && x.payload.type === 'done'), 'screener:run 推送 start/progress/done 事件');
  ok(sent.every(x => x.payload.meetingId === 'm1' && x.payload.runId === 'r1'), 'screener:progress 带 meetingId/runId 便于 UI 绑定');

  console.log('\n' + (fails === 0 ? '=== committee-handlers 装配全绿 ===' : '=== ' + fails + ' FAILED ==='));
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('THREW', e); process.exit(1); });
