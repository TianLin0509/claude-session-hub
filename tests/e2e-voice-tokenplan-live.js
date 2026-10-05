'use strict';
// 真实端到端：隔离 Hub + Chromium 用 WAV 文件当麦克风 + 真实 Token Plan 识别（消耗少量套餐额度）。
// 合成语音来自 Windows Huihui，只证明链路与切段时序，不代表真人口音的识别率。
// 用法：node tests/e2e-voice-tokenplan-live.js（需要生产 config.json 里有 Token Plan 套餐 Key，只读复制到隔离目录）
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }

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
  const prodConfig = path.join(os.homedir(), '.claude-session-hub', 'config.json');
  const acp = JSON.parse(fs.readFileSync(prodConfig, 'utf8').replace(/^﻿/, '')).acp || {};
  if (!acp.apiKey) throw new Error('生产 config.json 没有 Token Plan 套餐 Key，无法做真实识别');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-plan-'));
  const out = path.resolve('artifacts/20261004-voice-tokenplan-claude1/live-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { apiKey: acp.apiKey, baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }));
  const project = cwd.toLowerCase().replace(/\\/g, '/');
  fs.writeFileSync(path.join(data, 'voice-input.json'), JSON.stringify({ region: 'beijing', profiles: { [project]: { terms: '作手林铛\n昨日之我\ngrill-me\nSuperRAN', context: '' } } }));
  const home = path.join(root, 'codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  // 两句话中间留 1.2 秒停顿：第一段应在录音进行中就写进输入框。
  const a = synth(path.join(root, 'a.wav'), '我刚在作手林铛里看了初心投研的报告，又用昨日之我查了上周的会话，然后让同事跑一遍 grill-me。');
  const b = synth(path.join(root, 'b.wav'), '下午再让 Claude 检查 SuperRAN 的仿真结果。');
  const audioFile = path.join(root, 'mic.wav');
  wavFile(audioFile, Buffer.concat([Buffer.alloc(16000), a, Buffer.alloc(38400), b, Buffer.alloc(32000)]));
  const audioSeconds = (fs.statSync(audioFile).size - 44) / 32000;
  const evidence = { passed: false, checks: [], out, audioSeconds, kind: 'Real isolated Hub; WAV-file microphone (Huihui TTS); REAL Token Plan ASR' };
  let hub, cdp;
  const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
  const snap = async name => { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'voice-tokenplan', entryPath: path.join(__dirname, 'fixtures/voice-tokenplan-hub.js'), extraEnv: {
      DASHSCOPE_API_KEY: '', HUB_VOICE_TEST_WAV: audioFile, CODEX_HOME: home,
      CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    cdp = await connectFirstPage(hub);
    await until('typeof sessions !== "undefined"', 'renderer');
    const opts = { cwd, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const s = await cdp.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({ kind: 'codex', opts }) + ')');
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state === "idle"', 'session idle');
    await cdp.eval('showTerminal(' + JSON.stringify(s.id) + ')');
    const mic = '.floating-input-bar .voice-mic', box = '.floating-input-bar .floating-input-box';
    await until('document.querySelector(' + JSON.stringify(mic) + ')', 'microphone');
    // 设置面板：默认「说完再识别 · Token Plan」，术语来自本项目。
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true}))');
    await until('document.querySelector(".voice-settings-dialog select")?.value === "tokenplan"', 'settings default engine');
    const settings = await cdp.eval('document.querySelector(".voice-settings-dialog").innerText');
    assert(settings.includes('qwen-audio-3.0-asr-flash') && settings.includes('已找到 Token Plan 套餐 Key'), settings);
    await snap('settings'); evidence.checks.push('设置面板默认「说完再识别 · Token Plan」，显示套餐 Key 状态与模型');
    await cdp.eval('[...document.querySelectorAll(".voice-settings-dialog button")].find(b=>b.textContent==="关闭").click()');
    await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').focus()');
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    const t0 = Date.now();
    await until('document.querySelector(' + JSON.stringify(mic) + ').textContent === "停止"', 'recording started');
    await until('document.querySelector(' + JSON.stringify(box) + ').textContent.length > 10', 'first segment while recording', 40000);
    evidence.firstSegmentAtSec = (Date.now() - t0) / 1000;
    evidence.firstSegmentText = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    assert.equal(await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').textContent'), '停止', '第一段应在录音进行中出现');
    await snap('recording-partial'); evidence.checks.push(`录音进行中第 ${evidence.firstSegmentAtSec.toFixed(1)} 秒，第一段文字已写进输入框`);
    const remaining = audioSeconds * 1000 - (Date.now() - t0) + 500;
    if (remaining > 0) await sleep(remaining);
    const stopAt = Date.now();
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    await until('document.querySelector(' + JSON.stringify(mic) + ').textContent !== "停止" && /SuperRAN/i.test(document.querySelector(' + JSON.stringify(box) + ').textContent)', 'final text', 30000);
    evidence.stopToFinalSec = (Date.now() - stopAt) / 1000;
    const text = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    evidence.finalText = text;
    for (const word of ['作手林铛', '昨日之我', 'SuperRAN']) assert(text.includes(word), `缺少「${word}」：${text}`);
    await snap('final'); evidence.checks.push(`停止后 ${evidence.stopToFinalSec.toFixed(1)} 秒补上最后一段；项目术语「作手林铛」「昨日之我」「SuperRAN」识别正确`);
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) { try { await snap('last'); } catch (error) { evidence.captureError = error.message; } await cdp.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.rmSync(path.join(data, 'config.json'), { force: true }); // 不在临时目录残留套餐 Key
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
