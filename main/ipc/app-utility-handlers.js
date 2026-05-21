'use strict';

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
}

module.exports = {
  registerAppUtilityIpc,
  saveClipboardImage,
  showNotification,
};
