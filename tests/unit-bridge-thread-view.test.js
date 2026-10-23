'use strict';
// 通道串（2026-10-16，B 通道串 + E 进度线）：识别、聚合、进度线耗时、列表标签。
// 界面上的聚合（applyBridgeThreads 移动锚点、细线）在隔离 Hub 里真实渲染验证，这里测纯逻辑。
const test = require('node:test');
const assert = require('node:assert/strict');
const view = require('../core/bridge-thread-view');
const bt = require('../renderer/bridge-thread-renderer');

const MIN = 60000;
const T0 = Date.parse('2026-10-16T21:45:00+08:00');
const deps = {
  escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'),
  renderMarkdown: s => `<p>${String(s).replace(/</g, '&lt;')}</p>`,
  formatTime: ts => view.clock(ts),
  avatarSrc: kind => `assets/${kind}.png`,
};

const receipt = (id, round, reply) => [`【公司回执 ${id} · 第 ${round} 轮】`, '', reply, '', '——',
  '以上是公司 CodeAgent 的回执（不含源码）。请核对：可信就据此继续。'].join('\n');
const failedReceipt = (id, round, error) => [`【公司回执 ${id} · 第 ${round} 轮 · 没答上】`, '', error, '', '——',
  '公司那边这一轮没有给出回答。可以用 followup_company 换个问法重问。'].join('\n');
const followupRequest = (id, round, q) => [`## 成员追问（编号 ${id}，第 ${round} 轮）`, '', q, '',
  '（规则同前：保持公司电脑原样、不回传源码和凭据、末尾写把握程度和没读到的部分。）'].join('\n');
const firstRequest = (id, q) => ['说明……', '', '代码位置：', 'D:/code', '', `## 成员请求（编号 ${id}）`, '', q].join('\n');

// 卡片替身：collectRows 只读 template.bt-src 的 dataset 与正文。
function fakeCard(text, ts) {
  const html = bt.renderBridgeCard({ id: 'u' + ts, role: 'user', text, ts }, deps);
  const m = html.match(/<template class="bt-src" data-round="(\d+)" data-who="(\w+)" data-failed="(\d)" data-time="([^"]*)" data-ts="\d+" data-agent="([^"]*)" data-from-title="([^"]*)">([\s\S]*?)<\/template>/);
  const unesc = s => s.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  const t = { dataset: { round: m[1], who: m[2], failed: m[3], time: m[4], agent: m[5], fromTitle: m[6] }, content: { textContent: unesc(m[7]) } };
  return { html, querySelector: sel => sel === 'template.bt-src' ? t : null };
}

test('识别：四种通道消息认得出，普通消息不误认', () => {
  assert.deepEqual(bt.describeMessage(receipt('Q-1016-05', 2, '📌 结论')).role, 'asker');
  assert.equal(bt.describeMessage(receipt('Q-1016-05', 2, 'x')).peer, 'company');
  assert.equal(bt.describeMessage(failedReceipt('Q-1016-05', 2, '没送进')).failed, true);
  const req = bt.describeMessage(followupRequest('Q-1016-05', 2, '再核对 10 处'));
  assert.deepEqual([req.role, req.peer, req.who, req.round], ['answerer', 'home', 'peer', 2]);
  assert.equal(bt.describeMessage(firstRequest('Q-1016-05', '要文件地图')).round, 1);
  const help = bt.describeMessage(['## 公司 CodeAgent 的求助（编号 H-1016-03）· 来自公司会话「AMC 摸底」', '', '帮看看'].join('\n'));
  assert.deepEqual([help.role, help.peer, help.fromTitle], ['answerer', 'company', 'AMC 摸底']);
  const homeReply = bt.describeMessage(['【家里回复 H-1016-03 · 第 1 轮 · Codex】', '', '建议……'].join('\n'));
  assert.deepEqual([homeReply.role, homeReply.peer, homeReply.agent], ['asker', 'home', 'codex']);
  const rewrite = bt.describeMessage('（编号 Q-1016-05，第 2 轮）你上一条回答里有成段的源码。按规则不能回传源码');
  assert.equal(rewrite.who, 'hub');
  for (const plain of ['帮我看看【公司回执 Q-1016-05 · 第 1 轮】这条', '## 成员请求 编号不对', '普通问题', '', '公司回执 Q-1016-05']) {
    assert.equal(bt.describeMessage(plain), null, plain);
    assert.equal(bt.renderBridgeCard({ id: 'x', role: 'user', text: plain }, deps), null);
  }
  assert.equal(bt.renderBridgeCard({ id: 'x', role: 'assistant', text: receipt('Q-1016-05', 1, 'x') }, deps), null);
});

