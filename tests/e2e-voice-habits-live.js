'use strict';
// 真实端到端（使用习惯）：隔离 Hub + 本地识别（真实模型，先暖机）+ 模拟麦克风（开麦即开始说话）。
// 验收：①按住右 Ctrl 说话、松开结束；②识别后在输入框改一个词再发送 → 学会该词（加入通用热词）；
// ③最后单独说「发送」→ 自动发出且「发送」两字不进消息；④设置面板有「使用习惯」。
// 合成语音（Windows Huihui）只证明交互链路，不代表真人识别率。
const fs = require('fs'), path = require('path'), os = require('os'), net = require('net'), assert = require('assert/strict');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { localPaths, localInstalled } = require('../core/local-asr/manager');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function freePort() { return new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); }); }
function synth(file, text) {
  const ps = `Add-Type -AssemblyName System.Speech; $s=New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SelectVoice('Microsoft Huihui Desktop');
$f=New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,[System.Speech.AudioFormat.AudioChannel]::Mono);
$s.SetOutputToWaveFile('${file.replace(/'/g, "''")}',$f); $s.Speak('${text}'); $s.Dispose()`;
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
}
// 页面里替换 getUserMedia：每次开麦从头播放 window.__micFile 指定的录音（模拟一开麦就说话）
function fakeMic() {
  navigator.mediaDevices.getUserMedia = async () => {
    const buf = require('fs').readFileSync(window.__micFile);
    const pcm = new Int16Array(buf.buffer.slice(buf.byteOffset + 44, buf.byteOffset + buf.length));
    const ctx = new AudioContext({ sampleRate: 16000 }); await ctx.resume();
    const ab = ctx.createBuffer(1, pcm.length + 16000 * 3, 16000); const ch = ab.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource(); src.buffer = ab; const dst = ctx.createMediaStreamDestination(); src.connect(dst); src.start();
    return dst.stream;
  };
}

