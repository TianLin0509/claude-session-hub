'use strict';
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('../../core/data-dir');
const { VoiceStream, normalizeProfile, endpoint, MODEL } = require('../../core/voice-input');

function registerVoiceInputIpc(ipcMain, { safeStorage, app, createStream = options => new VoiceStream(options) }) {
  const filename = path.join(getHubDataDir(), 'voice-input.json');
  const streams = new Map();
  const owners = new Set();
  function read() {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { region: 'beijing', profiles: {} }; throw new Error('语音配置读取失败，请检查 voice-input.json'); }
  }
  function profileKey(value) { return String(value || '').trim().toLowerCase().replace(/\\/g, '/'); }
  function view(project) {
    const c = read();
    return { region: c.region, workspace: c.workspace || '', model: MODEL,
      keySet: !!(c.encryptedKey || process.env.DASHSCOPE_API_KEY), envKey: !c.encryptedKey && !!process.env.DASHSCOPE_API_KEY,
      profile: c.profiles?.[profileKey(project)] || { terms: '', context: '' } };
  }
  ipcMain.handle('voice:config', (_e, project) => view(project));
  ipcMain.handle('voice:save-config', (_e, patch = {}) => {
    if (streams.size) throw new Error('请先停止或取消录音，再修改配置');
    const c = read();
    c.region = patch.region; c.workspace = String(patch.workspace || '').trim(); endpoint(c);
    if (patch.clearKey) delete c.encryptedKey;
    if (patch.apiKey) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统密钥加密不可用，无法保存 API Key');
      const key = String(patch.apiKey).trim();
      if (key.length > 1024 || /[\r\n]/.test(key)) throw new Error('API Key 格式不正确');
      c.encryptedKey = safeStorage.encryptString(key).toString('base64');
    }
    const project = profileKey(patch.project);
    if (project.length > 1000 || ['__proto__', 'constructor', 'prototype'].includes(project)) throw new Error('项目标识无效');
    c.profiles = { ...c.profiles, [project]: normalizeProfile(patch.profile) };
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    fs.writeFileSync(`${filename}.tmp`, JSON.stringify(c, null, 2), 'utf8');
    fs.renameSync(`${filename}.tmp`, filename);
    return view(patch.project);
  });
  function owned(event, id) {
    const item = streams.get(event.sender.id);
    if (!item || item.id !== id) throw new Error('录音已结束或不属于当前窗口');
    return item;
  }
  function cancelOwner(senderId) {
    const item = streams.get(senderId);
    if (item) { streams.delete(senderId); item.stream.cancel(); }
  }
  ipcMain.handle('voice:start', async (event, request = {}) => {
    if (!/^[a-zA-Z0-9-]{16,80}$/.test(request.id || '')) throw new Error('录音标识无效');
    const sender = event.sender;
    if (streams.has(sender.id)) throw new Error('已有录音正在进行');
    const c = read();
    let apiKey = process.env.DASHSCOPE_API_KEY || '';
    if (c.encryptedKey) {
      try { apiKey = safeStorage.decryptString(Buffer.from(c.encryptedKey, 'base64')); }
      catch { throw new Error('无法解密语音 API Key，请重新配置'); }
    }
    if (!apiKey) throw new Error('请先配置百炼语音 API Key');
    if (!owners.has(sender.id)) {
      owners.add(sender.id);
      sender.once('destroyed', () => { cancelOwner(sender.id); owners.delete(sender.id); });
      sender.on('render-process-gone', () => cancelOwner(sender.id));
      sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancelOwner(sender.id); });
    }
    const id = request.id;
    const stream = createStream({ config: c, apiKey, sampleRate: request.sampleRate,
      profile: c.profiles?.[profileKey(request.project)] || {},
      onEvent: result => {
        if (streams.get(sender.id)?.id !== id) return;
        if (['done', 'error'].includes(result.type)) streams.delete(sender.id);
        if (!sender.isDestroyed()) sender.send('voice:event', { ...result, id });
      } });
    streams.set(sender.id, { id, stream });
    try { await stream.ready; return { id }; }
    catch (error) { if (streams.get(sender.id)?.id === id) streams.delete(sender.id); throw error; }
  });
  ipcMain.handle('voice:audio', async (e, { id, data } = {}) => { await owned(e, id).stream.audio(data); return true; });
  ipcMain.handle('voice:stop', async (e, id) => { if (!await owned(e, id).stream.finish()) throw new Error('停止录音失败'); return true; });
  ipcMain.handle('voice:cancel', (e, id) => { if (streams.get(e.sender.id)?.id === id) cancelOwner(e.sender.id); return true; });
  app.on('before-quit', () => { for (const senderId of streams.keys()) cancelOwner(senderId); });
}
module.exports = { registerVoiceInputIpc };
