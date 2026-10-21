'use strict';
// Independent WeLink CLI fixture; real Claude is NOT mocked by this fixture.
// Two discoverable conversations only. This does not claim access to 80 conversations.
const fs = require('node:fs');
const args = process.argv.slice(2), [group, sub] = args;
const arg = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1]; };
const seed = JSON.parse(fs.readFileSync(process.env.WELINK_RELIABILITY_SEED, 'utf8'));
const out = value => process.stdout.write(typeof value === 'string' ? value : JSON.stringify(value));
if (process.env.WELINK_RELIABILITY_LOG) fs.appendFileSync(process.env.WELINK_RELIABILITY_LOG, JSON.stringify({ at: Date.now(), args }) + '\n');
if (group === 'auth' && sub === 'status') out('UID: user001\nUser Token: VALID\n');
else if (group === 'onebox' && sub === 'user-info') out({ accountId: 1, loginName: 'user001', name: '用户甲', email: 'user001@example.com', status: 'normal' });
else if (group === 'mail' && sub === 'autodiscover') out('Autodiscover OK\n');
else if (group === 'mail' && sub === 'list') out({ mails: [] });
else if (group === 'meeting' && sub === 'query-list') {
  const required = ['--page', '--size', '--meeting-start-time', '--meeting-end-time', '--type', '--meeting-sort'];
  if (required.some(k => !arg(k))) { process.stderr.write('required meeting query parameter missing'); process.exitCode = 106; }
  else {
    const page = Number(arg('--page')), size = Number(arg('--size')), type = arg('--type');
    const start = Number(arg('--meeting-start-time')), end = Number(arg('--meeting-end-time'));
    if (!Number.isInteger(page) || page < 1 || !Number.isInteger(size) || size < 1 || size > 30
      || !Number.isFinite(start) || !Number.isFinite(end) || end < start || !['1', '2'].includes(type)) {
      out({ code: '400', message: { message: 'BAD_REQUEST', details: 'synthetic: valid range/page, size 1..30 and type 1/2 are required' } });
    }
    else {
      const byType = {
        '1': [{ meetingId: 'utc-review', subject: '跨区评审', location: '会议室甲', meetingStartTime: seed.day + 'T09:00:00Z', meetingEndTime: seed.day + 'T10:00:00Z', meetingUsers: [] }],
        '2': [{ meetingId: 'ended-morning', subject: '上午复盘（已结束）', location: '会议室乙', meetingStartTime: seed.day + 'T09:00:00+08:00', meetingEndTime: seed.day + 'T10:00:00+08:00', meetingUsers: [] }],
      };
      const selected = byType[type].filter(m => Date.parse(m.meetingStartTime) >= start && Date.parse(m.meetingStartTime) <= end);
      const rows = selected.slice((page - 1) * size, page * size);
      // Q09: an empty result omits data.data and reports total=0; pages with rows keep the full count.
      out({ code: 200, data: { ...(rows.length ? { data: rows } : {}), page, size, total: rows.length ? selected.length : 0 }, description: 'success', timestamp: Date.now() });
    }
  }
} else if (group === 'calendar' && sub === 'list') {
  const max = Number(arg('--max') ?? 20);
  if (!Number.isInteger(max) || max < 0 || max > 500) { process.stderr.write('calendar max must be between 0 and 500'); process.exitCode = 1; }
  else {
    const item = { id: 'china-sync', subject: '中国区对齐会', start: { dateTime: seed.day + 'T14:00:00', timeZone: 'China Standard Time' }, end: { dateTime: seed.day + 'T15:00:00', timeZone: 'China Standard Time' }, location: '线上', isAllDay: false, isCancelled: false };
    const rows = (seed.day >= String(arg('--start')) && seed.day < String(arg('--end')) ? [item] : []).slice(0, max);
    out(rows.length ? rows : 'No events found.\n');
  }
} else if (group === 'contact' && sub === 'detail') {
  const accounts = String(arg('--accounts') || 'user001').split(',');
  out({ code: '0', message: 'SUCCESS', users: accounts.map(account => ({ w3Account: account, personAccount: account, chineseName: { user001: '用户甲', colleague_a: '同事甲', colleague_b: '同事乙' }[account] || account, workId: '00000001', employeeNumber: '12345678912345678' })) });
} else if (group === 'im' && sub === 'query-recent-conversation') {
  const all = [
    { cross_instance: false, group_id: '0', group_name: '', group_type: 'NORMAL_GROUP', native_name: '同事甲', recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: 'colleague_a 00000000', target_account: 'colleague_a' },
    { cross_instance: false, group_id: 'g-reliability', group_name: '可靠性项目群', group_type: 'NORMAL_GROUP', native_name: '', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' },
  ];
  out({ conversation_info: all.slice(0, Math.min(100, Number(arg('--count') || 10))), error: { error_code: 'IM.0000', error_msg: 'success' } });
} else if (group === 'im' && sub === 'query-history-message') {
  const conv = arg('--user-account') || arg('--group-id');
  const privateRows = Array.from({ length: 250 }, (_, i) => ({
    msgId: String(7100000000000000000n + BigInt(i + 1) * 3n), sender: 'colleague_a', serverSendTime: seed.anchor - (250 - i) * 60000,
    content: i === 0 ? '项目节点：本周五17:30提交评审材料，请帮我准备。' : i === 249 ? '预算复核：请在明日11:20确认金额。' : `进展${String(i + 1).padStart(3, '0')}：日常记录，无需处理。`,
    at: false, atAccountList: [],
  }));
  const groupRows = [
    { msgId: '7200000000000000003', sender: 'colleague_b', serverSendTime: seed.anchor - 120000, content: '@用户甲 请在周四16:45发送风险清单。', at: true, atAccountList: ['user001'] },
    { msgId: '7200000000000000006', sender: 'colleague_b', serverSendTime: seed.anchor - 60000, content: '普通群讨论：设备已入库。', at: false, atAccountList: [] },
  ];
  const all = conv === 'colleague_a' ? privateRows : conv === 'g-reliability' ? groupRows : [];
  const from = arg('--message-id'), forward = arg('--query-direction') === '1', count = Number(arg('--query-count') || 20);
  const found = from ? all.filter(m => forward ? BigInt(m.msgId) >= BigInt(from) : BigInt(m.msgId) <= BigInt(from)) : all;
  const list = forward ? found.slice(0, count) : found.slice(-count);
  // Keep the verified integer wire format, including the inclusive cursor overlap.
  const body = list.map(m => JSON.stringify({ ...m, contentType: 'TEXT_MSG', groupId: arg('--group-id') || 0, groupType: 0, receiver: 'user001' }).replace(/"msgId":"(\d+)"/, '"msgId":$1'));
  out(`{"respData":{"chatInfo":[${body.join(',')}],"maxMsgId":${list.at(-1)?.msgId || 0},"minMsgId":${list[0]?.msgId || 0},"msgTotalCount":${list.length}},"resultCode":"0","resultContext":"Operate Success"}`);
} else {
  process.stderr.write('Unsupported isolated fixture command: ' + args.slice(0, 2).join(' ') + '\n'); process.exitCode = 2;
}
