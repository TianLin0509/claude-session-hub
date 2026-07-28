'use strict';

const systemOs = require('os');

function readCpuTotals(osApi) {
  const cpus = osApi.cpus();
  if (!Array.isArray(cpus) || cpus.length === 0) return null;

  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const times = cpu && cpu.times;
    if (!times) continue;
    const values = Object.values(times).filter(Number.isFinite);
    idle += Number.isFinite(times.idle) ? times.idle : 0;
    total += values.reduce((sum, value) => sum + value, 0);
  }
  return total > 0 ? { idle, total } : null;
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function createSystemResourceSampler(osApi = systemOs) {
  let previousCpu = readCpuTotals(osApi);

  return function sampleSystemResourceUsage() {
    const currentCpu = readCpuTotals(osApi);
    let cpuPct = null;
    if (previousCpu && currentCpu) {
      const totalDelta = currentCpu.total - previousCpu.total;
      const idleDelta = currentCpu.idle - previousCpu.idle;
      if (totalDelta > 0) cpuPct = clampPercent((1 - Math.max(0, idleDelta) / totalDelta) * 100);
    }
    previousCpu = currentCpu;

    const totalMemory = osApi.totalmem();
    const freeMemory = osApi.freemem();
    const memoryPct = totalMemory > 0
      ? clampPercent((1 - freeMemory / totalMemory) * 100)
      : null;

    return { cpuPct, memoryPct, sampledAt: Date.now() };
  };
}

function saveClipboardImage(deps) {
  const {
    clipboard,
    crypto,
    fs,
    imageDir,
    logger = console,
    path,
  } = deps;

  try {
    const image = clipboard.readImage();
    if (image.isEmpty()) return null;

    fs.mkdirSync(imageDir, { recursive: true });

    const now = new Date();
    const timestamp = now.toISOString().replace(/[-:T]/g, '').slice(0, 14);
    const id = crypto.randomBytes(3).toString('hex');
    const filename = `${timestamp}-${id}.png`;
    const filePath = path.join(imageDir, filename);

    fs.writeFileSync(filePath, image.toPNG());
    return filePath;
  } catch (err) {
    logger.warn('[群聊] save-clipboard-image failed:', err.message);
    return null;
  }
}

function showNotification({ title, body }, deps) {
  const {
    getMainWindow,
    Notification,
  } = deps;

  if (!Notification.isSupported()) return false;
  const notification = new Notification({ title: title || 'AI 群聊', body: body || '', silent: false });
  notification.on('click', () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  notification.show();
  return true;
}

function registerAppUtilityIpc(ipcMain, deps) {
  const sampleSystemResourceUsage = createSystemResourceSampler(deps.os || systemOs);

  ipcMain.on('show-notification', (_e, payload = {}) => {
    showNotification(payload, deps);
  });

  ipcMain.handle('is-window-focused', () => {
    const mainWindow = deps.getMainWindow();
    return mainWindow ? mainWindow.isFocused() : false;
  });

  ipcMain.handle('save-clipboard-image', () => {
    return saveClipboardImage(deps);
  });

  ipcMain.handle('get-hook-status', () => ({
    up: deps.getHookPort() !== null,
    port: deps.getHookPort(),
  }));

  ipcMain.handle('get-system-resource-usage', () => sampleSystemResourceUsage());
}

module.exports = {
  createSystemResourceSampler,
  registerAppUtilityIpc,
  saveClipboardImage,
  showNotification,
};
