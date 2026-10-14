'use strict';
// 无线 Tab 的主进程入口：SuperRAN 助理的状态、设置与手动操作。
const { WirelessAssistant } = require('../../core/wireless-assistant/service');

function registerWirelessIpc(ipcMain, deps) {
  const service = new WirelessAssistant(deps);
  for (const [name, handler] of Object.entries({
    status: () => service.status(),
    'check-now': () => service.poll(),
    'set-settings': request => ({ ok: true, settings: service.setSettings(request || {}) }),
    act: request => service.act(String(request?.id || ''), String(request?.action || '')),
  })) ipcMain.handle('wireless:' + name, async (_event, request = {}) => { try { return await handler(request); } catch (error) { return { ok: false, error: error.message }; } });
  service.start();
  return service;
}

module.exports = { registerWirelessIpc };
