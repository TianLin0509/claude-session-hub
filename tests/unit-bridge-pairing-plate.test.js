'use strict';
// 配对号牌与回执首行（2026-10-20）：号牌格式、模型显示名、换号重做后缀、老版本家里的旧名；
// 回执首行新旧两种写法、Codex 丢掉「·」的写法都认得；去重按编号 + 轮次归一化比对；引用会话起名（续）（续2）。
// 两侧共用的纯函数，公司版导出也带这份测试。
const test = require('node:test');
const assert = require('node:assert/strict');
const plate = require('../core/company-bridge/pairing-plate');
const { bridgeMessageKind, receiptHeadInfo } = require('../core/bridge-message-kind');
const guard = require('../core/company-bridge/delivery-guard');
const { continuationTitle, parseReferenceLines, buildReferenceText } = require('../core/session-reference');
const bt = require('../renderer/bridge-thread-renderer');

test('号牌：Q21 · 家「会话名前 10 字 #短码」· 模型；短码取会话编号前 4 位字母数字', () => {
  assert.equal(plate.shortCode('8F3A-91c2-xxxx'), '8f3a');
  assert.equal(plate.shortCode(''), '');
  assert.equal(plate.threadShort('Q-1020-21'), 'Q21');
  assert.equal(plate.threadShort('Q-1020-07'), 'Q7');
  assert.equal(plate.homeLabel({ title: '无线调度 PF 遗忘因子核对与验证', code: '8f3a' }), '无线调度 PF 遗忘 #8f3a');
  assert.equal(plate.homeLabel({ title: '名字里有「括号」\n和换行', code: 'ab12' }), '名字里有括号 和换行 #ab12', '号牌里的「」和换行去掉');
  assert.equal(plate.homeLabel({ title: '', code: 'ab12' }), '未命名 #ab12');
  const t = { id: 'Q-1020-21', from: { title: '无线调度 PF 遗忘因子', kind: 'deepseek-claude', code: '8f3a', model: 'DeepSeek' } };
  assert.equal(plate.companySessionTitle(t), 'Q21 · 家「无线调度 PF 遗忘 #8f3a」· DeepSeek');
  assert.equal(plate.isPlateTitle(plate.companySessionTitle(t)), true);
  // 家里没报模型名：按会话种类推
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-02', from: { title: 'x', kind: 'codex', code: 'ab12' } }), 'Q2 · 家「x #ab12」· Codex');
});

test('模型显示名：先看模型编号（第三方模型跑在 Claude Code / Codex CLI 里），再看种类', () => {
  assert.equal(plate.modelLabel('deepseek-claude', 'deepseek-v4-pro'), 'DeepSeek');
  assert.equal(plate.modelLabel('claude', 'glm-5.1'), 'GLM', '跑在 Claude Code 上的 GLM 不写成 Claude');
  assert.equal(plate.modelLabel('codeagent', 'GLM-5.2-WX-Auto'), 'GLM');
  assert.equal(plate.modelLabel('codex', 'gpt-5.5'), 'Codex');
  assert.equal(plate.modelLabel('codex-resume'), 'Codex');
  assert.equal(plate.modelLabel('claude', 'claude-opus-5-5'), 'Claude');
  assert.equal(plate.modelLabel('deepseek'), 'DeepSeek');
  assert.equal(plate.modelLabel('kimi'), 'Kimi');
  assert.equal(plate.modelLabel('glm'), 'GLM');
  assert.equal(plate.modelLabel('qwen'), 'Qwen');
  assert.equal(plate.modelLabel('gemini'), 'Gemini');
  assert.equal(plate.modelLabel('codeagent'), 'CodeAgent');
  assert.equal(plate.modelLabel('', ''), '');
});

