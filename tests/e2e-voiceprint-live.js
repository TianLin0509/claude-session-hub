'use strict';
// 真实端到端（声纹过滤）：隔离 Hub + WAV 当麦克风 + 设置面板里真实录入声纹（真实 ERes2Net）+ Token Plan 识别。
// 麦克风内容：先是「本人」朗读（用于录入），随后一段本人说话中间夹着他人插话；验收他人那句不进输入框。
// 合成语音（edge-tts 两个不同声音）只证明链路与判定，不代表真人在嘈杂环境的效果。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { localPaths, localInstalled } = require('../core/local-asr/manager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
const vram = () => Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { windowsHide: true }).toString().trim());

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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-local-'));
  const out = path.resolve('artifacts/20261005-voiceprint-claude1/live-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'config.json'), JSON.stringify({ acp: { apiKey: acp.apiKey, baseURL: 'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1' } }));
  const project = cwd.toLowerCase().replace(/\\/g, '/');
  fs.writeFileSync(path.join(data, 'voice-input.json'), JSON.stringify({ region: 'beijing', profiles: { [project]: { terms: 'SRS\nE2E', context: '' } }, engine: process.env.E2E_ENGINE || 'tokenplan' }));
  const home = path.join(root, 'codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const A = 'C:/AIWork/20261005-声纹过滤实验-claude1/audio/';
  const clip = name => fs.readFileSync(A + name + '.wav').subarray(44);
  const pause = sec => Buffer.alloc(Math.round(sec * 16000) * 2);
  const me = n => clip('zh-CN-YunxiNeural_' + n), other = n => clip('zh-CN-YunjianNeural_' + n);
  // 他人只说 t2（会议纪要）、t5（吃面），本人从不说这两句，便于判定
  const enrollPart = Buffer.concat([me('enroll'), pause(0.4), me('t1'), pause(0.4), me('t3'), pause(0.4), me('t4')]);
  const testPart = Buffer.concat([pause(1), me('t4'), pause(0.5), other('t5'), pause(0.5), me('t1'), pause(1.2), me('t3'), pause(0.5), other('t2'), pause(0.5), me('t4'), pause(2)]);
  const audioFile = path.join(root, 'mic.wav');
  wavFile(audioFile, Buffer.concat([enrollPart, testPart]));
  const audioSeconds = (fs.statSync(audioFile).size - 44) / 32000;
  const baseVram = vram();
  const evidence = { passed: false, checks: [], out, audioSeconds, baseVram, kind: 'Real isolated Hub; WAV-file microphone (edge-tts voices); REAL voiceprint enrollment (ERes2Net) + REAL Token Plan ASR' };
  let hub, cdp;
  const until = async (expr, label, ms = 30000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
  const snap = async name => { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'voiceprint', entryPath: path.join(__dirname, 'fixtures/voice-tokenplan-hub.js'), extraEnv: {
      DASHSCOPE_API_KEY: (fs.readFileSync(path.join(os.homedir(), '.bailian', 'config.json'), 'utf8').match(/"(sk-[A-Za-z0-9]+)"/) || [])[1] || '', HUB_VOICE_TEST_WAV: audioFile, CODEX_HOME: home, 
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
    await until('document.querySelector(".voice-voiceprint button")?.textContent === "录入声纹"', 'voiceprint section');
    await snap('settings-before');
    const vpButton = '[...document.querySelectorAll(".voice-voiceprint button")].find(b=>/录入|读完/.test(b.textContent))';
    await cdp.eval(vpButton + '.click()');
    await until('document.querySelector(".voice-voiceprint-script") && !document.querySelector(".voice-voiceprint-script").hidden', 'reading script shown');
    await cdp.eval('document.querySelector(".voice-voiceprint").scrollIntoView({block:"center"})'); await snap('enrolling');
    await until('/正在录音 (1[7-9]|2\\d) 秒/.test(document.querySelector(".voice-voiceprint").textContent)', 'record 17s', 40000);
    await cdp.eval(vpButton + '.click()');
    await until('/录入成功/.test(document.querySelector(".voice-voiceprint").textContent)', 'enrolled', 60000);
    const vpText = await cdp.eval('document.querySelector(".voice-voiceprint").textContent');
    assert(fs.existsSync(path.join(data, 'voiceprint.json')), '应写入 voiceprint.json');
    assert.equal(await cdp.eval('document.querySelector(".voice-voiceprint input[type=checkbox]").checked'), true);
    await cdp.eval('document.querySelector(".voice-voiceprint").scrollIntoView({block:"center"})'); await snap('enrolled'); evidence.checks.push('设置面板录入声纹成功：' + vpText.replace(/\s+/g, ' ').slice(0, 80));
    await cdp.eval('[...document.querySelectorAll(".voice-settings-dialog button")].find(b=>b.textContent==="关闭").click()');
    await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').focus()');
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    await until('document.querySelector(' + JSON.stringify(mic) + ').textContent === "停止"', 'recording started');
    await sleep(Math.round((enrollPart.length + testPart.length) / 32 + 1500)); // 实测每次开麦文件从头放：录满整个文件
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("语音输入完成")', 'done status', 60000);
    evidence.finalText = await cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    evidence.status = await cdp.eval('document.querySelector(' + JSON.stringify(status) + ').textContent');
    await snap('final');
    const ledger = fs.readFileSync(path.join(data, 'voice-usage.jsonl'), 'utf8').trim().split(/\r?\n/).map(l => JSON.parse(l));
    evidence.ledger = ledger.map(l => ({ via: l.via, sec: l.sec, scores: l.scores, removed: l.removed }));
    assert(/先别合入/.test(evidence.finalText), '本人的话应保留：' + evidence.finalText);
    assert(!/吃面|会议纪要/.test(evidence.finalText), '他人插话不应进输入框：' + evidence.finalText);
    assert(/已滤掉他人说话/.test(evidence.status), '完成提示应说明滤掉段数：' + evidence.status);
    evidence.checks.push('本人说话中间夹他人插话：' + evidence.status + '；输入框只有本人的话');
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
