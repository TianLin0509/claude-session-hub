'use strict';
// 假 welink-cli（测试用，占位数据，不含真实人名）：按公司真机 1.0.14 的回执形状输出今天的会议、会话、消息、邮件。
// 每次调用把参数追加到 WELINK_STANDIN_LOG（验证 Hub 只调了查询命令）。
// WELINK_STANDIN_STATE 指向一个文件：内容为 expired 时 auth status 报过期；auth login 打印二维码，2 秒后写成 ok。
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

if (group === 'auth' && sub === 'status') {
  out(loggedIn() ? 'UID: user001\nUser Token: VALID\n' : 'UID: user001\nUser Token: EXPIRED\n');
} else if (group === 'auth' && sub === 'login') {
  // 1x1 像素的 PNG，当作二维码图片
  out('请用 WeLink 扫码登录：\ndata:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==\n');
  setTimeout(() => { if (stateFile) fs.writeFileSync(stateFile, 'ok'); out('登录成功\n'); }, 2000);
} else if (!loggedIn()) {
  process.stderr.write('Token expired, please run: welink-cli auth login\n');
  process.exitCode = 1;
} else if (group === 'meeting' && sub === 'query-list') {
  const soon = now + 10 * M;
  out({ meetings: [
    { enMeetingId: 'e1', meetingId: 'm-soon', subject: '方案评审（占位）', location: '会议室A', meetingStartTime: soon, meetingEndTime: soon + H, meetingUsers: [{}, {}, {}], files: [{}] },
    { enMeetingId: 'e2', meetingId: 'm-a', subject: '周例会（占位）', location: '会议室B', meetingStartTime: today(13, 0), meetingEndTime: today(14, 30), meetingUsers: [{}, {}] },
    { enMeetingId: 'e3', meetingId: 'm-b', subject: '对齐会（占位）', location: '线上', meetingStartTime: today(14, 30), meetingEndTime: today(16, 0), meetingUsers: [{}] },
    { enMeetingId: 'e4', meetingId: 'm-c', subject: '一对一（占位）', location: '线上', meetingStartTime: today(15, 30), meetingEndTime: today(16, 30), meetingUsers: [{}] },
  ], totalSize: 4 });
} else if (group === 'calendar' && sub === 'list') {
  process.stderr.write('Exchange server domain not found. Please run first: welink-cli mail autodiscover --email\n');
  process.exitCode = 1;
} else if (group === 'im' && sub === 'query-recent-conversation') {
  out({ conversation_info: [
    { group_id: '', group_name: '', group_type: 0, native_name: '同事甲', recent_conversation_type: 'CHAT_TYPE_P2P_MSG', staff_name: '同事甲', target_account: 'colleague_a' },
    { group_id: 'g-100', group_name: '项目群A', group_type: 1, native_name: '项目群A', recent_conversation_type: 'CHAT_TYPE_GROUP_MSG', staff_name: '', target_account: '' },
  ] });
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
} else if (group === 'mail' && sub === 'list') {
  out({ mails: [
    { id: 'mail-1', subject: '例会材料征集（今天 17:00 截止）', from: { name: '部门秘书' }, receivedTime: now - 3 * H, importance: 'High' },
    { id: 'mail-2', subject: '周报汇总', from: '同事乙', receivedTime: now - 6 * H },
  ] });
} else if (group === 'mail' && sub === 'autodiscover') {
  out('Autodiscover OK\n');
} else {
  process.stderr.write('unknown command: ' + args.join(' ') + '\n');
  process.exitCode = 2;
}
