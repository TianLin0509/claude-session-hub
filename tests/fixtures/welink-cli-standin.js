'use strict';
// 假 welink-cli（测试用，占位数据，不含真实人名）：按公司真机 1.0.14 的回执形状输出今天的会议、会话、消息、邮件。
// 每次调用把参数追加到 WELINK_STANDIN_LOG（验证 Hub 只调了查询命令）。
// WELINK_STANDIN_STATE 指向一个文件：内容为 expired 时 auth status 报过期；auth login 打印二维码，2 秒后写成 ok。
// 邮件和日历：同目录下没有 welink-exchange（mail autodiscover 写的本地配置）时，和真机一样报 Exchange 未配置；
// onebox user-info 返回本人邮箱（WELINK_STANDIN_NO_EMAIL=1 时不带邮箱）。
const fs = require('node:fs');
const args = process.argv.slice(2);
if (process.env.WELINK_STANDIN_LOG) fs.appendFileSync(process.env.WELINK_STANDIN_LOG, JSON.stringify(args) + '\n');
const stateFile = process.env.WELINK_STANDIN_STATE;
const loggedIn = () => !stateFile || !fs.existsSync(stateFile) || fs.readFileSync(stateFile, 'utf8').trim() !== 'expired';
const now = Date.now(), H = 3600000, M = 60000;
const today = (h, m) => { const d = new Date(); d.setHours(h, m, 0, 0); return d.getTime(); };
const out = v => process.stdout.write(typeof v === 'string' ? v : JSON.stringify(v));
const [group, sub] = args;
const arg = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const exchangeFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-exchange') : null;
const exchangeReady = () => !!exchangeFile && fs.existsSync(exchangeFile);
const phoneFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-phone-group.jsonl') : null;
const phoneGroup = () => (phoneFile && fs.existsSync(phoneFile) ? fs.readFileSync(phoneFile, 'utf8').split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l)) : []);
function addPhoneMessage(sender, content, at = Date.now()) {
  const all = phoneGroup();
  const last = all.length ? BigInt(all[all.length - 1].msgId) : 7300000000000000000n;
  fs.appendFileSync(phoneFile, JSON.stringify({ msgId: String(last + 7n), sender, content, serverSendTime: at }) + '\n');
}
const needExchange = () => { process.stderr.write('Error: Exchange server domain not found. Please run first: welink-cli mail autodiscover --email <your-email>\n'); process.exitCode = 1; };

