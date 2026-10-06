'use strict';
const fs = require('fs');
const path = require('path');
const { getHubDataDir } = require('../../core/data-dir');
const { VoiceStream, normalizeProfile, endpoint, MODEL } = require('../../core/voice-input');
const planVoice = require('../../core/voice-tokenplan');
const voiceEngine = require('../../core/voice-engine');
const { getLocalAsr } = require('../../core/local-asr/manager');

const ENGINE_LABEL = { local: '本地 Qwen3-ASR-1.7B（未就绪时 Token Plan 接力）', tokenplan: planVoice.MODEL + '（Token Plan）', streaming: MODEL + '（按量）' };

function registerVoiceInputIpc(ipcMain, { safeStorage, app, createStream = options => new VoiceStream(options),
  createRecorded = options => new planVoice.RecordedVoice(options), getLocal = getLocalAsr, envStartDelayMs = 20000 }) {
  const dataDir = getHubDataDir();
  const usage = voiceEngine.usageLogger(dataDir);
  const filename = path.join(dataDir, 'voice-input.json');
  const streams = new Map();
  const owners = new Set();
  function read() {
    try { return JSON.parse(fs.readFileSync(filename, 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return { region: 'beijing', profiles: {} }; throw new Error('语音配置读取失败，请检查 voice-input.json'); }
  }
  function profileKey(value) { return String(value || '').trim().toLowerCase().replace(/\\/g, '/'); }
  function view(project) {
    const c = read();
    const { engine, planKey, localReady } = voiceEngine.resolveEngine(c, dataDir);
    const meteredKey = !!(c.encryptedKey || process.env.DASHSCOPE_API_KEY);
    const local = localReady ? getLocal(c) : null;
    return { region: c.region, workspace: c.workspace || '', engine, planReady: !!planKey, meteredKeySet: meteredKey,
      localInstalled: localReady, localState: local?.state || 'off', model: ENGINE_LABEL[engine],
      keySet: engine === 'local' ? localReady : engine === 'tokenplan' ? !!planKey : meteredKey, envKey: !c.encryptedKey && !!process.env.DASHSCOPE_API_KEY,
      profile: c.profiles?.[profileKey(project)] || { terms: '', context: '' } };
  }
  ipcMain.handle('voice:config', (_e, project) => view(project));
  ipcMain.handle('voice:save-config', (_e, patch = {}) => {
    if (streams.size) throw new Error('请先停止或取消录音，再修改配置');
    const c = read();
    c.region = patch.region; c.workspace = String(patch.workspace || '').trim(); endpoint(c);
    if (patch.engine !== undefined) {
      if (!voiceEngine.ENGINES.includes(patch.engine)) throw new Error('识别方式无效');
      c.engine = patch.engine;
    }
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
    const { engine, planKey, localReady } = voiceEngine.resolveEngine(c, dataDir);
    let apiKey = process.env.DASHSCOPE_API_KEY || '';
    let local = null;
    if (engine === 'local') {
      if (!localReady) throw new Error('本地识别未安装（缺少运行环境或模型），请在语音设置里改用 Token Plan');
      local = getLocal(c);
      void local.prepare().catch(error => console.warn('[voice] 本地识别准备失败：', error.message)); // 与说话同时装载模型
    } else if (engine === 'tokenplan') {
      apiKey = planKey;
      if (!apiKey) throw new Error('未找到百炼 Token Plan 套餐 Key，请在语音设置里改用按量识别');
    } else {
      if (c.encryptedKey) {
        try { apiKey = safeStorage.decryptString(Buffer.from(c.encryptedKey, 'base64')); }
        catch { throw new Error('无法解密语音 API Key，请重新配置'); }
      }
      if (!apiKey) throw new Error('请先配置百炼语音 API Key');
    }
    if (!owners.has(sender.id)) {
      owners.add(sender.id);
      sender.once('destroyed', () => { cancelOwner(sender.id); owners.delete(sender.id); });
      sender.on('render-process-gone', () => cancelOwner(sender.id));
      sender.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => { if (mainFrame && !inPlace) cancelOwner(sender.id); });
    }
    const id = request.id;
    const profile = c.profiles?.[profileKey(request.project)] || {};
    const recognizeSegment = engine === 'local'
      ? voiceEngine.segmentRecognizer({ engine, planKey, profile, local, source: 'desktop', usage })
      : engine === 'tokenplan' ? voiceEngine.segmentRecognizer({ engine, planKey, profile, source: 'desktop', usage }) : undefined;
    const stream = (engine === 'streaming' ? createStream : createRecorded)({ config: c, apiKey, sampleRate: request.sampleRate,
      profile, recognizeSegment,
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
  app.on('before-quit', () => { for (const senderId of streams.keys()) cancelOwner(senderId); getLocal(read())?.stop(); });
  // 运行环境常驻（不占显存）：启动后稍等再拉起，不拖慢 Hub 启动；第一次说话只需装模型约 5 秒。
  const warmEnv = setTimeout(() => {
    try { const c = read(); if (voiceEngine.resolveEngine(c, dataDir).engine === 'local') getLocal(c)?.start(); }
    catch (error) { console.warn('[voice] 本地识别环境未启动：', error.message); }
  }, envStartDelayMs);
  warmEnv.unref?.();
}
module.exports = { registerVoiceInputIpc };
