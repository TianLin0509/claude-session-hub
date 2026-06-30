'use strict';
/**
 * 投委会 UI 纯逻辑单测（task#6/7）。真 require committee-ui-core（无 electron 依赖），
 * 验证 parseStocks / reduceProgress 状态机 / modalHtml / panelHtml（字符串渲染 + XSS）
 * + meeting-room 钩子与 index.html 加载的静态契约。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const core = require(path.join(root, 'renderer', 'committee-ui-core.js'));

let fails = 0;
const ok = (c, m) => { if (!c) { fails++; console.log(' FAIL ' + m); } else { console.log('  ok   ' + m); } };

// ── parseStocks ──
const s1 = core.parseStocks('688256 寒武纪, 603823 百合花');
ok(s1.length === 2 && s1[0].code === '688256' && s1[0].name === '寒武纪', 'parseStocks: 逗号分隔 代码+名');
ok(core.parseStocks('600519.SH 贵州茅台')[0].code === '600519', 'parseStocks: 去 .SH 后缀');
ok(core.parseStocks('SH600519 茅台')[0].code === '600519', 'parseStocks: 去 SH 前缀');
{ const ns = core.parseStocks('寒武纪')[0]; ok(ns.code === '' && ns.name === '寒武纪', 'parseStocks: 纯名称 code 留空、name 存名（标的标识由后端 idOf 兜底，不再重复显示）'); }
{ const sp = core.parseStocks('沪电股份 沪硅产业 盛合晶微'); ok(sp.length === 3 && sp[0].name === '沪电股份' && sp[1].name === '沪硅产业' && sp[2].name === '盛合晶微' && sp.every(x => x.code === ''), 'parseStocks: 空格分隔多只纯名字→拆成 3 只（点3b 真根因·体检 0/3 元凶）'); }
{ const fw = core.parseStocks('沪电股份　沪硅产业'); ok(fw.length === 2, 'parseStocks: 全角空格也拆'); }
{ const mix = core.parseStocks('688256 寒武纪'); ok(mix.length === 1 && mix[0].code === '688256' && mix[0].name === '寒武纪', 'parseStocks: 含代码段不误拆（代码+名当一只）'); }
ok(core.parseStocks('688256\n603823').length === 2, 'parseStocks: 换行分隔');
ok(core.parseStocks('688256，寒武纪 688256').length === 1, 'parseStocks: 同代码去重');
ok(core.parseStocks('').length === 0 && core.parseStocks(null).length === 0, 'parseStocks: 空/null 安全');

// ── reduceProgress 状态机 ──
let st = core.initState();
st = core.reduceProgress(st, { type: 'start', stocks: [{ code: '688256', name: '寒武纪' }], rounds: 4, chair: 'Claude' });
ok(st.active && st.rounds === 4 && st.chair === 'Claude', 'reduce: start→active');
st = core.reduceProgress(st, { type: 'act', act: '建库' });
ok(st.curAct === '建库', 'reduce: act→curAct');
st = core.reduceProgress(st, { type: 'board', boards: { rows: [{ code: '688256', name: '寒武纪', faces: { 基本面: 60, 技术面: 88, 消息面: 80 }, lean_consensus: '追涨', coverage: { gave: 3, total: 3 } }], chase_ranking: [{ code: '688256', name: '寒武纪', chase_agg: 85 }], ambush_ranking: [{ code: '603823', name: '百合花', ambush_agg: 65 }], probes: [{ code: '603823', name: '百合花', detail: '追涨分分歧 40' }], isolated: [{ code: '603823', name: '百合花', by: ['DeepSeek'] }] } });
ok(st.boards.chase_ranking[0].chase_agg === 85, 'reduce: board→boards');
st = core.reduceProgress(st, { type: 'done', chair: { chase_buys: [{ code: '688256', name: '寒武纪', rank: 1 }], ambush_buys: [], appendix: '宁错过不做错' } });
ok(st.done && !st.active && st.chairReport.appendix === '宁错过不做错', 'reduce: done→闭庭+主席报告');
st = core.reduceProgress(core.initState(), { type: 'error', reason: '房间无委员' });
ok(st.error === '房间无委员' && !st.active, 'reduce: error');

// ── modalHtml（字符串渲染）──
const modal = core.modalHtml('');
ok(modal.includes('data-cm-stocks') && modal.includes('data-cm-rounds') && modal.includes('data-cm-start'), 'modalHtml: 输股票+轮次+开始');
ok(modal.includes('value="4" selected'), 'modalHtml: 默认 4 轮');
ok(modal.includes('全自动') && modal.includes('自动回到自由讨论'), 'modalHtml: 全自动+自动退出说明');

// ── panelHtml（字符串渲染，用上面 done 态 st2）──
const st2 = core.reduceProgress(core.reduceProgress(core.reduceProgress(core.reduceProgress(
  core.initState(),
  { type: 'start', stocks: [{ code: '688256', name: '寒武纪' }, { code: '603823', name: '百合花' }], rounds: 4, chair: 'Claude' }),
  { type: 'act', act: '收敛' }),
  { type: 'board', boards: { rows: [{ code: '688256', name: '寒武纪', faces: { 基本面: 60, 技术面: 88, 消息面: 80 }, lean_consensus: '追涨', coverage: { gave: 2, total: 3, degraded: true } }], chase_ranking: [{ code: '688256', name: '寒武纪', chase_agg: 85 }, { code: '603823', name: '百合花', chase_agg: 35 }], ambush_ranking: [{ code: '603823', name: '百合花', ambush_agg: 65 }], probes: [{ code: '603823', name: '百合花', detail: '追涨分分歧 40' }], isolated: [{ code: '603823', name: '百合花', by: ['DeepSeek', 'Claude'] }] } }),
  { type: 'done', chair: { chase_buys: [{ code: '688256', name: '寒武纪', rank: 1, reason: '最强龙' }], ambush_buys: [{ code: '603823', name: '百合花', rank: 1 }], cross_advice: '先追寒武纪', appendix: '宁错过不做错' } });
const panel = core.panelHtml(st2);
ok(panel.includes('玻璃房投委会') && panel.includes('已闭庭'), 'panelHtml: 标题+闭庭徽章');
ok(panel.includes('寒武纪') && panel.includes('85'), 'panelHtml: 双榜寒武纪 85');
ok(panel.includes('追涨') && panel.includes('低吸'), 'panelHtml: 双榜标题');
ok(panel.includes('矛盾探针') && panel.includes('分歧'), 'panelHtml: 矛盾探针');
ok(panel.includes('风险隔离') && panel.includes('隔离观察'), 'panelHtml: 风险隔离');
ok(panel.includes('换帽子') && panel.includes('三道保险'), 'panelHtml: 主席换帽子+三道保险');
ok(panel.includes('宁错过不做错'), 'panelHtml: 主席附言');
ok(panel.includes('data-cm-panel-close'), 'panelHtml: 关闭按钮');
ok(panel.includes('⚠2/3') || panel.includes('2/3'), 'panelHtml: coverage 降级标注');
// 幕次进度条（收敛幕：前4幕 done，收敛 on）
ok(panel.includes('cm-act') && panel.includes('cm-act on'), 'panelHtml: 幕次进度条 + 当前幕高亮');

// ── XSS escape ──
const xss = core.panelHtml(core.reduceProgress(core.initState(), { type: 'start', stocks: [{ code: 'x', name: '<img src=x onerror=alert(1)>' }], chair: 'C' }));
ok(!xss.includes('<img src=x') && xss.includes('&lt;img'), 'panelHtml: XSS escape 股票名');

// ── 第二轮：act-detail / 五幕 tab / 每幕发言 / 过往投委会 / tooltip ──
let s3 = core.reduceProgress(core.initState(), { type: 'start', stocks: [{ code: '', name: '长川科技' }], rounds: 2, chair: 'Claude' });
s3 = core.reduceProgress(s3, { type: 'act', act: '建库' });
ok(s3.activeTab === '建库', 'reduce: act 设 activeTab 跟随当前幕');
s3 = core.reduceProgress(s3, { type: 'act-detail', act: '建库', speeches: [{ label: 'DeepSeek', text: '技术面 MA20 多头' }, { label: 'Codex', text: '消息面催化' }] });
ok(s3.actsDetail['建库'] && s3.actsDetail['建库'][0].speeches.length === 2, 'reduce: act-detail 存每幕委员发言');
s3 = core.reduceProgress(s3, { type: 'act-detail', act: '辩论', round: 1, sub: '交锋', speeches: [{ label: 'DeepSeek', text: '我改判' }] });
ok(s3.actsDetail['辩论'][0].round === 1 && s3.actsDetail['辩论'][0].sub === '交锋', 'reduce: act-detail 辩论带 round+sub');

const tabs = core.tabBarHtml(s3);
ok(core.ACT_ORDER.every(a => tabs.includes('data-cm-tab="' + a + '"')), 'tabBarHtml: 五幕都可点 (data-cm-tab)');
ok(tabs.includes('cm-act on') && tabs.includes('has'), 'tabBarHtml: 当前幕 on + 有发言幕标记 has');
const det = core.actDetailHtml(Object.assign({}, s3, { activeTab: '建库' }));
ok(det.includes('DeepSeek') && det.includes('技术面 MA20 多头') && det.includes('Codex'), 'actDetailHtml: 渲染该幕每个委员发言原文（点4）');
ok(core.actDetailHtml(Object.assign({}, s3, { activeTab: '辩论' })).includes('第 1 轮'), 'actDetailHtml: 辩论幕显示轮次');
ok(core.actDetailHtml(Object.assign({}, s3, { activeTab: '收敛' })).includes('暂无发言'), 'actDetailHtml: 无发言幕给占位');

const histHtml = core.historyListHtml([{ id: 'm1-2000', stocks: [{ code: '', name: '长川科技' }, { code: '688256', name: '寒武纪' }], chair: 'Claude', rounds: 3, endedAt: 1717000000000, degraded: true }]);
ok(histHtml.includes('data-cm-hist-id="m1-2000"') && histHtml.includes('长川科技') && histHtml.includes('寒武纪'), 'historyListHtml: 列出场次+标的+可点 id');
ok(histHtml.includes('降级'), 'historyListHtml: degraded 标记');
ok(core.historyListHtml([]).includes('还没有跑过'), 'historyListHtml: 空列表占位');

const rs = core.recordToState({ id: 'h1', stocks: [{ code: '', name: '长川科技' }], rounds: 2, chair: 'Claude', acts: [{ act: '点评', speeches: [{ label: 'DeepSeek', text: '78分' }] }, { act: '辩论', round: 1, sub: '交锋', speeches: [{ label: 'Codex', text: 'y' }] }], boards: { rows: [], chase_ranking: [], ambush_ranking: [] }, chairReport: { degraded: false, chase_buys: [], ambush_buys: [] } });
ok(rs.viewingHistoryId === 'h1' && rs.done === true, 'recordToState: 标记历史回看 + done');
ok(rs.actsDetail['点评'][0].speeches[0].text === '78分', 'recordToState: 复原每幕发言原文');
ok(rs.activeTab === '点评', 'recordToState: activeTab 落到首个有发言的幕');
const histPanel = core.panelHtml(rs);
ok(histPanel.includes('历史回看') && histPanel.includes('78分'), 'panelHtml: 历史回看徽章 + 渲染发言');
const listView = core.panelHtml(Object.assign(core.initState(), { view: 'history', historyList: [{ id: 'a', stocks: [{ name: '长川科技' }], chair: 'Claude', rounds: 2 }] }));
ok(listView.includes('过往投委会') && listView.includes('data-cm-hist-id="a"'), 'panelHtml: history 视图渲染历史列表');

// ── 技术初筛：点击后必须有可见进度和最终结果，不再只是 toast ──
let scr = core.initScreenerState({ meetingId: 'm1', runId: 'r1' });
scr = core.reduceScreenerProgress(scr, { type: 'start', stage: '读取快照', percent: 35, message: '读取 kline-screener 最新快照' });
const scrLive = core.panelHtml(scr);
ok(scrLive.includes('技术初筛') && scrLive.includes('初筛进行中') && scrLive.includes('35%'), 'screenerPanelHtml: 进行中进度可见');
scr = core.reduceScreenerProgress(scr, {
  type: 'done',
  percent: 100,
  result: {
    end_date: '20260630',
    generated: '2026-06-30 15:37:18',
    total: 305,
    chase_count: 275,
    setup_count: 30,
    top_chase: [{ code: '300420', name: '五洋自控', mode_cn: '追涨型(主升进行中)', chase_score: 98.5, p_rs: 98, ret5: 0.213, vr: 0.874 }],
    top_setup: [{ code: '603823', name: '百合花', mode_cn: '蓄势型(回调企稳·低吸)', setup_score: 88, p_rs: 80, ret5: 0.02, vr: 1.1 }],
  },
});
const scrDone = core.panelHtml(scr);
ok(scrDone.includes('已生成') && scrDone.includes('2026-06-30') && scrDone.includes('五洋自控') && scrDone.includes('蓄势低吸'), 'screenerPanelHtml: 完成后显示快照日期和双模式榜单');

ok(st2 && core.panelHtml(st2).includes('title=') && core.panelHtml(st2).includes('委员给出结构化评分'), 'panelHtml: 体检 tooltip 解释降级原因（点3b）');
ok(core.panelHtml(s3).includes('data-cm-drag') && core.panelHtml(s3).includes('data-cm-hist-open'), 'panelHtml: 拖动手柄 + 历史入口按钮（点3a）');

// 体检·各委员原始分折叠（排查谁没给分）
const pmHtml = core.boardsHtml({ rows: [{ code: '688256', name: '寒武纪', faces: { 基本面: 60 }, coverage: { gave: 2, total: 3, degraded: true }, per_member: [{ label: 'DeepSeek', gave: true, faces: { 基本面: 60, 技术面: 88, 消息面: 80 }, chase: 85, ambush: 45, lean: '追涨' }, { label: 'Codex', gave: false, faces: {} }] }], chase_ranking: [], ambush_ranking: [] });
ok(pmHtml.includes('<details') && pmHtml.includes('各委员原始分'), 'boardsHtml: 体检含各委员原始分折叠(details)');
ok(pmHtml.includes('DeepSeek') && pmHtml.includes('Codex') && pmHtml.includes('未输出有效打分'), 'boardsHtml: 展开显示每委员分 + 谁没给(Codex 未输出)');

// ── 静态契约：meeting-room 钩子 + index.html 加载 ──
const mrSrc = fs.readFileSync(path.join(root, 'renderer', 'meeting-room.js'), 'utf8');
ok(mrSrc.includes('data-committee-open') && mrSrc.includes("_getDutyHatScene(meeting) === 'research'"), '钩子: 开投委会按钮仅 research scene');
ok(mrSrc.includes('data-committee-screener'), '钩子: 技术初筛按钮（独立入口）');
ok(mrSrc.includes('window.committeeUI.showModal(meeting)'), '钩子: 点击→committeeUI.showModal');
ok(mrSrc.includes('data-committee-history') && mrSrc.includes('window.committeeUI.showHistory'), '钩子: 过往投委会固定按钮 → showHistory');
ok(mrSrc.includes('window.committeeUI.showScreenerHint(meeting)'), '钩子: 技术初筛点击→showScreenerHint(meeting)，不漏传当前 meeting');
const uiSrc = fs.readFileSync(path.join(root, 'renderer', 'committee-ui.js'), 'utf8');
ok(uiSrc.includes("ipcRenderer.invoke('committee:screener:run'") && uiSrc.includes("committee:screener:progress"), 'committee-ui.js: 技术初筛接 IPC 进度流');
ok(uiSrc.includes('showScreenerHint: showScreener'), 'committee-ui.js: 旧按钮调用名兼容到面板实现');
ok(uiSrc.includes("_meetingId ? _activeMeetingId === _meetingId : _view === 'screener'"), 'committee-ui.js: 无 meeting 绑定时技术初筛面板仍可见');
const htmlSrc = fs.readFileSync(path.join(root, 'renderer', 'index.html'), 'utf8');
ok(htmlSrc.includes('committee-ui.js') && htmlSrc.includes('committee-ui.css'), 'index.html: 加载 committee-ui js+css');

console.log('\n' + (fails === 0 ? '=== committee-ui 全绿 ===' : '=== ' + fails + ' FAILED ==='));
process.exit(fails === 0 ? 0 : 1);
