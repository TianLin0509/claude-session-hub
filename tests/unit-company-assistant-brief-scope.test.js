'use strict';
// 公司助理简报的取数范围（2026-10-18 田哥改）：默认取回看时间（36 小时）内所有单聊和群的全部消息，不限个数和条数；
// 可选限个数和回看时长；不再手动勾关注群，「群里和你相关」按 @ 我、关注词、我参与讨论自动挑。
// 真机形状依据公司回执 Q-1018-04、Q-1018-10：会话列表 --count 默认 10、上限 50，没有时间、免打扰、置顶字段；
// 消息在 chatInfo 里，serverSendTime 毫秒、sender 是账号、at 真假、atAccountList（@所有人 时为空）、长整数 msgId，翻页重叠 1 条。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('../core/company-assistant/welink');
const D = require('../core/company-assistant/data');
const B = require('../core/company-assistant/brief');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const { standinRunner } = require('./helpers/welink-standin-inproc');

const STANDIN = path.join(__dirname, 'fixtures', 'welink-cli-standin.js');

function rig({ pad = 0 } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'company-brief-scope-')), log = path.join(dir, 'calls.log');
  fs.writeFileSync(path.join(dir, 'welink-exchange'), 'user001@example.com');
  const env = { ...process.env, WELINK_STANDIN_PAD: String(pad), WELINK_STANDIN_LOG: log, WELINK_STANDIN_STATE: path.join(dir, 'welink-state') };
  const svc = new CompanyAssistant({ dataDir: dir, noTimer: true, noTools: true, bus: new NoticeBus(),
    welinkRun: standinRunner(env), // 在测试进程里跑假 welink-cli（tests/helpers/welink-standin-inproc.js）
    createSession: async (kind, opts) => ({ id: opts.id }), sendPrompt: async () => ({ ok: true }), getSession: () => null, readFinals: () => [] });
  const calls = () => fs.readFileSync(log, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  return { dir, svc, calls };
}

test('真机消息字段：serverSendTime 当时间、sender 当账号、atAccountList 里有我算 @ 我、@所有人 单独标；17 位编号不丢精度', () => {
  const raw = W.parseJsonBig('{"chatInfo":[{"msgId":89576807345577269,"sender":"u2","content":"@甲 看下","serverSendTime":1792000000000,"at":true,"atAccountList":["me","u3"]},{"msgId":89576807345577270,"sender":"me","content":"好","serverSendTime":1792000060000,"at":false,"atAccountList":[]},{"msgId":89576807345577271,"sender":"u4","content":"@所有人 维护","serverSendTime":1792000120000,"at":true,"atAccountList":[]}],"msgTotalCount":3}');
  const list = D.messages(raw, { id: 'g', name: '群', group: true }, 'me');
  assert.deepEqual(list.map(m => [m.key, m.at, m.account, m.mine, m.atMe, m.atAll]), [
    ['89576807345577269', 1792000000000, 'u2', false, true, false], ['89576807345577270', 1792000060000, 'me', true, false, false], ['89576807345577271', 1792000120000, 'u4', false, false, true]]);
  assert.equal(new Set(list.map(m => m.key)).size, 3, '相邻编号没有被舍入成同一个');
});