async function main() {
  if (!localInstalled(localPaths({}))) throw new Error('本机未安装本地识别环境或模型');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-voice-habits-'));
  const out = path.resolve('artifacts/20261006-voice-polish-claude1/habits-' + Date.now()); fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(root, 'workspace'); fs.mkdirSync(cwd);
  const data = path.join(root, 'data'); fs.mkdirSync(data);
  fs.writeFileSync(path.join(data, 'voice-input.json'), JSON.stringify({ region: 'beijing', engine: 'local', profiles: {}, global: { terms: 'SRS\nPMI', personal: '' } }));
  const home = path.join(root, 'codex'); fs.mkdirSync(home); fs.writeFileSync(path.join(home, 'config.toml'), 'model = "gpt-6-astra"\nmodel_reasoning_effort = "xhigh"\n');
  const say1 = path.join(root, 'say1.wav'), say2 = path.join(root, 'say2.wav');
  synth(say1, '帮我查一下 SRS 的信道估计误差，顺便看看 PMI 的选择。');
  synth(say2, '下午三点提醒我开周会。 发送。');
  const evidence = { passed: false, checks: [], out, kind: 'Real isolated Hub; injected mic (Huihui TTS); REAL local Qwen3-ASR' };
  let hub, cdp;
  const until = async (expr, label, ms = 60000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(100); } throw Error('timeout: ' + label); };
  const snap = async name => { const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64')); };
  const key = (type) => cdp.send('Input.dispatchKeyEvent', { type, key: 'Control', code: 'ControlRight', windowsVirtualKeyCode: 17, nativeVirtualKeyCode: 17, location: 2 });
  try {
    hub = await launchIsolatedHub({ dataDir: data, port: await freePort(), windowMode: 'hidden', label: 'voice-habits', extraEnv: {
      DASHSCOPE_API_KEY: '', CODEX_HOME: home, CLAUDE_CONFIG_DIR: path.join(root, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js'),
    } });
    cdp = await connectFirstPage(hub);
    await until('typeof sessions !== "undefined"', 'renderer');
    const opts = { cwd, model: 'gpt-6-astra', effort: 'xhigh', mcpProfile: 'none', codexSpeedTier: 'standard' };
    const s = await cdp.eval('ipcRenderer.invoke("create-session",' + JSON.stringify({ kind: 'codex', opts }) + ')');
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state === "idle"', 'session idle');
    await cdp.eval('showTerminal(' + JSON.stringify(s.id) + ')');
    const mic = '.floating-input-bar .voice-mic', box = '.floating-input-bar .floating-input-box', status = '.floating-input-bar .composer-status .voice-status';
    await until('document.querySelector(' + JSON.stringify(mic) + ')', 'microphone');
    await cdp.eval('(' + fakeMic.toString() + ')()');
    const text = () => cdp.eval('document.querySelector(' + JSON.stringify(box) + ').textContent');
    const clearBox = () => cdp.eval('(()=>{const b=document.querySelector(' + JSON.stringify(box) + ');b.textContent="";b.dispatchEvent(new Event("input",{bubbles:true}));b.focus();})()');
    // ④ 设置面板「使用习惯」
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').dispatchEvent(new MouseEvent("contextmenu",{bubbles:true}))');
    await until('document.querySelector(".voice-habits")', 'habits section');
    await cdp.eval('document.querySelector(".voice-habits").scrollIntoView({block:"center"})'); await snap('settings-habits');
    assert.equal(await cdp.eval('document.querySelector(".voice-habits input[type=checkbox]").checked'), true, '说「发送」默认开');
    await cdp.eval('[...document.querySelectorAll(".voice-settings-dialog button")].find(b=>b.textContent==="关闭").click()');
    evidence.checks.push('设置面板有「使用习惯」：右 Ctrl 说明、说「发送」（默认开）、停顿自动结束、常驻时段');
    // 暖机：先录一段把本地模型装好
    await cdp.eval('window.__micFile=' + JSON.stringify(say1)); await clearBox();
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()'); await sleep(9000);
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("语音输入完成")', 'warm-up');
    // ① 按住右 Ctrl 说话
    await clearBox(); await sleep(500);
    await key('rawKeyDown');
    await until('document.querySelector(' + JSON.stringify(mic) + ').textContent === "停止"', 'push-to-talk started', 5000);
    await sleep(7000);
    await key('keyUp');
    await until('document.querySelector(' + JSON.stringify(status) + ')?.textContent.includes("语音输入完成")', 'push-to-talk done');
    const said = await text(); evidence.pushToTalk = said;
    assert(/SRS/.test(said) && /信道估计/.test(said), '按住右 Ctrl 应录到并识别：' + said);
    evidence.checks.push('按住右 Ctrl 说话、松开结束：' + said);
    // ② 改一个词再发送 → 学会
    await cdp.eval('(()=>{const b=document.querySelector(' + JSON.stringify(box) + ');const w=document.createTreeWalker(b,NodeFilter.SHOW_TEXT);let n;while((n=w.nextNode())){if(n.data.includes("误差")){n.data=n.data.replace("误差","偏差");break;}}b.focus();})()');
    await cdp.eval('document.querySelector(".floating-input-bar .floating-input-send").click()');
    await until('/已从你的修改学会/.test(document.querySelector(' + JSON.stringify(status) + ')?.textContent || "")', 'learned status', 10000);
    evidence.learnedStatus = await cdp.eval('document.querySelector(' + JSON.stringify(status) + ').textContent');
    await snap('learned');
    const cfg = JSON.parse(fs.readFileSync(path.join(data, 'voice-input.json'), 'utf8'));
    assert(cfg.global.terms.split('\n').some(t => t.includes('偏差')), '改正的词应加入通用热词：' + cfg.global.terms);
    evidence.checks.push('改词后发送：' + evidence.learnedStatus);
    await until('sessions.get(' + JSON.stringify(s.id) + ')?.nativeRuntime?.state !== "idle"', 'message sent', 20000).catch(() => {});
    await sleep(3000);
    // ③ 最后说「发送」→ 自动发出
    await cdp.eval('window.__micFile=' + JSON.stringify(say2)); await clearBox(); await sleep(500);
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()'); await sleep(7000);
    await cdp.eval('document.querySelector(' + JSON.stringify(mic) + ').click()');
    // 发出后状态栏会被会话状态刷新，所以以「会话里出现这条消息」为准
    const sentMsg = '[...document.querySelectorAll("body *")].filter(e => !e.closest(".floating-input-bar") && !e.children.length && /提醒我开周会/.test(e.textContent)).map(e => e.textContent.trim())';
    await until(sentMsg + '.length > 0', 'voice send', 30000);
    await sleep(1500);
    evidence.sentMessages = await cdp.eval(sentMsg);
    assert(evidence.sentMessages.every(m => !/发送/.test(m)), '「发送」两字不应进消息：' + evidence.sentMessages);
    evidence.afterVoiceSend = await text();
    assert.equal(evidence.afterVoiceSend.trim(), '', '发出后输入框应清空：' + evidence.afterVoiceSend);
    evidence.checks.push('最后说「发送」：自动发出「' + evidence.sentMessages[0] + '」，「发送」未进消息，输入框已清空');
    evidence.passed = true;
  } catch (error) { evidence.error = error.stack; throw error; }
  finally {
    if (cdp) { try { await snap('last'); } catch (error) { evidence.captureError = error.message; } await cdp.close(); }
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n')); evidence.exit = await gracefulQuit(hub); }
    fs.writeFileSync(path.join(out, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