test('换号重做：新会话名加「· 重做 N」；老版本家里没带短码时仍是 MMDD-Qn-家里AI', () => {
  const from = { title: '会话甲', kind: 'codex', code: 'ab12', model: 'Codex' };
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from, redoCount: 1 }), 'Q21 · 家「会话甲 #ab12」· Codex · 重做 2');
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from, redoCount: 2 }), 'Q21 · 家「会话甲 #ab12」· Codex · 重做 3');
  // 没有 redoCount 的旧记录：按 prevSessions 个数推
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from, prevSessions: [{}] }), 'Q21 · 家「会话甲 #ab12」· Codex · 重做 2');
  // 老家里：from 里只有 title / kind
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from: { title: '会话甲', kind: 'codex' } }), '1020-Q21-codex');
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from: { title: '会话甲', kind: 'claude' }, redoCount: 1 }), '1020-Q21-claude · 重做 2');
  assert.equal(plate.companySessionTitle({ id: 'Q-1020-21', from: { kind: 'deepseek-claude' } }), '1020-Q21-deepseek');
  assert.equal(plate.companySessionTitle({ id: 'T-x', title: '团队任务' }), '特战 · 团队任务');
  for (const name of ['1020-Q21-codex', '1020-Q21-codex · 重做 2', 'Q21 · 家「会话甲 #ab12」· Codex · 重做 2']) assert.equal(plate.isPlateTitle(name), true, name);
  assert.equal(plate.isPlateTitle('Codex 1'), false);
});

test('界面上的几句：家里 会话名 #短码 · 模型；本会话由 号 · 模型 作答；→ 公司 号 · 模型 · 会话 号牌', () => {
  assert.equal(plate.homePairText({ title: '会话甲', code: 'ab12', model: 'GLM' }), '家里 会话甲 #ab12 · GLM');
  assert.equal(plate.homePairText({ title: '会话甲', kind: 'codex' }), '', '老家里没短码：返回空串，界面退回旧写法');
  assert.equal(plate.answeredByText({ pairing: { accountAlias: '号 1', model: 'GLM-5.2' } }), '本会话由 号 1 · GLM-5.2 作答');
  assert.equal(plate.answeredByText({ rounds: [{ meta: { accountAlias: '号 2', actualModel: 'GLM-5' } }] }), '本会话由 号 2 · GLM-5 作答');
  assert.equal(plate.answeredByText({ rounds: [{}] }), '');
  const t = { id: 'Q-1020-21', plate: 'Q21 · 家「会话甲 #ab12」· Codex', rounds: [{ meta: { accountAlias: '号 1', model: 'GLM-5.2' } }] };
  assert.equal(plate.companyPairText(t), '→ 公司 号 1 · GLM-5.2 · 会话 Q21 · 家「会话甲 #ab12」· Codex', '老公司不回传会话名：用家里推算的');
  assert.equal(plate.companyPairText({ ...t, company: { sessionTitle: 'Q21 · 家「会话甲 #ab12」· Codex · 重做 2', accountAlias: '号 3', model: 'GLM-5' } }),
    '→ 公司 号 3 · GLM-5 · 会话 Q21 · 家「会话甲 #ab12」· Codex · 重做 2', '公司回传的优先');
  assert.equal(plate.companyPairText({ ...t, company: { accountAlias: '号 3' } }, { withPlate: false }), '→ 公司 号 3 · GLM-5.2');
});

