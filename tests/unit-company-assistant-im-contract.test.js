'use strict';
// Q-1021-08 第1轮：现场成功码/包络的合成回归，内容不含公司消息或账号。
const test = require('node:test');
const assert = require('node:assert/strict');
const { readJson } = require('../core/company-assistant/queries');
const D = require('../core/company-assistant/data');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { CompanyAssistant } = require('../core/company-assistant/service');
const { NoticeBus } = require('../core/company-assistant/notice-bus');
const run = raw => async () => ({ code: 0, stdout: JSON.stringify(raw), stderr: '' });

test('真机 IM.0000 是最近会话查询成功，不能抛出 success 并丢掉所有会话', async () => {
  const raw = { error: { error_code: 'IM.0000', error_msg: 'success' }, conversation_info: [
    { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', group_id: '0', target_account: 'synthetic-person' },
    { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: 'synthetic-group' },
  ] };
  const data = await readJson(run(raw), ['im', 'query-recent-conversation', '--count', '50']);
  assert.equal(D.conversations(data).length, 2);
});

test('真机历史消息 respData.chatInfo 包络可以读到消息，并保留大整数游标', async () => {
  const stdout = '{"resultCode":"0","respData":{"chatInfo":[{"msgId":9007199254740993123,"serverSendTime":1792477870194,"sender":"synthetic-other","content":"合成消息"}],"minMsgId":9007199254740993123,"maxMsgId":9007199254740993123,"msgTotalCount":1}}';
  const data = await readJson(async () => ({ code: 0, stdout, stderr: '' }), ['im', 'query-history-message', '--user-account', 'synthetic-person']);
  assert.equal(D.messageRecords(data).length, 1);
  const rows = D.messages(data, { id: 'synthetic-person', group: false }, 'synthetic-self');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, '9007199254740993123');
  assert.equal(rows[0].at, 1792477870194);
});

test('只接受当前命令已核实的成功码，IM错误和其他命令的IM.0000仍拒绝', async () => {
  for (const [command, code] of [
    [['im', 'query-recent-conversation'], 'IM.0001'],
    [['im', 'query-recent-conversation'], 'IM.9999'],
    [['mail', 'list'], 'IM.0000'],
  ]) await assert.rejects(readJson(run({ error: { error_code: code, error_msg: 'synthetic-error' } }), command), /synthetic-error/);
});

test('对象型错误保留命令与业务码，展示可读说明而不是 object Object', async () => {
  await assert.rejects(readJson(run({ code: 'synthetic-denied', message: { message: '合成的权限错误' } }), ['meeting', 'query-list']), error => {
    assert.match(error.message, /meeting query-list.*synthetic-denied.*合成的权限错误/);
    assert.doesNotMatch(error.message, /object Object/);
    return true;
  });
  await assert.rejects(readJson(run({ code: 'synthetic-unknown', message: { requestContext: '不能写入界面的上下文' } }), ['calendar', 'list']), error => {
    assert.equal(error.message, 'calendar list 查询业务码 synthetic-unknown');
    return true;
  });
});

test('真实 collect 链路接受现场成功码与历史包络，私聊及群 @本人 不会整批变空', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'assistant-im-contract-'));
  const now = Date.parse('2026-10-21T12:00:00+08:00'), calls = [];
  const welinkRun = async args => {
    const command = args.slice(0, 2).join(' '); calls.push(command);
    if (command === 'auth status') return { code: 0, stdout: 'UID: synthetic-self\nUser Token: VALID', stderr: '' };
    const group = args.includes('--group-id');
    const raw = command === 'meeting query-list' ? { code: 200, data: { data: [], total: 0 } }
      : command === 'calendar list' ? { events: [] }
      : command === 'mail list' ? { mails: [] }
      : command === 'im query-recent-conversation' ? {
        error: { error_code: 'IM.0000', error_msg: 'success' }, conversation_info: [
          { recent_conversation_type: 'CHAT_TYPE_P2P_MSG', group_id: '0', target_account: 'synthetic-other', name: '合成同事' },
          { recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', group_id: 'synthetic-group', name: '合成群' },
        ],
      } : command === 'im query-history-message' ? {
        resultCode: '0', respData: { chatInfo: [{ msgId: group ? '9007199254740993124' : '9007199254740993123',
          serverSendTime: now - 1000, sender: 'synthetic-other', content: group ? '合成提及' : '合成私聊',
          at: group, atAccountList: group ? ['synthetic-self'] : [] }], msgTotalCount: 1 },
      } : { code: 0, data: [] };
    return { code: 0, stdout: JSON.stringify(raw), stderr: '' };
  };
  const svc = new CompanyAssistant({ dataDir: dir, now: () => now, welinkRun, noTimer: true, noTools: true, bus: new NoticeBus() });
  t.after(() => { svc.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  svc.setSettings({ email: 'self@example.test' });
  const snap = await svc.collect();
  assert.deepEqual(snap.errors, []);
  assert.equal(snap.conversations.length, 2);
  assert.equal(snap.scope.fetched, 2);
  assert.equal(snap.scope.messages, 2);
  assert.equal(snap.scope.partial, 0);
  assert.notEqual(snap.scope.stale, true);
  assert.equal(snap.messages['synthetic-other'][0].key, '9007199254740993123');
  assert.equal(snap.messages['synthetic-group'][0].atMe, true);
  assert.equal(calls.filter(cmd => cmd === 'im query-history-message').length, 2);
  assert.equal(svc.read('raw-2026-10-21.json').scope.messages, 2);
});
