'use strict';
// 家里联动的主进程入口（2026-10-15）：家里 Hub 与公司 Hub 共用一组 IPC，按本机角色接到不同的服务。
//   家里：生成配对码、看往来、挂载范围；公司：粘贴配对码、代码位置与说明、模型、放行页。
function registerCompanyBridgeIpc(ipcMain, service, { openGate } = {}) {
  const role = service.status().role;
  const handlers = {
    status: () => service.status(),
    'check-now': () => service.checkNow(),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    unpair: () => service.unpair(),
  };
  if (role === 'home') {
    handlers['create-pairing'] = () => service.createPairing();
    handlers['send-pairing'] = () => service.sendPairingToInbox();
  } else {
    handlers.pair = request => service.pair(String(request?.code || ''));
    handlers.retry = request => service.retry(String(request?.id || ''));
    handlers['open-gate'] = async () => {
      const url = service.status().net?.gate?.url || service.link.client().gatePage();
      if (openGate) await openGate(url);
      return service.checkNow();
    };
  }
  for (const [name, handler] of Object.entries(handlers)) {
    ipcMain.handle('bridge:' + name, async (_event, request = {}) => { try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; } });
  }
  return service;
}

module.exports = { registerCompanyBridgeIpc };