test('回执首行：新格式带题目；旧格式、Codex 丢掉「·」的格式都认得', () => {
  const forms = [
    ['【公司回执 Q-1020-21 · 第 1 轮 · 题：PF 遗忘因子怎么取】\n\n正文', { kind: 'company-receipt', thread: 'Q-1020-21', round: 1, failed: false, topic: 'PF 遗忘因子怎么取' }],
    ['【公司回执 Q-1020-21 · 第 2 轮】\n\n正文', { kind: 'company-receipt', thread: 'Q-1020-21', round: 2, failed: false }],
    ['【公司回执 Q-1020-21  第 1 轮  题：PF 遗忘因子】\n\n正文', { kind: 'company-receipt', thread: 'Q-1020-21', round: 1, failed: false, topic: 'PF 遗忘因子' }],
    ['【公司回执 Q-1020-21  第 3 轮  没答上】\n\n原因', { kind: 'company-receipt', thread: 'Q-1020-21', round: 3, failed: true }],
    ['【公司回执 Q-1020-21 · 第 3 轮 · 没答上 · 题：遗忘因子】\n\n原因', { kind: 'company-receipt', thread: 'Q-1020-21', round: 3, failed: true, topic: '遗忘因子' }],
    ['【公司回执 Q-1020-21・第 1 轮】\n\n正文', { kind: 'company-receipt', thread: 'Q-1020-21', round: 1, failed: false }],
  ];
  for (const [text, want] of forms) {
    const info = receiptHeadInfo(text);
    for (const [k, v] of Object.entries(want)) assert.equal(info[k], v, `${k} @ ${text.split('\n')[0]}`);
    // bridgeMessageKind 的返回形状不变（老调用方 deepEqual 用）
    assert.deepEqual(bridgeMessageKind(text), { kind: 'company-receipt', thread: want.thread, round: want.round });
  }
  assert.equal(receiptHeadInfo('普通消息'), null);
  assert.deepEqual(receiptHeadInfo('【家里回复 H-1020-03  第 2 轮  Codex】\n\n答'), { kind: 'home-reply', thread: 'H-1020-03', round: 2, failed: false, tag: 'Codex' });
  // 卡片：题目和失败标记从首行认出来，正文去掉首行
  const d = bt.describeMessage('【公司回执 Q-1020-21  第 3 轮  没答上】\n\n公司那边超时');
  assert.equal(d.failed, true);
  assert.equal(d.thread, 'Q-1020-21');
});

test('去重：按编号 + 轮次归一化比对，新旧格式、丢点、吞掉开头的都算同一份回执', () => {
  const marker = '【公司回执 Q-1019-33 · 第 1 轮 · 题：遗忘因子】';
  const key = guard.receiptKey(marker);
  assert.deepEqual(key, { kind: '公司回执', id: 'Q-1019-33', round: 1, failed: false });
  for (const line of [
    '【公司回执 Q-1019-33 · 第 1 轮 · 题：遗忘因子】',
    '【公司回执 Q-1019-33 · 第 1 轮】',
    '【公司回执 Q-1019-33  第 1 轮  题：遗忘因子】',
    '"019-33  第 1 轮  题：遗忘因子】', // 实际样本：粘贴时开头被吞
  ]) assert.equal(guard.lineHasReceipt(guard.normalizeReceipt(line), key), true, line);
  for (const line of [
    '【公司回执 Q-1019-33 · 第 2 轮】',
    '【公司回执 Q-1019-34 · 第 1 轮】',
    '【公司回执 Q-1019-33 · 第 1 轮 · 没答上】',
    '"第 1 轮】', // 太短，认不出是哪个编号
  ]) assert.equal(guard.lineHasReceipt(guard.normalizeReceipt(line), key), false, line);
  const failedKey = guard.receiptKey('【公司回执 Q-1019-33 · 第 1 轮 · 没答上 · 题：遗忘因子】');
  assert.equal(failedKey.failed, true);
  assert.equal(guard.lineHasReceipt(guard.normalizeReceipt('【公司回执 Q-1019-33  第 1 轮  没答上】'), failedKey), true);
  assert.equal(guard.lineHasReceipt(guard.normalizeReceipt('【公司回执 Q-1019-33 · 第 1 轮】'), failedKey), false, '成功和失败不混');
});

