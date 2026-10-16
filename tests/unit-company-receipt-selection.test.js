'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyBridge } = require('../core/company-bridge/company');
const { LiveHistory } = require('../core/hub-assistant/live-history');
const crypto = require('../core/company-bridge/crypto');
const MAIN = '本轮主答复 MARKER_R2：记忆词仍在；已完成第一项，第二项未实测。';
const BACKGROUND = '后台查询已结束，无需补充操作。';

async function rig(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-receipt-'));
  const file = path.join(root, 'native.jsonl');
  const meta = { id: 'company-session', kind: 'codeagent', ccSessionId: 'native-company', transcriptPath: file, status: 'idle' };
  const secret = crypto.newSecret(), gen = 'local-test-generation';
  let now = 1_800_000_000_000, serial = 0, parent = null, live = new LiveHistory();
  const rows = [];
  const append = row => { rows.push(row); fs.appendFileSync(file, JSON.stringify(row) + '\n'); if (row.uuid) parent = row.uuid; return row; };
  const row = (type, content, extras = {}) => append({ type, uuid: 'row-' + (++serial), parentUuid: parent,
    sessionId: meta.ccSessionId, timestamp: new Date(now += 1000).toISOString(),
    message: { role: type, ...(type === 'assistant' ? { id: 'message-' + serial, stop_reason: 'end_turn' } : {}),
      content: type === 'assistant' ? [{ type: 'text', text: content }] : content }, ...extras });
  row('user', '上轮问题'); row('assistant', '上轮答复，不应回传');
  const notices = [], sent = [];
  const company = new CompanyBridge({ dataDir: root, noTimer: true, now: () => now,
    getSession: id => id === meta.id ? meta : null,
    sendPrompt: async (_id, text) => { sent.push(text); row('user', text); return { ok: true }; },
    readFinals: source => live.read({ ...source, kind: 'claude' }).records,
    readReceipt: (source, round) => require('../core/company-bridge/receipt-reader').readCompanyReceipt(source, round),
    onNotify: notice => notices.push(notice), fetchImpl: async () => { throw Error('Network forbidden'); } });
  company.link.saveConfig({ state: 'paired', gen, secret, baseUrl: 'https://fixture.invalid/api' });
  company.link.flush = async () => {};
  t.after(() => { company.store.close(); fs.rmSync(root, { recursive: true, force: true }); });
  const id = 'Q-LOCAL-RECEIPT';
  company.saveThread({ id, gen, title: '本地回执测试', sessionId: meta.id, createdAt: now, everAnswered: true,
    rounds: [{ round: 2, question: '请回答本轮验收问题', receivedAt: now }] });
  await company.dispatch(company.thread(id));
  const read = () => company.thread(id);
  return { company, meta, root, file, rows, append, row, read, sent, notices,
    collect: () => company.collect(read()), cold: () => { live = new LiveHistory(); },
    elapse: ms => { now += ms; },
    background: (text = BACKGROUND, extras = {}) => {
      row('user', '<task-notification>\n<task-id>local-background</task-id>\n<status>completed</status>\n</task-notification>',
        { origin: { kind: 'task-notification' }, promptSource: 'system', ...extras });
      return row('assistant', text, extras);
    },
    replies: () => (company.store.get('outbox') || []).filter(x => x.type === 'reply')
      .map(x => crypto.open(crypto.derive(secret), 'home', x.blob)),
  };
}

for (const mode of ['warm', 'cold', 'busy']) test(`主答复与后台终态同批可见：${mode} 保留两段正文`, async t => {
  const x = await rig(t); x.row('assistant', MAIN);
  if (mode === 'busy') { x.meta.status = 'running'; await x.collect(); assert.equal(x.replies().length, 0); }
  x.background(); if (mode === 'cold') x.cold(); x.meta.status = 'idle';
  await x.collect();
  assert.equal(x.read().rounds[0].reply, MAIN + '\n\n' + BACKGROUND);
  assert.equal(x.replies()[0].text, MAIN + '\n\n' + BACKGROUND);
  assert.equal(x.read().state, 'replied');
  await x.collect(); await x.company.advance(); assert.equal(x.replies().length, 1);
});

