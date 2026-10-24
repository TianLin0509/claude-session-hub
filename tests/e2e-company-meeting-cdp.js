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
    if(process.env.MEETING_RECORDING_TEST==='1') await until(`(async()=>{const r=await ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}});return r.meeting.recording?.segments.some(s=>s.status==='ready')&&r.meeting.recording.segments.length>=2})()`,'rolling independently playable video segments',45000);
    await c.eval('document.querySelector("[data-m=note]").value="需要补测";document.querySelector("[data-act=mark]").click()'); await _waitMs(500);
    await c.eval('document.querySelector("[data-act=pause]").click()');
    await until('document.querySelector("[data-m=progress]").textContent.startsWith("已暂停")', 'pause');
    let status = await c.eval(`ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}})`);
    assert.ok(status.meeting.events.filter(e => e.kind === 'slide').length >= 2);
    assert.ok(['system','mic'].every(track=>status.meeting.events.some(e=>e.kind==='audio'&&e.track===track)), 'pause flushes both tracks');
    assert.ok(status.meeting.events.some(e => e.kind === 'mark' && e.text === '需要补测'));
    result.checks.push('合成画面翻页触发截图、重点、双音轨 WAV、暂停刷新末段到磁盘');
    await c.eval('document.querySelector("[data-act=pause]").click()'); await _waitMs(1000); await c.eval('document.querySelector("[data-act=stop]").click()');
    await until('document.querySelector("[data-m=progress]").textContent.startsWith("已结束")', 'stop');
    if(process.env.MEETING_RECORDING_TEST==='1') {
      status=await c.eval(`ipcRenderer.invoke('company-assistant:meeting-status',{id:${JSON.stringify(id)}})`);
      result.recording=status.meeting.recording;
      assert.ok(result.recording.segments.length>=3);assert.ok(result.recording.segments.every(s=>s.status==='ready'));assert.ok(result.recording.gaps.length>=1);
      const frames=await c.eval(`ipcRenderer.invoke('company-assistant:meeting-frames',{id:${JSON.stringify(id)},timesMs:[1500,6000,31000]})`);
      assert.equal(frames.frames.length,3);assert.ok(frames.frames.every(f=>f.width===960&&f.height===540&&f.data.length>1000));
      assert.notEqual(frames.frames[0].data,frames.frames[1].data,'different video moments recover different slide content');
      const colors=await c.eval(`Promise.all(${JSON.stringify(frames.frames.slice(0,2).map(f=>f.data))}.map(data=>new Promise(resolve=>{const im=new Image();im.onload=()=>{const x=document.createElement('canvas');x.width=960;x.height=540;const ctx=x.getContext('2d');ctx.drawImage(im,0,0);resolve([...ctx.getImageData(500,200,1,1).data]);};im.src='data:image/jpeg;base64,'+data;})))`);
      assert.ok(colors[0][0]>220&&colors[1][0]<100,'first frame has A short bar; later frame has B long blue bar');
      result.frameTimes=frames.frames.map(({at,requestedMs,width,height})=>({at,requestedMs,width,height}));
      const crop=await c.eval(`ipcRenderer.invoke('company-assistant:meeting-frames',{id:${JSON.stringify(id)},timesMs:[6000],crop:{x:0,y:0,w:0.5,h:0.5}})`);assert.equal(crop.frames[0].width,480);
      await c.eval('document.querySelector("[data-m=seek-seconds]").value="1.5";document.querySelector("[data-act=play]").click()');
      await until('document.querySelector("[data-m=player]").currentTime>1.6&&!document.querySelector("[data-m=player]").paused','real video playing with advancing clock');
      result.replayAudioTracks=await c.eval('document.querySelector("[data-m=player]").captureStream().getAudioTracks().length');assert.equal(result.replayAudioTracks,1,'recorded video includes mixed playback audio');
      await c.eval('document.querySelector("[data-m=player]").pause();document.querySelector("[data-m=seek-seconds]").value="31";document.querySelector("[data-act=play]").click()');
      await until('document.querySelector("[data-m=play-time]").textContent==="00:31"','cross segment timeline seek');
      await c.eval('document.querySelector("[data-m=player]").pause();document.querySelector("[data-act=extract]").click()');
      await until('document.querySelector("[data-m=evidence]").textContent.includes("录像回查")','UI extracts video frame');
      const gap=result.recording.gaps[0];
      const rejected=await c.eval(`ipcRenderer.invoke('company-assistant:meeting-playback',{id:${JSON.stringify(id)},at:${Math.round((gap.at+gap.end)/2)}}).then(r=>r.ok===false,()=>true)`);assert.ok(rejected,'pause gap cannot masquerade as recording');
      result.checks.push('真实WebM编码、跨30秒分段回放、暂停缺口、三时刻抽帧、裁切与界面回查通过（受控音视频源）');
    }
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