test('引用会话：认出引用行；新会话标题加（续），已是（续）的递增，撞名再往上加', () => {
  const text = buildReferenceText({ title: '调度核对', kind: 'codex', path: 'D:/hub/transcripts/a.md' }) + '\n\n接着做';
  const refs = parseReferenceLines(text);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].type, 'session');
  assert.equal(refs[0].name, '调度核对');
  assert.equal(refs[0].path, 'D:/hub/transcripts/a.md');
  assert.equal(refs[0].leading, true);
  assert.equal(parseReferenceLines('先说一句\n' + text)[0].leading, false);
  assert.deepEqual(parseReferenceLines('没有引用'), []);
  assert.equal(continuationTitle('调度核对'), '调度核对（续）');
  assert.equal(continuationTitle('调度核对（续）'), '调度核对（续2）');
  assert.equal(continuationTitle('调度核对（续2）'), '调度核对（续3）');
  assert.equal(continuationTitle('调度核对', ['调度核对（续）']), '调度核对（续2）');
  assert.equal(continuationTitle('调度核对（续）', ['调度核对（续2）', '调度核对（续3）']), '调度核对（续4）');
  assert.equal(continuationTitle(''), '未命名会话（续）');
});

test('家里 ⇄ 标签：写出对接的公司号、模型和公司会话；多个在途全列出', () => {
  const T0 = 1_800_000_000_000;
  const recs = bt.recordsFromStatus({ ok: true, role: 'home', threads: [
    { id: 'Q-1020-21', sessionId: 'h1', plate: 'Q21 · 家「会话甲 #h1」· Codex', company: { sessionTitle: 'Q21 · 家「会话甲 #h1」· Codex', accountAlias: '号 1', model: 'GLM-5.2' },
      rounds: [{ round: 1, question: 'a', sentAt: T0, ackAt: T0 + 1000, startedAt: T0 + 2000, status: 'running' }] },
    { id: 'Q-1020-22', sessionId: 'h1', plate: 'Q22 · 家「会话甲 #h1」· Codex',
      rounds: [{ round: 1, question: 'b', sentAt: T0 + 5000, ackAt: T0 + 6000, status: 'received' }] },
    { id: 'Q-1020-23', sessionId: 'h2', plate: 'Q23 · 家「会话乙 #h2」· Codex', company: { accountAlias: '号 2', model: 'GLM-5' },
      rounds: [{ round: 1, question: 'c', sentAt: T0, reply: '📌 好了', replyAt: T0 + 60000 }] },
  ] });
  const one = bt.sessionBadge('h2', recs, T0 + 120000);
  assert.equal(one.peer, '→ 公司 号 2 · GLM-5 · 会话 Q23 · 家「会话乙 #h2」· Codex');
  assert.equal(one.chip, '⇄ 1 轮', '标签本身不变');
  const many = bt.sessionBadge('h1', recs, T0 + 120000);
  assert.match(many.peer, /^→ 公司 2 个在途：/);
  assert.match(many.peer, /Q21 号 1 · GLM-5\.2/);
  assert.match(many.peer, /Q22 排队中/);
  assert.equal(many.lines.length, 2);
  assert.match(many.lines.join('\n'), /Q-1020-22 → 公司 会话 Q22 · 家「会话甲 #h1」· Codex/);
  // 公司一端：家里会话 + 作答的号和模型；老家里没短码不加
  const companyRecs = bt.recordsFromStatus({ ok: true, role: 'company', askHome: [], threads: [
    { id: 'Q-1020-21', sessionId: 'c1', from: { title: '会话甲', code: 'h1', model: 'DeepSeek' }, pairing: { accountAlias: '号 1', model: 'GLM-5.2' }, rounds: [{ round: 1, receivedAt: T0 }] },
    { id: 'Q-1020-22', sessionId: 'c2', from: { title: '会话甲', kind: 'codex' }, rounds: [{ round: 1, receivedAt: T0 }] },
  ] });
  assert.equal(bt.sessionBadge('c1', companyRecs, T0 + 1000).peer, '家里 会话甲 #h1 · DeepSeek · 本会话由 号 1 · GLM-5.2 作答');
  assert.equal(bt.sessionBadge('c2', companyRecs, T0 + 1000).peer, undefined);
});