test('先收主答复，晚到通知不覆盖且不重复回执', async t => {
  const x = await rig(t); x.row('assistant', MAIN); await x.collect();
  x.background(); await x.collect(); await x.company.advance();
  assert.equal(x.read().rounds[0].reply, MAIN); assert.equal(x.replies().length, 1);
});

test('sidechain 后台答复不串入', async t => {
  const x = await rig(t); x.row('assistant', MAIN); x.background('子会话答复', { isSidechain: true });
  await x.collect(); assert.equal(x.replies()[0].text, MAIN);
});

test('非 end_turn 的后台过程不是回执正文', async t => {
  const x = await rig(t); x.row('assistant', MAIN);
  x.row('assistant', '后台仍在查', { message: { id: 'working', stop_reason: 'tool_use', content: [{ type: 'text', text: '后台仍在查' }] } });
  await x.collect(); assert.equal(x.replies()[0].text, MAIN);
});

test('同一请求的多个主答复片段、工具结果和有效后台补充均保留且去重', async t => {
  const x = await rig(t); const first = x.row('assistant', MAIN);
  x.row('user', [{ type: 'tool_result', tool_use_id: 'tool', content: '工具结果不是新用户请求' }]);
  x.row('assistant', '主答复第二部分。'); x.append(first);
  x.background('后台有效补充：第三项已核实。'); await x.collect();
  assert.equal(x.replies()[0].text, MAIN + '\n\n主答复第二部分。\n\n后台有效补充：第三项已核实。');
});

test('真实用户插话划开边界，不把另一问题的答案串入回执', async t => {
  const x = await rig(t); x.row('assistant', MAIN);
  x.row('user', '这是手动输入的另一问题'); x.row('assistant', '另一问题的答案');
  await x.collect(); assert.equal(x.replies()[0].text, MAIN);
});

test('真实用户只发图片也划开边界，不把图片答案串入回执', async t => {
  const x = await rig(t); x.row('assistant', MAIN);
  x.row('user', [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'fixture-only' } }]);
  x.row('assistant', '图片中是另一个问题'); await x.collect();
  assert.equal(x.replies()[0].text, MAIN);
});

test('插话前本请求没有终态时明确待核对，不回传插话答案', async t => {
  const x = await rig(t); x.row('user', '这是手动输入的另一问题'); x.row('assistant', '另一问题的答案');
  await x.collect(); assert.equal(x.replies().length, 0);
  assert.match(x.read().rounds[0].receiptIssue, /本次请求|归属/);
  assert.ok(x.notices.some(n => /回执.*核对/.test(n.title)));
});

test('下一轮请求不拼回已回执旧轮，迟到旧父链后台答复也排除', async t => {
  const x = await rig(t); const old = x.row('assistant', MAIN); await x.collect();
  x.company.saveThread({ ...x.read(), rounds: [...x.read().rounds, { round: 3, question: '下一轮问题', receivedAt: Date.now() }] });
  await x.company.dispatch(x.read()); const currentUser = x.rows.at(-1);
  x.background('旧轮次的迟到后台答复', { parentUuid: old.uuid });
  x.row('assistant', '第三轮主答复。', { parentUuid: currentUser.uuid }); await x.collect();
  assert.equal(x.replies().length, 2); assert.equal(x.replies()[1].text, '第三轮主答复。');
});

test('rewrite 作为新 dispatch：只回新稿及其后台确认', async t => {
  const x = await rig(t), code = Array.from({ length: 14 }, (_, i) => `x${i} = y${i};`).join('\n');
  x.row('assistant', '旧原稿\n```c\n' + code + '\n```'); x.background();
  await x.collect(); assert.equal(x.read().rounds[0].rewriteAsked, true); assert.equal(x.replies().length, 0);
  const firstDigest = x.read().rounds[0].promptFingerprint;
  await x.company.dispatch(x.read()); assert.match(x.sent.at(-1), /重写/);
  assert.notEqual(x.read().rounds[0].promptFingerprint, firstDigest);
  x.row('assistant', '重写后的完整说明。'); x.background('重写完成后的确认。'); await x.collect();
  assert.equal(x.replies()[0].text, '重写后的完整说明。\n\n重写完成后的确认。');
  assert.doesNotMatch(x.replies()[0].text, /旧原稿|x0/);
});