test('识别：粘贴外壳与图片占位剥掉后仍认得出，正文去掉标题行和结尾说明', () => {
  const wrapped = '[Image #1]' + followupRequest('Q-1016-05', 3, '第三问');
  assert.equal(bt.describeMessage(wrapped).round, 3);
  assert.equal(bt.messageBody(wrapped, 'channel-request'), '第三问');
  assert.equal(bt.messageBody(receipt('Q-1016-05', 1, '📌 文件地图\n1. 入口'), 'company-receipt'), '📌 文件地图\n1. 入口');
  assert.equal(bt.messageBody(firstRequest('Q-1016-05', '要地图'), 'channel-request'), '要地图');
});

const record = (rounds, extra = {}) => ({ id: 'Q-1016-05', sessionId: 'home-1', bridgeRole: 'asker', bridgePeer: 'company', rounds, ...extra });

test('聚合：多轮按轮次排，提问取自线程记录，回答取自回执卡', () => {
  const rec = record([
    { round: 1, question: '要 AirView 文件地图', sentAt: T0 - 30 * MIN, replyAt: T0 - 15 * MIN, reply: '📌 关键文件 12 个' },
    { round: 2, question: '再核对 10 处', sentAt: T0, ackAt: T0 + 8000, startedAt: T0 + 68000, replyAt: T0 + 12 * MIN, reply: '📌 10 条都有证据', meta: { model: 'GLM-5.2-WX-Auto' } },
  ]);
  const cards = [fakeCard(receipt('Q-1016-05', 1, '📌 关键文件 12 个\n全文一'), T0 - 15 * MIN), fakeCard(receipt('Q-1016-05', 2, '📌 10 条都有证据\n全文二'), T0 + 12 * MIN)];
  const rows = bt.collectRows(cards, { role: 'asker', peer: 'company', record: rec });
  assert.deepEqual(rows.map(r => `${r.round}${r.who}`), ['1self', '1peer', '2self', '2peer']);
  assert.equal(rows[1].body, '📌 关键文件 12 个\n全文一', '同一轮以送进会话的卡片正文为准');
  const html = bt.threadBlock(deps, { threadId: 'Q-1016-05', role: 'asker', peer: 'company', record: rec, agent: '' }, rows, T0 + 13 * MIN);
  assert.match(html, /Q-1016-05 · 公司 CodeAgent/);
  assert.match(html, /已回执/);
  assert.match(html, /2 轮/);
  assert.match(html, /全程 12 分/);
  assert.match(html, /GLM-5\.2-WX-Auto/);
  assert.match(html, /bt-headline">📌 10 条都有证据/);
  assert.match(html, /发出 21:45.*公司收到 \+8 秒.*排队 1 分.*处理 11 分.*回执 21:57/s);
  assert.match(html, /data-bridge-action="followup"/);
  assert.match(html, /data-bridge-action="recollect"/);
  assert.doesNotMatch(html, /data-bridge-action="reask"/, '答上了不给重问');
  assert.match(html, /<details class="bridge-thread[^"]*"[^>]* data-thread/, '默认收起（没有 open）');
  assert.doesNotMatch(html, /<details class="bridge-thread[^>]* open/);
});

test('聚合：乱序到达（第 2 轮的卡排在第 1 轮前）仍按轮次排', () => {
  const cards = [fakeCard(receipt('Q-1016-07', 2, '二'), T0), fakeCard(receipt('Q-1016-07', 1, '一'), T0 + MIN)];
  const rows = bt.collectRows(cards, { role: 'asker', peer: 'company', record: null });
  assert.deepEqual(rows.map(r => r.body), ['一', '二']);
});

test('聚合：失败轮标红并给补收、重问；补收后的回执盖过错误，失败卡不盖成功', () => {
  const failRec = record([
    { round: 1, question: '一', sentAt: T0 - 60 * MIN, reply: '📌 一答', replyAt: T0 - 50 * MIN },
    { round: 2, question: '二', sentAt: T0, ackAt: T0 + 4000, error: '提问没能送进公司的 CodeAgent（重发一次后它的记录里仍没有这条提问）', errorAt: T0 + 9 * MIN },
  ]);
  const failCard = fakeCard(failedReceipt('Q-1016-05', 2, '提问没能送进公司的 CodeAgent'), T0 + 9 * MIN);
  let rows = bt.collectRows([failCard], { role: 'asker', peer: 'company', record: failRec });
  const failRow = rows.find(r => r.round === 2 && r.who === 'peer');
  assert.equal(failRow.failed, true);
  const html = bt.threadBlock(deps, { threadId: 'Q-1016-05', role: 'asker', peer: 'company', record: failRec }, rows, T0 + 10 * MIN);
  assert.match(html, /st-failed/);
  assert.match(html, /bt-round party-company fail/);
  assert.match(html, /data-bridge-action="recollect"/);
  assert.match(html, /data-bridge-action="reask"/);
  assert.match(html, /bt-step failed">提问没能送进公司的 CodeAgent/);
  // 补收：同一轮又来一张成功回执，记录里也有了 reply
  const okRec = record([failRec.rounds[0], { ...failRec.rounds[1], error: null, reply: '📌 补收到的回答', replyAt: T0 + 30 * MIN }]);
  rows = bt.collectRows([failCard, fakeCard(receipt('Q-1016-05', 2, '📌 补收到的回答'), T0 + 30 * MIN)], { role: 'asker', peer: 'company', record: okRec });
  const fixed = rows.filter(r => r.round === 2 && r.who === 'peer');
  assert.equal(fixed.length, 1);
  assert.equal(fixed[0].failed, false);
  assert.equal(fixed[0].body, '📌 补收到的回答');
  // 反过来：记录里已有成功回答，迟到的失败卡不盖它
  rows = bt.collectRows([failCard], { role: 'asker', peer: 'company', record: okRec });
  assert.equal(rows.find(r => r.round === 2 && r.who === 'peer').failed, false);
});

test('进度线：排队、处理中每段耗时；字段缺失时只显示能算的段', () => {
  const queued = view.roundSteps({ round: 2, sentAt: T0, ackAt: T0 + 6000, status: 'received', note: '排队第 1 个 · 受闲时上限 · 预计 6 分后开工' }, T0 + 2 * MIN);
  assert.deepEqual(queued.map(s => s.label), ['发出 21:45', '公司收到 +6 秒', '排队第 1 个 · 受闲时上限 · 预计 6 分后开工', '处理', '回执']);
  assert.deepEqual(queued.map(s => s.state), ['done', 'done', 'current', 'pending', 'pending']);
  const queuedPlain = view.roundSteps({ round: 2, sentAt: T0, ackAt: T0 + 6000, status: 'received' }, T0 + 3 * MIN);
  assert.equal(queuedPlain[2].label, '排队中 · 已 3 分');
  const running = view.roundSteps({ round: 2, sentAt: T0, ackAt: T0 + 6000, startedAt: T0 + 2 * MIN, status: 'running' }, T0 + 9 * MIN);
  assert.deepEqual(running.map(s => s.label), ['发出 21:45', '公司收到 +6 秒', '排队 2 分', '处理中 · 已 7 分', '回执']);
  const sentOnly = view.roundSteps({ round: 1, sentAt: T0 }, T0 + MIN);
  assert.deepEqual(sentOnly.map(s => s.state), ['done', 'current', 'pending', 'pending', 'pending']);
  const oldRecord = view.roundSteps({ round: 1, sentAt: T0, reply: 'x', replyAt: T0 + 5 * MIN, meta: { elapsedSec: 240 } }, T0 + 6 * MIN);
  assert.deepEqual(oldRecord.map(s => s.label), ['发出 21:45', '公司收到', '排队', '处理 4 分', '回执 21:50'], '没记 ackAt/startedAt 的旧记录：处理时长用回执自带的用时，其余不硬算');
  assert.equal(view.fmtDur(8000), '8 秒');
  assert.equal(view.fmtDur(12 * MIN), '12 分');
  assert.equal(view.fmtDur(75 * MIN), '1 小时 15 分');
});

test('排队/处理中：块里有等待占位，块头状态跟着记录', () => {
  const rec = record([{ round: 1, question: '一', sentAt: T0, ackAt: T0 + 6000, startedAt: T0 + MIN, status: 'running' }]);
  const rows = bt.collectRows([], { role: 'asker', peer: 'company', record: rec });
  const html = bt.threadBlock(deps, { threadId: 'Q-1016-05', role: 'asker', peer: 'company', record: rec }, rows, T0 + 8 * MIN);
  assert.match(html, /st-running/);
  assert.match(html, /处理中 · 已 7 分/);
  assert.match(html, /bt-wait/);
  assert.doesNotMatch(html, /bt-headline/);
});

test('公司会话：家里提问收进通道串，署名家里 Claude，块头写特战任务（2026-10-17 田哥：公司侧不再写「家里」）', () => {
  const rec = { id: 'Q-1016-05', sessionId: 'co-1', bridgeRole: 'answerer', bridgePeer: 'home', from: { title: 'SuperRAN · AirView OLLA 核对', kind: 'claude' },
    rounds: [{ round: 1, question: '要地图', receivedAt: T0 - 40 * MIN, sentAt: T0 - 39 * MIN, reply: '📌 关键文件 12 个', replyAt: T0 - 25 * MIN },
      { round: 2, question: '再核对', receivedAt: T0, sentAt: T0 + MIN, reply: '📌 10 条都有证据', replyAt: T0 + 12 * MIN, meta: { model: 'GLM-5.2-WX-Auto' } }] };
  const cards = [fakeCard(firstRequest('Q-1016-05', '要地图'), T0 - 40 * MIN), fakeCard(followupRequest('Q-1016-05', 2, '再核对'), T0)];
  const rows = bt.collectRows(cards, { role: 'answerer', peer: 'home', record: rec });
  assert.deepEqual(rows.map(r => `${r.round}${r.who}`), ['1peer', '1self', '2peer', '2self']);
  const html = bt.threadBlock(deps, { threadId: 'Q-1016-05', role: 'answerer', peer: 'home', record: rec, agent: 'claude' }, rows, T0 + 13 * MIN);
  assert.match(html, /特战任务 · Q-1016-05 · 家里 Claude/);
  assert.match(html, /bt-round party-home[^>]*><summary><span class="bt-av"><img src="assets\/claude\.png"/);
  assert.match(html, /<b class="bt-name">家里问<\/b>/);
  assert.match(html, /<b class="bt-name">公司答<\/b>/);
  assert.match(html, /全程 12 分/);
  assert.doesNotMatch(html, /data-bridge-action/, '答方不给追问/补收');
});

test('线程记录合并与列表标签', () => {
  const now = T0 + 9 * MIN;
  const homeStatus = { ok: true, role: 'home',
    threads: [
      { id: 'Q-1016-05', sessionId: 'h1', rounds: [{ round: 1, question: 'a', sentAt: T0 - 20 * MIN, reply: '📌 OLLA 在最终 MCS 选择前叠加', replyAt: T0 - 8 * MIN }, { round: 2, question: 'b', sentAt: T0, replyAt: T0 + 12 * MIN, reply: '📌 第二轮结论' }] },
      { id: 'Q-1016-17', sessionId: 'h2', rounds: [{ round: 1, question: 'a', sentAt: T0, ackAt: T0 + 5000, startedAt: T0 + 2 * MIN, status: 'running' }] },
      { id: 'Q-1016-19', sessionId: 'h3', rounds: [{ round: 1, question: 'a', sentAt: T0, ackAt: T0 + 5000, status: 'received', note: '排队第 1 个 · 受闲时上限' }] },
    ],
    consults: [{ id: 'H-1016-03', sessionId: 'h4', agent: 'claude', rounds: [{ round: 1, question: 'q', receivedAt: T0, sentAt: T0 + MIN }] }] };
  const recs = bt.recordsFromStatus(homeStatus);
  assert.deepEqual(Object.keys(recs).sort(), ['H-1016-03', 'Q-1016-05', 'Q-1016-17', 'Q-1016-19']);
  assert.equal(recs['H-1016-03'].bridgeRole, 'answerer');
  const done = bt.sessionBadge('h1', recs, now);
  assert.equal(done.chip, '⇄ 2 轮');
  assert.equal(done.sub, 'Q-1016-05 · 第 2 轮已回执 · 12 分');
  assert.equal(done.pin, '📌 第二轮结论');
  const running = bt.sessionBadge('h2', recs, now);
  assert.equal(running.chip, '⇄ 处理中 · 7 分');
  assert.match(running.sub, /Q-1016-17 · 第 1 轮 · 处理中 · 已 7 分/);
  const queued = bt.sessionBadge('h3', recs, now);
  assert.equal(queued.state, 'queued');
  assert.match(queued.sub, /排队第 1 个 · 受闲时上限/);
  const answer = bt.sessionBadge('h4', recs, now);
  assert.equal(answer.chip, '⇄ 公司');
  assert.match(answer.sub, /为公司办事 · H-1016-03 · 处理中 · 已 8 分/);
  assert.equal(bt.sessionBadge('nobody', recs, now), null);
  const companyRecs = bt.recordsFromStatus({ ok: true, role: 'company', threads: [{ id: 'Q-1016-05', sessionId: 'c1', from: { title: 'x' }, rounds: [{ round: 2, receivedAt: T0, reply: 'r', replyAt: T0 + MIN }] }, { id: 'Q-1016-01#123', rounds: [] }], askHome: [] });
  assert.deepEqual(Object.keys(companyRecs), ['Q-1016-05'], '存档的旧编号（带 #）不进');
  assert.doesNotMatch(bt.sessionBadge('c1', companyRecs, now).chip, /家里/);
  assert.match(bt.sessionBadge('c1', companyRecs, now).sub, /^特战任务 · /);
  assert.deepEqual(bt.recordsFromStatus({ ok: true, role: 'company', unlocked: false }), {});
  assert.deepEqual(bt.recordsFromStatus({ ok: false, error: 'x' }), {});
});

test('追问/重问填进输入框的文字', () => {
  assert.equal(bt.composerText('followup', 'Q-1016-05', 'asker', 'company'), '用 followup_company 就编号 Q-1016-05 追问公司：');
  assert.equal(bt.composerText('reask', 'H-1016-03', 'asker', 'home', '原问题'), '用 followup_home 就编号 H-1016-03 换个问法重问上一轮：\n原问题');
});

test('标题、正文里的尖括号被转义', () => {
  const html = bt.renderBridgeCard({ id: 'u1', role: 'user', text: receipt('Q-1016-05', 1, '<script>x</script>'), ts: T0 }, deps);
  assert.doesNotMatch(html, /<script>/);
});