if (group === '__test' && sub === 'say') {
  // 测试用：模拟在手机上往专用群里发一句（发件人默认本人 user001）。
  addPhoneMessage(arg('--sender') || 'user001', arg('--text') || '', arg('--at') ? Number(arg('--at')) : Date.now()); // --at：模拟旧消息
} else if (group === 'auth' && sub === 'status') {
  out(loggedIn() ? 'UID: user001\nUser Token: VALID\n' : 'UID: user001\nUser Token: EXPIRED\n');
} else if (group === 'auth' && sub === 'login') {
  // 1x1 像素的 PNG，当作二维码图片
  out('请用 WeLink 扫码登录：\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\n');
  setTimeout(() => { if (stateFile) fs.writeFileSync(stateFile, 'ok'); out('登录成功\n'); }, 2000);
} else if (!loggedIn()) {
  process.stderr.write('Token expired, please run: welink-cli auth login\n');
  process.exitCode = 1;
} else if (group === 'meeting' && sub === 'query-list') {
  // 「马上要开的会」定在第一次查询后 12 分钟，之后每次查询返回同一时间（Hub 取数和助理会话自己查，时间要一致）。
  const anchorFile = stateFile ? require('node:path').join(require('node:path').dirname(stateFile), 'welink-anchor') : null;
  if (anchorFile && !fs.existsSync(anchorFile)) fs.writeFileSync(anchorFile, String(now + 12 * M));
  const soon = anchorFile ? Number(fs.readFileSync(anchorFile, 'utf8')) : now + 10 * M;
  out({ meetings: [
    { enMeetingId: 'e1', meetingId: 'm-soon', subject: '方案评审（占位）', location: '会议室A', meetingStartTime: soon, meetingEndTime: soon + H, meetingUsers: [{}, {}, {}], files: [{}] },
    { enMeetingId: 'e2', meetingId: 'm-a', subject: '周例会（占位）', location: '会议室B', meetingStartTime: today(13, 0), meetingEndTime: today(14, 30), meetingUsers: [{}, {}] },
    { enMeetingId: 'e3', meetingId: 'm-b', subject: '对齐会（占位）', location: '线上', meetingStartTime: today(14, 30), meetingEndTime: today(16, 0), meetingUsers: [{}] },
    { enMeetingId: 'e4', meetingId: 'm-c', subject: '一对一（占位）', location: '线上', meetingStartTime: today(15, 30), meetingEndTime: today(16, 30), meetingUsers: [{}] },
  ], totalSize: 4 });
} else if (group === 'calendar' && sub === 'list') {
  if (!exchangeReady()) needExchange();
  else out({ items: [{ id: 'cal-1', subject: '晨会（日历占位）', start: { dateTime: new Date(today(6, 0)).toISOString() }, end: { dateTime: new Date(today(6, 30)).toISOString() }, location: '线上' }] });
} else if (group === 'onebox' && sub === 'user-info') {
  out({ accountId: 1, name: '用户甲', loginName: 'user001', email: process.env.WELINK_STANDIN_NO_EMAIL === '1' ? '' : 'user001@example.com', status: 'normal' });
} else if (group === 'im' && sub === 'query-recent-conversation') {
  out({ conversation_info: [
    { group_id: '', group_name: '', group_type: 0, native_name: '同事甲', recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: '同事甲', target_account: 'colleague_a' },
    { group_id: 'g-100', group_name: '项目群A', group_type: 1, native_name: '项目群A', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' },
    { group_id: 'g-phone', group_name: '助理 CodeAgent', group_type: 0, native_name: '助理 CodeAgent', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' },
  ] });
} else if (group === 'im' && sub === 'query-history-message' && arg('--group-id') === 'g-phone') {
  // 手机对话的专用群：消息存在 WELINK_STANDIN_STATE 同目录的 welink-phone-group.jsonl（测试往里写「手机发的」消息）。
  // 和真机一样：msgId 是超过 JS 安全整数的长整数；--query-direction 1 取比 --message-id 更新的（help 写反了）。
  const all = phoneGroup();
  const from = arg('--message-id'), dir = arg('--query-direction'), count = Number(arg('--query-count') || 20);
  let list = from ? all.filter(m => dir === '1' ? BigInt(m.msgId) > BigInt(from) : BigInt(m.msgId) < BigInt(from)) : all.slice(-count);
  list = dir === '1' ? list.slice(0, count) : list.slice(-count);
  const body = list.map(m => `{"at":"","atAccountList":[],"content":${JSON.stringify(m.content)},"contentType":"TEXT_MSG","groupId":"g-phone","groupType":0,"msgId":${m.msgId},"receiver":"g-phone","sender":${JSON.stringify(m.sender)},"serverSendTime":${m.serverSendTime}}`);
  out(`{"code":0,"data":{"msgTotalCount":${list.length},"msgList":[${body.join(',')}]}}`);
} else if (group === 'im' && sub === 'send-to-group') {
  if (arg('--group-id') !== 'g-phone') { process.stderr.write('group not found\n'); process.exitCode = 1; }
  else { addPhoneMessage('user001', arg('--text') || ''); out('{"code":0,"message":"success"}'); }
} else if (group === 'im' && sub === 'query-group-member') {
  out({ code: 0, data: { memberList: arg('--group-id') === 'g-phone'
    ? [{ account: 'user001', name: '用户甲' }, { account: 'xiaowei_bot', name: '小微助手' }]
    : [{ account: 'user001', name: '用户甲' }, { account: 'colleague_b', name: '同事乙' }, { account: 'colleague_c', name: '同事丙' }] } });
} else if (group === 'im' && sub === 'query-history-message') {
  if (arg('--user-account') === 'colleague_a') {
    out({ messages: [
      { msg_id: 'p1', sender_account: 'user001', sender_name: '我', send_time: now - 30 * H, content: '好的，我周五前把评估报告发你' },
      { msg_id: 'p2', sender_account: 'colleague_a', sender_name: '同事甲', send_time: now - 5 * H, content: '评审材料能先帮我看一下吗？' },
    ] });
  } else {
    out({ messages: [
      { msg_id: 'g1', sender_account: 'colleague_b', sender_name: '同事乙', send_time: now - 2 * H, content: '仿真基线已更新，请大家确认' },
      { msg_id: 'g2', sender_account: 'colleague_c', sender_name: '同事丙', send_time: now - 20 * M, content: '版本转测时间定在下周一' },
    ] });
  }
} else if (group === 'mail' && sub === 'list' && exchangeFile && !exchangeReady()) {
  needExchange();
} else if (group === 'mail' && sub === 'list') {
  out({ mails: [
    { id: 'mail-1', subject: '例会材料征集（今天 17:00 截止）', from: { name: '部门秘书' }, receivedTime: now - 3 * H, importance: 'High' },
    { id: 'mail-2', subject: '周报汇总', from: '同事乙', receivedTime: now - 6 * H },
  ] });
} else if (group === 'mail' && sub === 'autodiscover') {
  if (exchangeFile) fs.writeFileSync(exchangeFile, String(arg('--email') || ''));
  out('Autodiscover OK\n');
} else {
  process.stderr.write('unknown command: ' + args.join(' ') + '\n');
  process.exitCode = 2;
}
