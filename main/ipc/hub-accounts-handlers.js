'use strict';
// The account page's whole surface: read the state, 检查登录, 登录.
function registerHubAccountsIpc(ipcMain, accounts) {
  const wrap = fn => async (_event, payload = {}) => {
    try { return { ok: true, data: await fn(payload) }; }
    catch (e) { return { ok: false, error: e.message || '账号操作失败' }; }
  };
  ipcMain.handle('hub-accounts:state', wrap(() => accounts.state()));
  ipcMain.handle('hub-accounts:check', wrap(() => accounts.check()));
  ipcMain.handle('hub-accounts:login', wrap(p => {
    if (p.identity !== undefined && (typeof p.identity !== 'string' || !/^[\w-]{1,32}$/.test(p.identity))) throw new Error('身份标识无效');
    if (p.site !== undefined && (typeof p.site !== 'string' || !/^[a-z]{1,20}$/.test(p.site))) throw new Error('网站标识无效');
    return accounts.login({ identity: p.identity, site: p.site });
  }));
}
module.exports = { registerHubAccountsIpc };