test('会话列表：单聊 group_id 是 "0" 也认成单聊，名字取对方姓名', () => {
  const list = D.conversations({ conversation_info: [
    { cross_instance: false, group_id: '0', group_name: '', group_type: 'NORMAL_GROUP', native_name: '同事甲', recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: 'tongshijia 60000000', target_account: 't60000000' },
    { cross_instance: false, group_id: '123', group_name: '项目群', group_type: 'DISCUSS_GROUP', native_name: '', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' },
  ] });
  assert.deepEqual(list.map(c => [c.id, c.group, c.name]), [['t60000000', false, '同事甲'], ['123', true, '项目群']]);
});

test('默认取全部：会话列表带 --count 50；所有单聊和群都取，大群往回翻页取完回看时间内的消息，超出 36 小时的不要；手机专用群不进简报', async () => {
  const r = rig({ pad: 8 }); // 垫 8 个空的旧单聊，部门大群和同事丁排到第 12、13 名：不带 --count 就漏掉
  r.svc.setSettings({ phone: { groupId: 'g-phone', enabled: false } });
  const snap = await r.svc.refresh({ force: true });
  assert.ok(r.calls().some(a => a[1] === 'query-recent-conversation' && a.join(' ').includes('--count 50')), '不带 --count 只给 10 个');
  assert.equal(snap.conversations.length, 13);
  assert.deepEqual(Object.keys(snap.messages).sort(), ['colleague_a', 'colleague_d', 'g-100', 'g-200'], '列表第 10 名以后的会话也取到了；专用群除外');
  assert.equal(snap.messages['g-200'].length, 140, '150 条里最早 10 条在 40 小时前，不要');
  const pages = r.calls().filter(a => a[1] === 'query-history-message' && a.includes('g-200'));
  assert.equal(pages.length, 2, '一页 100 条，往回翻一页');
  assert.deepEqual(pages[1].slice(-4), ['--message-id', '7400000000000000153', '--query-direction', '0'], '用这一页最旧那条（第 51 条）的编号往更旧翻');
  assert.ok(snap.messages['g-200'].some(m => m.atMe), '大群里 @ 我的那条认出来了');
  assert.deepEqual(snap.messages.colleague_a.map(m => m.sender), ['我', '同事甲'], '自己显示「我」，单聊对方的账号换成会话列表里的姓名');
  assert.equal(snap.scope.messages, 140 + 2 + 3 + 1, '翻页重叠的那条只算一次');
  // 第二次刷新只补拉新的：每个会话一次「比缓存最新那条更新」的查询
  const before = r.calls().length;
  const again = await r.svc.refresh({ force: true });
  const inc = r.calls().slice(before).filter(a => a[1] === 'query-history-message');
  assert.equal(inc.length, 12, '每个会话（不含专用群）各查一次');
  const target = a => a[a.indexOf(a.includes('--group-id') ? '--group-id' : '--user-account') + 1];
  const withCache = inc.filter(a => ['colleague_a', 'colleague_d', 'g-100', 'g-200'].includes(target(a)));
  assert.equal(withCache.length, 4);
  assert.ok(withCache.every(a => a.includes('--query-direction') && a[a.indexOf('--query-direction') + 1] === '1'), '取过消息的会话只往更新查');
  assert.equal(again.messages['g-200'].length, 140, '缓存里的消息照样在');
});

test('设置：限个数按会话列表顺序取最近的；回看时间调长后重新取；只认给定的选项', async () => {
  const r = rig();
  r.svc.setSettings({ maxConversations: 2 });
  let snap = await r.svc.refresh({ force: true });
  assert.deepEqual(Object.keys(snap.messages), ['colleague_a', 'g-100'], '只取最近 2 个');
  assert.equal(snap.scope.limited, true);
  assert.equal(r.svc.setSettings({ maxConversations: 500 }).maxConversations, 50, '超过 welink-cli 能列的 50 个按 50 算');
  r.svc.setSettings({ maxConversations: 0, lookbackHours: 24 });
  snap = await r.svc.refresh({ force: true });
  const short = snap.messages['g-200'].length;
  r.svc.setSettings({ lookbackHours: 72 });
  snap = await r.svc.refresh({ force: true });
  assert.ok(snap.messages['g-200'].length > short && snap.messages['g-200'].length === 150, '调到 72 小时，更早的消息重新取回来');
  assert.equal(r.svc.setSettings({ lookbackHours: 999 }).lookbackHours, 72, '只认给定的几个选项');
});

test('简报：「群里和你相关」自动挑 @ 我的群；提问里先列必看的，超出预算的写进文件并说明', async () => {
  const r = rig();
  r.svc.setSettings({ workdays: [0, 1, 2, 3, 4, 5, 6] });
  const snap = await r.svc.refresh({ force: true });
  const s = r.svc.settings(), day = D.dayKey(Date.now());
  const list = B.fallbackBrief(snap, { day, now: Date.now(), settings: s });
  const groups = list.sections.find(x => x.key === 'groups');
  assert.equal(groups.title, '群里和你相关');
  assert.match(groups.items[0].text, /^部门大群：36 小时内 140 条，@你 1 次/);
  assert.ok(list.sections.find(x => x.key === 'awaiting').items.some(i => /周报模板/.test(i.text)), '群里 @ 我、我没回：算等你回复');
  const prompt = B.briefPrompt(snap, { day, now: Date.now(), settings: s });
  assert.match(prompt, /@我/);
  assert.match(prompt, /（@所有人）：@所有人 明天上午系统维护/, '@所有人 的消息也一定在提问里');
  assert.ok(!list.sections.find(x => x.key === 'awaiting').items.some(i => /系统维护/.test(i.text)), '@所有人 不算等你回复');
  assert.ok(prompt.includes('周报模板'), '@ 我的那条一定在提问里');
  // 预算很小时：必看的照样在，其余写进文件
  const big = { ...snap, messages: { ...snap.messages, 'g-300': Array.from({ length: 800 }, (_, i) => ({ sourceId: 'msg:g-300:' + i, conv: 'g-300', convName: '闲聊群', group: true, key: String(i), at: Date.now() - i * 60000, sender: '某人', mine: false, atMe: false, text: '闲聊'.repeat(40) })) } };
  const picked = B.inlineMessages(big, { now: Date.now(), settings: { ...s, day } });
  assert.ok(picked.omitted > 0 && picked.lines.join('\n').length <= B.INLINE_CHARS + 400);
  assert.ok(picked.lines.some(l => l.includes('周报模板')));
  assert.match(B.briefPrompt(big, { day, now: Date.now(), settings: s }), new RegExp(`另有 ${picked.omitted} 条群消息没有列出.*data/brief-input-${day}\\.md`));
  const file = B.briefInputFile(big, { day, now: Date.now(), settings: s });
  assert.equal((file.match(/^\[msg:/gm) || []).length, picked.total, '文件里是全部消息');
  await r.svc.generateBrief({ force: true });
  assert.ok(fs.existsSync(path.join(r.svc.workspace, 'data', `brief-input-${day}.md`)), '生成简报时写进助理工作目录');
});
