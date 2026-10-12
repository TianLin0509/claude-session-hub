#!/usr/bin/env node
'use strict';
// 阿里云控制台专用浏览器：给 AI 会话用的只读入口。说明见 docs/aliyun-console.md。
//   node scripts/aliyun-console.js status                 登录状态（只看 cookie 名字和页面地址）
//   node scripts/aliyun-console.js open [网址]            打开页面（默认百炼控制台首页），浏览器没开就在屏幕外启动
//   node scripts/aliyun-console.js text [--tab id] [--max 20000]   读当前页文字（密钥已遮蔽）
//   node scripts/aliyun-console.js screenshot [路径.png] [--tab id] 截图，默认存到产物根目录
//   node scripts/aliyun-console.js list                   列出标签页
//   node scripts/aliyun-console.js close                  正常退出浏览器，登录资料保留
// 通用参数：--data-dir <Hub 数据目录>（默认 CLAUDE_HUB_DATA_DIR 或 ~/.claude-session-hub），--json 输出 JSON。
// 安全底线：只导航和读取。下单、付款、改配置、开通或关闭服务、删资源都由用户本人在界面上操作；
// 不输出 cookie、AccessKey、API Key。
const path = require('path');
// 浏览器关着时用 node:sqlite 读 cookie 名字；它的「实验特性」提示对使用者没有意义。
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => { if (/SQLite/.test(String(warning))) return; return emitWarning.call(process, warning, ...rest); };
const { AliyunConsole, HOME_URL } = require('../core/aliyun-console');

function parse(argv) {
  const args = [], opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') opts.json = true;
    else if (['--tab', '--max', '--data-dir'].includes(a)) opts[a.slice(2)] = argv[++i];
    else args.push(a);
  }
  return { command: args[0] || 'help', rest: args.slice(1), opts };
}
function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, '0');
  return { day: `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`, time: `${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}` };
}
function defaultShot() {
  const { artifactsRoot } = require('../core/storage-roots');
  const s = stamp();
  return path.join(artifactsRoot(), `${s.day}-aliyun-console`, `${s.day}-${s.time}-aliyun-console.png`);
}
const STATE = { signed_in: '已登录', signed_out: '未登录', unknown: '未确认' };
// 百炼控制台未登录时不跳转，照样显示页面（如「您还未订阅 Token Plan」），读到的内容要标明是未登录视图。
async function loginNote(c) {
  let v; try { v = await c.status(); } catch { return { state: 'unknown', note: '' }; }
  if (v.state === 'signed_in') return { state: v.state, note: '' };
  return { state: v.state, note: '注意：专用浏览器' + (v.state === 'signed_out' ? '还没登录阿里云' : '的登录状态未确认') + '，下面是未登录时的页面，不能当作账号的真实数据。需要用户本人在 Hub 账号页「阿里云控制台」点登录（扫码或密码），AI 不代填。\n' };
}
async function main(argv = process.argv.slice(2), out = s => process.stdout.write(s + '\n')) {
  const { command, rest, opts } = parse(argv);
  const c = new AliyunConsole({ dataDir: opts['data-dir'] });
  const print = (value, text) => out(opts.json ? JSON.stringify(value, null, 2) : text);
  if (command === 'status') {
    const v = await c.status();
    return print(v, `阿里云控制台：${STATE[v.state] || v.state}（${v.message}）；浏览器${v.running ? '运行中' : '未运行'}`);
  }
  if (command === 'open') {
    const v = await c.open(rest[0] || HOME_URL), login = await loginNote(c);
    return print({ ...v, login: login.state }, login.note + `已打开：${v.title || '(无标题)'}\n${v.url}`);
  }
  if (command === 'text') {
    const v = await c.text({ tab: opts.tab, max: Number(opts.max) || 20000 }), login = await loginNote(c);
    return print({ ...v, login: login.state }, login.note + `标题：${v.title}\n地址：${v.url}\n` + '----\n' + v.text + (v.truncated ? '\n----\n（文字已截断，可用 --max 调大）' : ''));
  }
  if (command === 'screenshot') {
    const v = await c.screenshot(rest[0] || defaultShot(), { tab: opts.tab });
    return print(v, `截图已保存：${v.file}\n页面：${v.title} ${v.url}`);
  }
  if (command === 'list') {
    const v = await c.list();
    if (!v.running) return print(v, '阿里云控制台专用浏览器没在运行');
    return print(v, v.tabs.map(t => `${t.id.slice(0, 8)}${t.tool ? ' [AI]' : ''}  ${t.title || '(无标题)'}  ${t.url}`).join('\n') || '没有标签页');
  }
  if (command === 'close') {
    const v = await c.close();
    return print(v, v.closed ? '已退出阿里云控制台专用浏览器，登录资料保留' : '浏览器本来就没在运行');
  }
  out(require('fs').readFileSync(__filename, 'utf8').split('\n').slice(2, 13).map(l => l.replace(/^\/\/ ?/, '')).join('\n'));
  if (command !== 'help') process.exitCode = 2;
}
if (require.main === module) main().catch(e => { process.stderr.write(e.message + '\n'); process.exitCode = 1; });
module.exports = { main, parse };
