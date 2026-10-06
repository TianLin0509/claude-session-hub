'use strict';
// 语音识别走哪条路：本地（显卡，按需装载）→ Token Plan 套餐 → 百炼按量流式。
// 本地模型未就绪或出错时由 Token Plan 接力（套餐内不另计费）；没有套餐 Key 时就等本地就绪。
// 不会静默改走按量计费的流式识别。每段识别写一行用量账本 voice-usage.jsonl，供核对「到底走了哪条路」。
const fs = require('node:fs');
const path = require('node:path');
const plan = require('./voice-tokenplan');
const { localPaths, localInstalled } = require('./local-asr/manager');
const voiceprint = require('./voiceprint');

const ENGINES = ['local', 'tokenplan', 'streaming'];

// voice-input.json 的 engine 显式指定时照办；未指定时：本地已安装 → 本地；有套餐 Key → 套餐；否则按量流式。
function resolveEngine(cfg, dataDir) {
  const planKey = plan.tokenPlanKey(dataDir);
  const localReady = localInstalled(localPaths(cfg));
  const engine = ENGINES.includes(cfg?.engine) ? cfg.engine : (localReady ? 'local' : planKey ? 'tokenplan' : 'streaming');
  return { engine, planKey, localReady };
}

// 本地模型用 context 文本承载词表与领域说明。
function localContext(profile = {}) {
  const terms = String(profile.terms || '').split(/[,，;；\n]/).map(t => t.trim()).filter(Boolean);
  return [terms.join('、'), String(profile.context || '').trim()].filter(Boolean).join('\n');
}

function usageLogger(dataDir) {
  const file = path.join(dataDir, 'voice-usage.jsonl');
  return entry => {
    try { fs.appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), ...entry, sec: Math.round(entry.sec * 10) / 10 }) + '\n'); }
    catch {}
  };
}

// 声纹筛查出错（进程异常等）时本段不过滤，识别照常。
async function screenSafely(pcm16k, vp, state, log) {
  try { return await voiceprint.screen(pcm16k, { vp, state, frameLevels: plan.frameLevels }); }
  catch (error) { log('[voiceprint] 比对失败，本段不过滤：', error.message); return null; }
}

// 电脑端每段录音的识别函数（交给 RecordedVoice）。vp = { profile, speaker } 时先做声纹筛查（他人小句静音）再识别。
function segmentRecognizer({ engine, planKey, profile, local, source, usage = () => {}, log = console.warn, fetchImpl, vp = null }) {
  const context = localContext(profile);
  const recognizeOne = async (pcm16k, signal) => {
    if (engine === 'local' && local) {
      if (!local.ready && !planKey) await local.prepare();
      if (local.ready) {
        try { const [text] = await local.transcribe([pcm16k], context); return { text, via: 'local' }; }
        catch (error) {
          if (!planKey) throw error;
          log('[voice] 本地识别失败，改由 Token Plan 接力：', error.message);
        }
      }
    }
    if (!planKey) throw new Error('未找到 Token Plan 套餐 Key');
    return { text: await plan.recognize(pcm16k, { apiKey: planKey, profile, signal, fetchImpl }), via: 'tokenplan' };
  };
  const state = { seenMe: false }; // 每条录音一个识别函数，跨段记住是否已确认本人
  return async (pcm16k, signal) => {
    const sec = pcm16k.length / 32000;
    const screened = vp ? await screenSafely(pcm16k, vp, state, log) : null;
    const audio = screened ? screened.pcm : pcm16k;
    const result = plan.hasSpeech(audio) ? await recognizeOne(audio, signal) : { text: '', via: null }; // 整段都是他人：不送识别
    usage({ source, via: result.via || 'filtered', sec, ...(screened ? { scores: screened.scores, removed: screened.removed } : {}) });
    return { ...result, me: screened ? screened.me : null, removed: screened?.removed || 0, otherOnly: !!screened?.otherOnly };
  };
}

// 手机整段录音：先做声纹筛查（他人小句静音、全是他人的段落去掉），再本地整批送显卡或各段并发走 Token Plan。
async function transcribeRecording(pcm16k, { engine, planKey, profile, local, source = 'phone', usage = () => {}, log = console.warn, fetchImpl, vp = null }) {
  let parts = plan.speechSegments(pcm16k);
  if (!parts.length) return { text: '', via: {} };
  const sec = parts.reduce((s, p) => s + p.length, 0) / 32000;
  let filtered = 0, scores = null;
  if (vp) {
    if (engine === 'local' && local && !local.ready) void local.prepare().catch(() => {}); // 筛查期间同时装模型
    const state = { seenMe: false }, screened = [];
    for (const p of parts) screened.push(await screenSafely(p, vp, state, log));
    scores = screened.map(s => s?.scores || []);
    filtered = screened.reduce((n, s) => n + (s ? s.removed + (state.seenMe && s.otherOnly ? 1 : 0) : 0), 0);
    parts = screened.map((s, i) => (!s ? parts[i] : state.seenMe && s.otherOnly ? null : s.pcm)).filter(p => p && plan.hasSpeech(p));
    if (!parts.length) { usage({ source, via: 'filtered', sec, scores, filtered }); return { text: '', via: { filtered } }; }
  }
  let texts = null, route = null;
  if (engine === 'local' && local) {
    if (!local.ready && !planKey) await local.prepare();
    if (local.ready) {
      try { texts = await local.transcribe(parts, localContext(profile)); route = 'local'; }
      catch (error) {
        if (!planKey) throw error;
        log('[voice] 本地识别失败，改由 Token Plan 接力：', error.message);
      }
    } else void local.prepare().catch(error => log('[voice] 本地识别准备失败：', error.message)); // 下一条就能走本地
  }
  if (!texts) {
    if (!planKey) throw new Error('未找到 Token Plan 套餐 Key');
    texts = await Promise.all(parts.map(p => plan.recognize(p, { apiKey: planKey, profile, fetchImpl }))); route = 'tokenplan';
  }
  usage({ source, via: route, sec, ...(vp ? { scores, filtered } : {}) });
  return { text: plan.joinTexts(texts), via: { [route]: parts.length, ...(filtered ? { filtered } : {}) } };
}

// 「本地 3 段 · Token Plan 1 段」这类说明，界面与手机回执共用。
function describeVia(via = {}) {
  const names = { local: '本地', tokenplan: 'Token Plan', streaming: '按量流式' };
  return Object.entries(via).filter(([, n]) => n > 0).map(([k, n]) => k === 'filtered' ? `已滤掉他人说话 ${n} 段` : `${names[k] || k} ${n} 段`).join(' · ');
}

module.exports = { ENGINES, resolveEngine, localContext, usageLogger, segmentRecognizer, transcribeRecording, describeVia };
