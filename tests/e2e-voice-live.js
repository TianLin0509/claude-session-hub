'use strict';
// 真实端到端（边说边出字）：隔离 Hub + WAV 当麦克风 + 真实本地 Qwen3-ASR + 真实百炼实时 API（3.1 流式，冷启动接力）。
// 验收：开口后几秒内输入框就有字、说话途中文字持续刷新、冷启动段由实时 API 出字并在模型就绪后切到本地。
// 按量 Key 取自本机 bl CLI 配置（只经环境变量传给隔离实例，不落盘）。合成语音只证明链路与时序，不代表真人识别率。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { localPaths, localInstalled } = require('../core/local-asr/manager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const vram = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString().trim());
const vramTotal = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.total', '--format=csv,noheader,nounits'], { windowsHide: true }).toString().trim());

function synth(file, text) {
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Huihui Desktop');
$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);
$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}',$f); $s.Speak('${text}'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
  return fs.readFileSync(file).subarray(44);
}
function wavFile(file, pcm) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(16000, 24); h.writeUInt32LE(32000, 28); h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, pcm]));
}

async function main() {
  if (!localInstalled(localPaths({}))) throw new Error('本机未安装本地识别环境或模型');
  const acp = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub', 'config.json'), 'utf8').replace(/^﻿/, '')).acp || {};
  if (!acp.apiKey) throw new Error('生产 config.json 没有 Token Plan 套餐 Key');
  const meteredKey = (fs.readFileSync(path.join(os.homedir(), '.bailian', 'config.json'), 'utf8').match(/"(sk-[A-Za-z0-9]+)"/) || [])[1];
  if (!meteredKey) throw new Error('本机 bl CLI 未配置按量 Key，无法测实时接力');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-local-'));
  const out = path.resolve('artifacts/20261006-live-voice-claude1/live-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { apiKey: acp.apiKey, baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }));
  const project = cwd.toLowerCase().replace(/\\/g, '/');
  fs.writeFileSync(path.join(data, 'voice-input.json'), JSON.stringify({ region: 'beijing', profiles: { [project]: { terms: '作手林铛\n昨日之我\n初心投研\nSuperRAN\nClaude', context: '' } } }));
  const home = path.join(root, 'codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const a = synth(path.join(root, 'a.wav'), '我刚在作手林铛里看了初心投研的报告，又用昨日之我查了上周的会话。');
  const b = synth(path.join(root, 'b.wav'), '下午再让 Claude 检查 SuperRAN 的仿真结果，重点看信道估计。');
  const gap = Buffer.alloc(38400);
  // 约 50 秒：前几段在模型装好前说完（Token Plan 接力），后几段应走本地。
  const audioFile = path.join(root, 'mic.wav');
  wavFile(audioFile, Buffer.concat([Buffer.alloc(16000), a, gap, b, gap, a, gap, b, gap, a, gap, b, Buffer.alloc(32000)]));
  const audioSeconds = (fs.statSync(audioFile).size - 44) / 32000;
  const baseVram = vram();
  // 显卡被别的程序占着、剩余不足 5.6GB 时，预期不装本地模型、全部 Token Plan 且不拖慢（验证显存保护）。
  // E2E_FORCE_GPU_BUSY=1 时把装载门槛调到超过显卡容量，模拟显卡被占满。
  const forceBusy = process.env.E2E_FORCE_GPU_BUSY === '1';
  const gpuBusy = forceBusy || vramTotal() - baseVram < 5600;
  const evidence = { passed: false, checks: [], out, audioSeconds, baseVram, kind: 'Real isolated Hub; WAV-file microphone (Huihui TTS); REAL local Qwen3-ASR on GPU + REAL Token Plan relay' };
  let hub, cdp;
  const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
  const snap = async name => { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'voice-live', entryPath: path.join(__dirname, 'fixtures/voice-tokenplan-hub.js'), extraEnv: {
      DASHSCOPE_API_KEY: meteredKey, HUB_VOICE_TEST_WAV: audioFile, CODEX_HOME: home, HUB_LOCAL_ASR_IDLE_MS: '15000', ...(forceBusy ? { HUB_LOCAL_ASR_MIN_FREE_MB: '99999' } : {}),
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    cdp = await connectFirstPage(hub);
    await until('typeof sessions !== "undefined"', 'renderer');
    const opts = { cwd, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const s = await cdp.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({ kind: 'codex', opts }) + ')');
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state === "idle"', 'session idle');
    await cdp.eval('showTerminal(' + JSON.stringify(s.id) + ')');
    const mic = '.floating-input-bar .voice-mic', box = '.floating-input-bar .floating-input-box', status = '.floating-input-bar .composer-status .voice-status';
    await until('document.querySelector(' + JSON.stringify(mic) + ')', 'microphone');
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true}))');
    await until('document.querySelector(".voice-settings-dialog select")?.value === "local"', 'settings default engine local');
    await snap('settings'); evidence.checks.push('已安装本地识别时，设置默认「本地识别」并显示本地状态');
    await cdp.eval('[...document.querySelectorAll(".voice-settings-dialog button")].find(b=>b.textContent==="关闭").click()');
    await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').focus()');
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    const t0 = Date.now();
    await until('document.querySelector(' + JSON.stringify(mic) + ').textContent === "停止"', 'recording started');
    // 录音期间每 200ms 记录输入框文字：第一次出字时间、刷新次数
    const timeline = [];
    while (Date.now() - t0 < audioSeconds * 1000 + 500) {
      const text = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
      if (!timeline.length || timeline.at(-1).text !== text) timeline.push({ at: (Date.now() - t0) / 1000, text });
      await sleep(200);
    }
    evidence.firstTextAtSec = timeline.find(x => x.text.length > 0)?.at;
    evidence.updates = timeline.length;
    evidence.timeline = timeline.map(x => `${x.at.toFixed(1)}s ${x.text.length}字 ${x.text.slice(-24)}`);
    evidence.fullTimeline = timeline;
    // 不应出现「同一句短暂显示两遍再缩回」：录音期间字数回缩不超过 8 字（定稿措辞微调允许少量回缩）
    evidence.maxShrink = timeline.reduce((m, x, i) => i ? Math.max(m, timeline[i - 1].text.length - x.text.length) : m, 0);
    assert(evidence.maxShrink <= 8, '录音中文字回缩过多，疑似重复显示：' + evidence.maxShrink);
    evidence.loadedVram = vram();
    const stopAt = Date.now();
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("语音输入完成")', 'done status', 60000);
    evidence.stopToFinalSec = (Date.now() - stopAt) / 1000;
    evidence.finalText = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    evidence.status = await cdp.eval('document.querySelector(' + JSON.stringify(status) + ').textContent');
    await snap('final');
    const ledger = fs.readFileSync(path.join(data, 'voice-usage.jsonl'), 'utf8').trim().split('\n').map(l => JSON.parse(l));
    evidence.ledger = ledger.map(l => `${l.via}:${l.sec}s`);
    evidence.gpuBusy = gpuBusy;
    if (gpuBusy) {
      assert(ledger.every(l => l.via !== 'local'), '显存不足时不应走本地');
      assert(evidence.stopToFinalSec < 10, '显存不足时也不应拖慢：' + evidence.stopToFinalSec);
      assert(/显存不足/.test(hub.log().join(' ')), '日志应说明显存不足');
    } else {
      assert(ledger.some(l => l.via === 'local'), '至少一段应走本地');
      assert(ledger.some(l => l.via === 'realtime'), '冷启动应由实时 API 接力');
      assert(evidence.status.includes('本地'), '完成提示应说明本地识别段数：' + evidence.status);
    }
    for (const word of ['作手林铛', '昨日之我', 'SuperRAN']) assert(evidence.finalText.includes(word), `缺少「${word}」：${evidence.finalText}`);
    assert(evidence.firstTextAtSec < 4, '开口后 4 秒内应出字（音频开头有 1 秒静音）：' + evidence.firstTextAtSec);
    assert(evidence.updates >= 15, '说话途中文字应持续刷新：' + evidence.updates);
    evidence.checks.push(`第 ${evidence.firstTextAtSec.toFixed(1)} 秒出字（音频开头 1 秒静音）；录音期间刷新 ${evidence.updates} 次；停止后 ${evidence.stopToFinalSec.toFixed(1)} 秒完成；${evidence.status}；术语正确`);
    if (!gpuBusy) assert(evidence.loadedVram - baseVram > 3000, `模型应在显卡（基线 ${baseVram}MB，录音中 ${evidence.loadedVram}MB）`);
    // 空闲 15 秒（测试设定）后释放显存
    const end = Date.now() + 45000; let now = vram();
    while (Date.now() < end && now - baseVram > 1000) { await sleep(1000); now = vram(); }
    evidence.releasedVram = now;
    assert(now - baseVram <= 1000, `空闲后显存应释放（基线 ${baseVram}MB，现在 ${now}MB）`);
    evidence.checks.push(`显存：基线 ${baseVram}MB → 录音中 ${evidence.loadedVram}MB → 空闲到时 ${now}MB`);
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) { try { await snap('last'); } catch (error) { evidence.captureError = error.message; } await cdp.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.rmSync(path.join(data, 'config.json'), { force: true });
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
