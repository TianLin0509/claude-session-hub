'use strict';
// Operate the Hub's one Chrome from a terminal (the account page calls the same module).
//   node scripts/hub-chrome.js status            which sites each identity is logged in to
//   node scripts/hub-chrome.js login main        one window, a tab per site of identity main
//   node scripts/hub-chrome.js login alt chatgpt
//   node scripts/hub-chrome.js close
// Honours HUB_CHROME_ROOT and the Hub's isolation variables, like the Hub itself.
const { HubChrome, SITES } = require('../core/hub-chrome');

async function main() {
  const [command = 'status', identity, ...sites] = process.argv.slice(2);
  const hub = new HubChrome();
  if (command === 'login') {
    const r = await hub.openLogin(identity || 'main', sites.length ? sites : undefined);
    console.log(`已在 Hub 浏览器打开「${hub.identity(identity || 'main').label}」的登录窗口：${(r.sites || []).map(k => SITES[k].name).join('、') || '1 个站点'}`);
    return;
  }
  if (command === 'close') { await hub.close(); console.log('Hub 浏览器已关闭'); return; }
  if (command === 'status') {
    console.log('Hub 浏览器目录：' + hub.root + (await hub.running() ? '（运行中）' : '（未运行）'));
    for (const id of hub.identities.map(i => i.id)) {
      const s = await hub.loginStatus(id);
      const parts = Object.entries(s.sites).map(([k, v]) => {
        const name = SITES[k].name;
        if (v.state === 'signed_in') return `${name} ✓${v.expiresAt ? ' 至 ' + new Date(v.expiresAt).toLocaleDateString('zh-CN') : ''}`;
        if (v.state === 'needs_browser') return `${name} ?（需浏览器在跑才能确认）`;
        if (v.state === 'needs_attention') return `${name} ⚠ 需完成人机验证`;
        if (v.state === 'unknown') return `${name} ?`;
        return `${name} ✗`;
      });
      console.log(`  ${hub.identity(id).label}（${id}）${s.account ? ' · ChatGPT 账号 ' + s.account : ''}：${parts.join('  ')}`);
    }
    return;
  }
  throw new Error('未知命令：' + command);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