test('rewrite 未答复及旧稿迟到时继续等待，不能回退旧稿', async t => {
  const x = await rig(t), code = Array.from({ length: 14 }, (_, i) => `x${i} = y${i};`).join('\n');
  const old = x.row('assistant', '旧原稿\n```c\n' + code + '\n```');
  await x.collect(); await x.company.dispatch(x.read()); const rewriteUser = x.rows.at(-1);
  await x.collect(); assert.equal(x.replies().length, 0);
  x.background('旧稿迟到确认，不能作为重写稿。', { parentUuid: old.uuid });
  await x.collect(); assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /本次请求/);
  x.row('assistant', '重写最终正文。', { parentUuid: rewriteUser.uuid }); await x.collect();
  assert.equal(x.replies()[0].text, '重写最终正文。');
});

test('源码过滤在多段合并后执行；重写仍超限时删除源码并保留正文和补充', async t => {
  const x = await rig(t), code = n => Array.from({ length: n }, (_, i) => `x${i} = y${i};`).join('\n');
  x.row('assistant', code(7)); x.row('assistant', code(7));
  await x.collect(); assert.equal(x.read().rounds[0].rewriteAsked, true); assert.equal(x.replies().length, 0);
  await x.company.dispatch(x.read());
  x.row('assistant', '改写稿\n```c\n' + code(14) + '\n```'); x.background('后台补充仍保留。');
  await x.collect(); const reply = x.replies()[0];
  assert.match(reply.text, /改写稿/); assert.match(reply.text, /按规则不回传/);
  assert.match(reply.text, /后台补充仍保留/); assert.doesNotMatch(reply.text, /x10/); assert.ok(reply.meta.codeLinesRemoved > 0);
});

test('规范粘贴外壳和 Hub 附带规则不改变请求指纹归属', async t => {
  const x = await rig(t), user = x.rows.at(-1);
  user.message.content = '<pasted_content id="p1">\n<ai-hub-rules>附带规则</ai-hub-rules>\n\n' + x.sent[0] + '\n</pasted_content id="p1">';
  fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  x.row('assistant', MAIN); x.background(); await x.collect();
  assert.equal(x.replies()[0].text, MAIN + '\n\n' + BACKGROUND);
});

test('损坏记录/基线丢失不静默选最后一条，错误修复后同一轮能恢复', async t => {
  const x = await rig(t); x.row('assistant', MAIN); fs.appendFileSync(x.file, 'not-json\n');
  await x.collect(); assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /记录/);
  fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  x.company.patchRound(x.read(), 2, { baseline: 'missing-baseline' });
  await x.collect(); assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /基线/);
  const { createHash } = require('node:crypto'), old = x.rows[1];
  const baseline = createHash('sha256').update(JSON.stringify([x.meta.ccSessionId, old.message.id, old.message.content[0].text])).digest('hex');
  x.company.patchRound(x.read(), 2, { baseline }); await x.collect();
  assert.equal(x.replies()[0].text, MAIN); assert.equal(x.read().rounds[0].receiptIssue, null);
});

test('历史坏行不毒化完整本轮；下一用户范围内的损坏与半行不影响已划界本轮', async t => {
  const x = await rig(t); fs.writeFileSync(x.file, 'old-broken-json\n' + x.rows.map(JSON.stringify).join('\n') + '\n');
  x.row('assistant', MAIN); x.row('user', '下一个手动问题'); x.row('assistant', '另一个问题的回答');
  fs.appendFileSync(x.file, 'other-broken-json\n{"type":"assistant"');
  await x.collect(); assert.equal(x.replies()[0].text, MAIN);
});

test('本轮末尾 JSONL 半行等待追加完整后再回执，不提前遗漏正文', async t => {
  const x = await rig(t), main = x.row('assistant', MAIN);
  const notification = JSON.stringify({ type: 'user', uuid: 'pending-notification', parentUuid: main.uuid,
    sessionId: x.meta.ccSessionId, origin: { kind: 'task-notification' },
    message: { role: 'user', content: '<task-notification>completed</task-notification>' } });
  const middle = Math.floor(notification.length / 2);
  fs.appendFileSync(x.file, notification.slice(0, middle)); await x.collect();
  assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /末行.*完整/);
  fs.appendFileSync(x.file, notification.slice(middle) + '\n');
  x.row('assistant', BACKGROUND, { parentUuid: 'pending-notification' }); await x.collect();
  assert.equal(x.replies()[0].text, MAIN + '\n\n' + BACKGROUND);
});

