'use strict';
// 语音识别走哪条路：本地（显卡，按需装载）→ Token Plan 套餐 → 百炼按量流式。
// 本地模型未就绪或出错时由 Token Plan 接力（套餐内不另计费）；没有套餐 Key 时就等本地就绪。
// 不会静默改走按量计费的流式识别。每段识别写一行用量账本 voice-usage.jsonl，供核对「到底走了哪条路」。
const fs = require('node:fs');
const path = require('node:path');
const plan = require('./voice-tokenplan');
const { localPaths, localInstalled } = require('./local-asr/manager');

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

// 电脑端每段录音的识别函数（交给 RecordedVoice）。
function segmentRecognizer({ engine, planKey, profile, local, source, usage = () => {}, log = console.warn, fetchImpl }) {
  const context = localContext(profile);
  return async (pcm16k, signal) => {
    const sec = pcm16k.length / 32000;
    if (engine === 'local' && local) {
      if (!local.ready && !planKey) await local.prepare();
      if (local.ready) {
        try {
          const [text] = await local.transcribe([pcm16k], context);
          usage({ source, via: 'local', sec }); return { text, via: 'local' };
        } catch (error) {
          if (!planKey) throw error;
          log('[voice] 本地识别失败，改由 Token Plan 接力：', error.message);
        }
      }
    }
    if (!planKey) throw new Error('未找到 Token Plan 套餐 Key');
    const text = await plan.recognize(pcm16k, { apiKey: planKey, profile, signal, fetchImpl });
    usage({ source, via: 'tokenplan', sec }); return { text, via: 'tokenplan' };
  };
}

// 手机整段录音：本地就绪时整批送显卡（多段一次批量），否则各段并发走 Token Plan。
async function transcribeRecording(pcm16k, { engine, planKey, profile, local, source = 'phone', usage = () => {}, log = console.warn, fetchImpl }) {
  const parts = plan.speechSegments(pcm16k);
  if (!parts.length) return { text: '', via: {} };
  const sec = parts.reduce((s, p) => s + p.length, 0) / 32000;
  if (engine === 'local' && local) {
    if (!local.ready && !planKey) await local.prepare();
    if (local.ready) {
      try {
        const texts = await local.transcribe(parts, localContext(profile));
        usage({ source, via: 'local', sec }); return { text: plan.joinTexts(texts), via: { local: parts.length } };
      } catch (error) {
        if (!planKey) throw error;
        log('[voice] 本地识别失败，改由 Token Plan 接力：', error.message);
      }
    } else void local.prepare().catch(error => log('[voice] 本地识别准备失败：', error.message)); // 下一条就能走本地
  }
  if (!planKey) throw new Error('未找到 Token Plan 套餐 Key');
  const text = await plan.recognizeParts(parts, { apiKey: planKey, profile, fetchImpl });
  usage({ source, via: 'tokenplan', sec }); return { text, via: { tokenplan: parts.length } };
}

// 「本地 3 段 · Token Plan 1 段」这类说明，界面与手机回执共用。
function describeVia(via = {}) {
  const names = { local: '本地', tokenplan: 'Token Plan', streaming: '按量流式' };
  return Object.entries(via).filter(([, n]) => n > 0).map(([k, n]) => `${names[k] || k} ${n} 段`).join(' · ');
}

module.exports = { ENGINES, resolveEngine, localContext, usageLogger, segmentRecognizer, transcribeRecording, describeVia };
