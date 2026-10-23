'use strict';
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const out = path.resolve(process.argv[2] || 'output/20261023-meeting-e2e-codex');
const port = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
(async () => {
  fs.mkdirSync(out, { recursive: true }); let hub, c; const result = { checks: [], realDesktopCapture: false, audio: 'synthetic browser stream; physical devices not verified' };
  try {
    const temp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'meeting-e2e-'));
    hub = await launchIsolatedHub({ ...(process.env.MEETING_TEST_ENTRY ? { entryPath: process.env.MEETING_TEST_ENTRY } : {}), ...(process.env.MEETING_TEST_EXE ? { executablePath: process.env.MEETING_TEST_EXE } : {}), dataDir: path.join(temp, 'data'), port: await port(), windowMode: 'background', label: 'meeting-companion', extraEnv: { CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_ASSISTANT_TIMER: '0', CLAUDE_HUB_FORUM_TIMER: '0' }, extraArgs: ['--use-fake-ui-for-media-stream'] });
    c = await connectFirstPage(hub);
    const until = async (expr, label, timeout = 30000) => { const start = Date.now(); while (Date.now() - start < timeout) { if (await c.eval(expr)) return; await _waitMs(200); } throw new Error('timeout ' + label + ': ' + await c.eval('document.querySelector("[data-m=message]")?.textContent')); };
    await until('!!document.getElementById("btn-company-assistant")', 'assistant');
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await c.eval('document.getElementById("btn-company-assistant").click()');
    await until('!!document.querySelector("[data-ca=meeting]")', 'meeting entry');
    await c.eval('document.querySelector("[data-ca=meeting]").click()');
    await until('document.querySelector("[data-m=source]")?.options.length>0', 'sources');
    assert.ok(await c.eval('document.querySelector(".company-meeting").getBoundingClientRect().height>600'));
    result.checks.push('真实隔离 Hub 助理入口、来源枚举、1440×900 布局');
    await c.eval('document.title="meeting-companion-test-native"'); await _waitMs(500);
    // Obtain one frame through the actual desktop capture API from this test window only.
    result.nativeCapture = await c.eval(`(async()=>{const s=await ipcRenderer.invoke('company-assistant:meeting-sources'); const own=s.sources.find(x=>/meeting-companion/i.test(x.name)) || s.sources.find(x=>x.id.startsWith('screen:')); if(!own)return {ok:false,reason:'isolated window not enumerated'}; try{const stream=await navigator.mediaDevices.getUserMedia({video:{mandatory:{chromeMediaSource:'desktop',chromeMediaSourceId:own.id}},audio:{mandatory:{chromeMediaSource:'desktop'}}}); const v=document.createElement('video');v.muted=true;v.srcObject=stream;await v.play();await new Promise(r=>setTimeout(r,500));const answer={ok:v.videoWidth>0,width:v.videoWidth,height:v.videoHeight,audioTracks:stream.getAudioTracks().length};stream.getTracks().forEach(t=>t.stop());return answer;}catch(e){return {ok:false,reason:e.message};}})()`);
    result.realDesktopCapture = result.nativeCapture.ok;
    // Controlled slide/audio source exercises renderer capture -> real IPC -> disk.
    await c.eval(`(()=>{window.meetingCanvas=document.createElement('canvas');meetingCanvas.width=960;meetingCanvas.height=540;window.drawMeetingSlide=(title)=>{const x=meetingCanvas.getContext('2d');x.fillStyle='white';x.fillRect(0,0,960,540);x.fillStyle='#233044';x.font='44px sans-serif';x.fillText(title,70,100);x.fillStyle='#3478f6';x.fillRect(70,170,title.includes('B')?600:300,100);};drawMeetingSlide('方案 A · 高负载对比');window.testAudio=new AudioContext();const o=testAudio.createOscillator();const d=testAudio.createMediaStreamDestination();o.connect(d);o.start();window.originalMeetingGetMedia=navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);navigator.mediaDevices.getUserMedia=async opts=>opts.video?new MediaStream([...meetingCanvas.captureStream(5).getVideoTracks(),...d.stream.getAudioTracks().map(t=>t.clone())]):new MediaStream(d.stream.getAudioTracks().map(t=>t.clone()));})();`);
    await c.eval('document.querySelector("[data-m=title]").value="会议伴侣端到端验证";document.querySelector("[data-act=start]").click()');
    await c.eval('window.testDrawTimer=setInterval(()=>drawMeetingSlide("方案 A · 高负载对比"),200)');
    await until('document.querySelector("[data-m=progress]").textContent.includes("采集中")', 'recording');
    const id = await c.eval('(async()=>{const r=await ipcRenderer.invoke("company-assistant:meeting-status",{});return r.meetings[0].id})()');
    await c.eval(`ipcRenderer.invoke('company-assistant:meeting-control',{id:${JSON.stringify(id)},op:'auto',value:false})`);
    await _waitMs(3000); await c.eval('clearInterval(testDrawTimer);testDrawTimer=setInterval(()=>drawMeetingSlide("方案 B · 统一基线再比较"),200)');
    await until(`(async()=>{const r=await ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}}); return r.meeting.events.filter(e=>e.kind==='slide').length>=2})()`, 'automatic second slide');
    await c.eval('document.querySelector("[data-m=note]").value="需要补测";document.querySelector("[data-act=mark]").click()'); await _waitMs(500);
    await c.eval('document.querySelector("[data-act=pause]").click()');
    await until('document.querySelector("[data-m=progress]").textContent.startsWith("已暂停")', 'pause');
    let status = await c.eval(`ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}})`);
    assert.ok(status.meeting.events.filter(e => e.kind === 'slide').length >= 2);
    assert.equal(status.meeting.events.filter(e => e.kind === 'audio').length, 2, 'pause flushes both tracks');
    assert.ok(status.meeting.events.some(e => e.kind === 'mark' && e.text === '需要补测'));
    result.checks.push('合成画面翻页触发截图、重点、双音轨 WAV、暂停刷新末段到磁盘');
    await c.eval('document.querySelector("[data-act=pause]").click()'); await _waitMs(1000); await c.eval('document.querySelector("[data-act=stop]").click()');
    await until('document.querySelector("[data-m=progress]").textContent.startsWith("已结束")', 'stop');
    const meetingFile = path.join(temp, 'data', 'company-assistant', 'workspace', 'meetings', id, 'meeting.json');
    const fixture = JSON.parse(fs.readFileSync(meetingFile, 'utf8'));
    fixture.summary = '## 界面验收示例（非模型回答）\n先统一基线，再补测。 [事件 2]\n\n负责人和截止日期尚未明确。'; fixture.revision = 1;
    fs.writeFileSync(meetingFile, JSON.stringify(fixture));
    await until('!!document.querySelector("[data-m=summary] [data-event]")', 'clickable citation');
    await c.eval('document.querySelector("[data-m=summary] [data-event]").click()'); await until('!!document.querySelector(".meeting-slide")', 'evidence');
    const shot = await c.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, '20261023-meeting-1440-codex.png'), Buffer.from(shot.data, 'base64'));
    status = await c.eval(`ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}})`); result.events = status.meeting.events.map(e => ({ kind: e.kind, at: e.at, track: e.track }));
    result.checks.push('继续采集、结束刷新末段、真实界面点击纪要出处回看（纪要为界面测试夹具）'); result.passed = true;
    await c.eval('clearInterval(testDrawTimer);testAudio.close(); navigator.mediaDevices.getUserMedia=originalMeetingGetMedia');
  } finally { if (hub) await gracefulQuit(hub); fs.writeFileSync(path.join(out, '20261023-meeting-e2e-codex.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result)); }
})().catch(e => { console.error(e); process.exitCode = 1; });