test('匹配本次实际请求的 user 是归属根，压缩前 parent 缺失不误拦', async t => {
  const x = await rig(t); x.rows.at(-1).parentUuid = 'compacted-predecessor';
  fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  x.row('assistant', MAIN); await x.collect(); assert.equal(x.replies()[0].text, MAIN);
});

test('assistant 归属不明先保护，修复后恢复；持续损坏沿原超时报错并可重试', async t => {
  const x = await rig(t), user = x.rows.at(-1);
  const answer = x.row('assistant', MAIN, { parentUuid: 'unknown-parent' }); await x.collect();
  assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /归属/);
  answer.parentUuid = user.uuid; fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  fs.appendFileSync(x.file, 'broken-current-json\n'); x.elapse(31 * 60 * 1000); await x.collect();
  assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].error, /损坏/);
  assert.equal(x.read().state, 'failed'); assert.ok(x.notices.some(n => /没答上/.test(n.title)));
  x.company.tick = async () => {}; x.company.retry(x.read().id);
  await x.company.dispatch(x.read()); x.row('assistant', '重试后的完整答复'); await x.collect();
  assert.equal(x.replies()[0].text, '重试后的完整答复');
});

test('旧版在途轮次无指纹时按本题轮次与基线恢复，不能误选相邻轮', async t => {
  const x = await rig(t); x.company.patchRound(x.read(), 2, { promptFingerprint: null });
  x.row('assistant', MAIN); x.background(); await x.collect();
  assert.equal(x.replies()[0].text, MAIN + '\n\n' + BACKGROUND);
});

// 2026-10-16 公司真机 Q-1016-01：CodeAgent 粘贴时读到剪贴板里的图片，提问前多了「[Image #0]」，
// 后面再追加一个「[已分析用户附件图片]」文字块；提问正文一字不差，回执却判成「未能唯一核对」。
// 前两种是第 9 轮从公司原生记录里读到的原样结构（第 4、6 轮提问；第 2 轮的改写请求），后三种是可能的变体。
const FAILED_ANALYSIS = '[已分析用户附件图片]\n[图片视觉分析失败：服务端异常(502)] 图片共 3 张，视觉模型服务暂时不可用。请稍后重试，或用文字描述图片内容。';
const withImage = {
  'R4/R6 实录': text => [{ type: 'text', text: '[Image #0]' + text },
    { type: 'text', text: '[已分析用户附件图片]\n\n\n这是一张软件界面的截图，展示了一个任务详情页。' }],
  'R2 改写请求实录': text => [{ type: 'text', text: '[Image #0][Image #1][Image #2]' + text },
    { type: 'text', text: FAILED_ANALYSIS }, { type: 'text', text: FAILED_ANALYSIS }, { type: 'text', text: FAILED_ANALYSIS }],
  inline: text => [{ type: 'text', text: '[Image #0] ' + text }],
  newline: text => [{ type: 'text', text: '[Image #0]\n' + text }],
  separateBlocks: text => [{ type: 'text', text: '[Image #0]' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA==' } }, { type: 'text', text }],
};
for (const [shape, wrap] of Object.entries(withImage)) test(`提问前被插了剪贴板图片占位符（${shape}）仍按本轮回执送回`, async t => {
  const x = await rig(t), user = x.rows.at(-1);
  user.message.content = wrap(user.message.content);
  fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  x.row('assistant', MAIN); await x.collect();
  assert.equal(x.read().rounds[0].receiptIssue ?? null, null);
  assert.equal(x.replies()[0].text, MAIN);
});

test('去掉占位符后正文仍不同的提问不算本轮', async t => {
  const x = await rig(t), user = x.rows.at(-1);
  user.message.content = [{ type: 'text', text: '[Image #0]' + user.message.content + '（另一个人补了一句）' },
    { type: 'text', text: '[已分析用户附件图片]\n\n\n截图描述' }];
  fs.writeFileSync(x.file, x.rows.map(JSON.stringify).join('\n') + '\n');
  x.row('assistant', MAIN); await x.collect();
  assert.equal(x.replies().length, 0); assert.match(x.read().rounds[0].receiptIssue, /未能唯一核对/);
});
