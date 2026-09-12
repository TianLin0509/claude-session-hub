'use strict';
// Actual Hub views and protocol child processes. Never inject renderer state.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const ROOT = path.resolve(__dirname, '..');
const provider = process.argv.find(v => v.startsWith('--provider='))?.split('=')[1] || 'claude';
assert.ok(['claude', 'codex'].includes(provider));
const scenario = process.argv.find(v => v.startsWith('--scenario='))?.split('=')[1] || 'approval';
const view = process.argv.find(v => v.startsWith('--view='))?.split('=')[1] || 'group';
assert.ok(['group', 'session'].includes(view));
const scenarios = {
  approval: { claude: 'approval', codex: 'approval' },
  failed: { claude: 'error-result', codex: 'failed', state: 'failed' },
  empty: { claude: 'empty-result', codex: 'empty', state: 'completed' },
  interrupted: { claude: 'hold', codex: 'hold', state: 'interrupted' },
  disconnected: { claude: 'crash-on-user', codex: 'crash-before', state: 'unknown' },
};
const target = scenarios[scenario]; assert.ok(target, 'known scenario required');
const labels = { waiting: '等待你的回复', completed: '已答', failed: '错误|失败',
  interrupted: '已中断|已被你停止', unknown: '待核对' };
async function freePort() {
  const server = net.createServer(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function main() {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-consumers-'));
  const out = path.join(ROOT, 'artifacts/native-agent', `consumers-${provider}-${scenario}-${view}-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  const cwd = path.join(temp, 'workspace'); fs.mkdirSync(cwd);
  const result = { provider, scenario, view, temp, out, head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    controlledProtocol: true, realModel: false, checks: [], passed: false, cleanupErrors: [], rendererErrors: [] };
  let hub, client, meeting;
  const until = async (label, expression) => {
    const end = Date.now() + 30000;
    while (Date.now() < end) { const value = await client.eval(expression); if (value) return value; await _waitMs(50); }
    throw new Error('Timeout: ' + label);
  };
  const shot = async name => {
    const image = await client.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(image.data, 'base64'));
  };
  const groupSnapshot = () => client.eval(`({
    state: [...sessions.values()].filter(s=>${JSON.stringify(meeting.subSessions)}.includes(s.id)).map(s=>({id:s.id,r:s.nativeRuntime})),
    roster:[...document.querySelectorAll('.mr-gc-msg.ai .mr-gc-meta')].map(e=>e.innerText),
    cards:[...document.querySelectorAll('.mr-ft-status')].map(e=>({text:e.innerText,cls:e.className})),
    lanes:[...document.querySelectorAll('.mr-turn-lane-meta')].map(e=>e.innerText),
    text:document.querySelector('.mr-gc-shell')?.innerText,
    home:{active:document.getElementById('home-metric-active')?.innerText,waiting:document.getElementById('home-metric-waiting')?.innerText},
    homeSnapshot:homeWorkbench?.getSnapshot?.()
  })`);
  async function verifySession(slot) {
    const session = await client.eval(`ipcRenderer.invoke('create-session',${JSON.stringify({kind:provider,opts:{...slot,cwd,title:'原生单会话状态验收',userRenamed:true}})})`);
    const sid = JSON.stringify(session.id);
    await until('native session ready', `sessions.get(${sid})?.nativeRuntime?.connection==='connected'`);
    await client.eval(`selectSession(${sid})`);
    await until('actual composer', '!!document.querySelector(".floating-input-box")');
    await client.eval(`(()=>{
      const id=${sid},provider=${JSON.stringify(provider)};
      window.sessionConsumerTiming={samples:[],pending:[],seen:new Set()};const trace=sessionConsumerTiming;
      function sample(){for(const p of trace.pending){if(p.done)continue;
        const header=document.querySelector('.terminal-crumb-dot')?.dataset.runtimeState;
        const sidebar=document.querySelector('.session-item[data-session-id="'+id+'"]')?.dataset.runtimeState;
        const composer=document.querySelector('.composer')?.dataset.state;
        const expected=p.state==='waiting'?'waiting':p.state==='unknown'?(provider==='claude'?'waiting':'dead')
          :p.state==='failed' && provider==='claude'?'dead':'ready';
        const match=header===p.state && sidebar===p.state && composer===expected;
        if(match || Date.now()-p.at>1100){p.done=true;trace.samples.push({...p,header,sidebar,composer,expected,match,latencyMs:Date.now()-p.at});}
      }}
      ipcRenderer.on('session-updated',(_e,{session:s})=>{
        const r=s.nativeRuntime;if(s.id!==id || !r || !['waiting','completed','failed','interrupted','unknown'].includes(r.state))return;
        const key=[r.epoch,r.turnId,r.state].join(':');if(trace.seen.has(key))return;trace.seen.add(key);
        trace.pending.push({id,state:r.state,at:r.observedAt,epoch:r.epoch,revision:r.revision});sample();
      });
      new MutationObserver(sample).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});setInterval(sample,25);
    })()`);
    await client.eval('document.querySelector(".floating-input-box").focus()');
    await client.send('Input.insertText',{text:`fixture:${target.codex} 验证同一原生状态到侧栏、输入栏和标题`});
    await client.eval('document.querySelector(".floating-input-send").click()');
    if(scenario==='interrupted'){
      await until('active native turn',`['running','starting'].includes(sessions.get(${sid}).nativeRuntime.state)`);
      // The ordinary composer exposes the real provider stop action.
      await until('composer stop button','!!document.querySelector(".floating-input-stop")');
      await client.eval('document.querySelector(".floating-input-stop").click()');
    }
    const expected=target.state || 'waiting';
    await until('observed native state',`sessions.get(${sid}).nativeRuntime.state===${JSON.stringify(expected)}`);
    await _waitMs(1250);
    result.sessionTiming=await client.eval('sessionConsumerTiming.samples');
    const times=result.sessionTiming.filter(row=>row.state===expected);
    assert.equal(times.length,1,JSON.stringify(result.sessionTiming));
    assert.ok(times.every(row=>row.match && row.latencyMs<=1000),JSON.stringify(times));
    await shot('session-'+scenario);
    result.checks.push(`visible sidebar, header and composer converge to ${expected} within 1 second of Main event`);
    await client.eval('escapeToHome()');
    const refreshAt=Date.now();
    await client.eval('document.getElementById("home-refresh").click()');
    await until('home refresh state',`!document.getElementById('home-refresh').disabled && document.getElementById('home-metric-waiting').innerText===${JSON.stringify(expected==='waiting'?'1':'0')}`);
    result.homeRefreshMs=Date.now()-refreshAt;
    result.home=await client.eval('homeWorkbench.getSnapshot()');
    assert.equal(await client.eval(`sessions.get(${sid}).nativeRuntime.state`),expected);
    await shot('home-'+scenario);
    result.checks.push('actual home refresh retains the same native state and correct waiting count');
    if(scenario==='approval'){
      await client.eval(`selectSession(${sid})`);
      const selector=provider==='claude'?'.claude-native-controls button[type=button]':'.codex-native-controls button';
      await until('approval controls',`!!document.querySelector(${JSON.stringify(selector)})`);
      await client.eval(`(()=>{const buttons=[...document.querySelectorAll(${JSON.stringify(selector)})];const button=${provider==='claude'?'buttons[0]':'buttons.find(b=>/拒绝/.test(b.innerText))'};if(!button)throw Error('decline missing');button.click();})()`);
      await until('exact approval completed',`sessions.get(${sid}).nativeRuntime.state==='completed'`);
      await _waitMs(1250);result.sessionTiming=await client.eval('sessionConsumerTiming.samples');
      assert.ok(result.sessionTiming.some(row=>row.state==='completed' && row.match && row.latencyMs<=1000),JSON.stringify(result.sessionTiming));
      result.checks.push('actual decline completes the exact native turn; all visible session consumers converge');
    }
  }
  async function verifyTerminal() {
    const ids = JSON.stringify(meeting.subSessions), expected = JSON.stringify(target.state);
    if (scenario === 'interrupted') {
      await until('both submissions active', `${ids}.every(id=>['starting','running'].includes(sessions.get(id)?.nativeRuntime?.state))`);
      await until('actual group stop action', '!!document.querySelector("[data-gc-stop-turn]")');
      await client.eval('document.querySelector("[data-gc-stop-turn]").click()');
    }
    await until('exact terminal snapshots', `${ids}.every(id=>sessions.get(id)?.nativeRuntime?.state===${expected})`);
    await _waitMs(1250); // Retain failed convergence samples; never extend the 1 s gate.
    result.terminal = await groupSnapshot();
    result.timing = await client.eval('consumerTiming.samples');
    await shot('group-' + scenario);
    assert.equal(result.terminal.lanes.length, 2);
    assert.ok(result.terminal.lanes.every(text=>new RegExp(labels[target.state]).test(text)), JSON.stringify(result.terminal));
    if (target.state === 'unknown') {
      assert.ok(result.terminal.roster.every(text=>/待核对/.test(text)), 'unknown is not a failed model result');
      assert.equal(await client.eval('document.querySelectorAll("[data-gc-retry-answer]").length'), 0, 'reconcile before retry');
      assert.equal(await client.eval('document.querySelectorAll(".mr-turn-lane [data-gc-open-session]").length'), 2, 'open exact member to reconcile');
      assert.ok(!result.terminal.text.includes('PTY 可能已正常作答'), 'native unknown must not give terminal extraction advice');
    }
    const times = result.timing.filter(row=>row.state===target.state);
    assert.equal(times.length, 2, JSON.stringify(result.timing));
    assert.ok(times.every(row=>row.match && row.latencyMs<=1000), JSON.stringify(times));
    result.checks.push(`exact ${target.state} reaches both group lanes within 1 second`);
    if (target.state === 'unknown') {
      await client.eval('document.querySelector(".mr-turn-lane [data-gc-open-session]").click()');
      await until('reconciliation action opens exact member', `activeSessionId===${JSON.stringify(meeting.subSessions[0])} && !!document.querySelector('.composer')`);
      result.checks.push('actual reconciliation button opens the exact member without sending');
    }
    await client.eval('escapeToHome()');
    await until('home waiting cleared', 'document.getElementById("home-metric-waiting")?.innerText==="0"');
    result.home = await groupSnapshot(); await shot('home-' + scenario);
    await client.eval('document.getElementById("home-refresh").click()');
    await until('refresh keeps terminal', `!document.getElementById('home-refresh').disabled && ${ids}.every(id=>sessions.get(id)?.nativeRuntime?.state===${expected})`);
    result.checks.push(`actual home refresh preserves ${target.state}; waiting count stays zero`);
    result.sessions = [];
    for (const id of meeting.subSessions) {
      await client.eval(`selectSession(${JSON.stringify(id)})`);
      const composerState = target.state==='unknown' ? (provider==='claude'?'waiting':'dead')
        : provider==='claude' && target.state==='failed' ? 'dead' : 'ready';
      await until('member terminal composer', `document.querySelector('.composer')?.dataset.state===${JSON.stringify(composerState)}`);
      const projection = await client.eval(`({id:${JSON.stringify(id)},runtime:sessions.get(${JSON.stringify(id)}).nativeRuntime,
        header:document.querySelector('.terminal-crumb-dot')?.dataset.runtimeState,
        composer:document.querySelector('.composer')?.dataset.state,text:document.querySelector('.composer')?.innerText})`);
      result.sessions.push(projection);
      assert.equal(projection.header, target.state, JSON.stringify(projection));
      await shot('session-' + scenario + '-' + result.sessions.length);
    }
    result.checks.push('member header and composer preserve terminal after navigation');
  }
  try {
    hub = await launchIsolatedHub({ dataDir: path.join(temp, 'data'), port: await freePort(), windowMode: 'hidden', label: 'native-consumers',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: path.join(temp, 'home'), CLAUDE_CONFIG_DIR: path.join(temp, 'claude'),
        CODEX_HOME: path.join(temp, 'codex'), DEEPSEEK_API_KEY: '',
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(ROOT, 'tests/fixtures/claude-stream.js'),
        CLAUDE_HUB_CLAUDE_FIXTURE_MODE: target.claude,
        CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(ROOT, 'tests/fixtures/codex-app-server.js') } });
    client = await connectFirstPage(hub);
    client.ws.on('message', data => {
      const message = JSON.parse(data.toString());
      if (message.method === 'Runtime.exceptionThrown') result.rendererErrors.push(message.params.exceptionDetails);
    });
    await client.send('Runtime.enable');
    await until('renderer', 'typeof sessions!=="undefined" && !!window.MeetingRoom');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await client.eval(`window.consumerEvents=[];ipcRenderer.on('session-updated',(_e,{session:s})=>{if(s.nativeRuntime)consumerEvents.push({id:s.id,...s.nativeRuntime});});`);
    const slot = provider === 'claude' ? {kind:'claude',model:'claude-opus-5[1m]',effort:'max',mcpProfile:'lean',fastMode:false}
      : {kind:'codex',model:'gpt-6-astra',effort:'xhigh',mcpProfile:'none',codexSpeedTier:'inherit'};
    if(view==='session'){
      await verifySession(slot);result.events=await client.eval('consumerEvents');
      assert.deepEqual(result.rendererErrors,[]);result.passed=true;return;
    }
    meeting = await client.eval(`ipcRenderer.invoke('create-meeting',${JSON.stringify({ title: '原生状态全视图验证', scene: 'general', workspace: cwd, slots: [slot, slot] })})`);
    assert.equal(meeting.subSessions.length, 2);
    const ids = JSON.stringify(meeting.subSessions);
    await until('members ready', `${ids}.every(id=>sessions.get(id)?.nativeRuntime?.connection==='connected')`);
    await client.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(meeting.id)},${JSON.stringify(meeting)})`);
    await until('group composer', '!!document.querySelector("#mr-input-box")');
    await client.eval(`(() => {
      const ids=${ids}, labels=${JSON.stringify(labels)};window.consumerTiming={pending:[],samples:[],seen:new Map()};const trace=consumerTiming;
      const visible=e=>!!e && e.getClientRects().length>0;
      function sample(){for(const p of trace.pending){if(p.done)continue;
        const lane=document.querySelector('[data-turn-lane-sid="'+p.id+'"] .mr-turn-lane-meta');
        const text=lane?.innerText||'';
        const home=document.getElementById('home-metric-waiting');
        const homeChecked=visible(home);
        const homeExpected=ids.some(id=>sessions.get(id)?.nativeRuntime?.state==='waiting')?'1':'0';
        const homeActual=home?.innerText;
        const match=new RegExp(labels[p.state]).test(text) && (!homeChecked || homeActual===homeExpected);
        if(match || Date.now()-p.at>1100){p.done=true;trace.samples.push({...p,text,homeChecked,homeExpected,homeActual,match,latencyMs:Date.now()-p.at});}
      }}
      ipcRenderer.on('session-updated',(_e,{session:s})=>{const r=s.nativeRuntime;
        if(!ids.includes(s.id) || !r || !Object.hasOwn(labels,r.state))return;
        const key=[r.epoch,r.turnId,r.state].join(':');if(trace.seen.get(s.id)===key)return;trace.seen.set(s.id,key);
        if(visible(document.querySelector('.mr-gc-shell')))trace.pending.push({id:s.id,state:r.state,at:r.observedAt,epoch:r.epoch,revision:r.revision});sample();
      });
      new MutationObserver(sample).observe(document.body,{subtree:true,childList:true,attributes:true,characterData:true});setInterval(sample,25);
    })()`);
    await client.eval('document.querySelector("#mr-input-box").focus()');
    await client.send('Input.insertText', { text: `fixture:${target.codex} 两位分别处理这条消息。` });
    await client.eval('document.querySelector("#mr-send-btn").click()');
    if (target.state) {
      await verifyTerminal();
    } else {
    await until('both wait', `${ids}.every(id=>sessions.get(id)?.nativeRuntime?.state==='waiting')`);
    await _waitMs(2100); // Cross the former 1.5 s polling tick; waiting must remain waiting.
    result.waiting = await groupSnapshot(); await shot('group-waiting');
    assert.equal(result.waiting.roster.length, 2);
    assert.ok(result.waiting.roster.every(text => /等待你的回复/.test(text)), JSON.stringify(result.waiting));
    assert.equal(result.waiting.lanes.length, 2);
    assert.ok(result.waiting.lanes.every(text => /等待你的回复/.test(text)), JSON.stringify(result.waiting.lanes));
    result.timing = await client.eval('consumerTiming.samples');
    const waitingTimes = result.timing.filter(row=>row.state==='waiting');
    assert.equal(waitingTimes.length, 2);
    assert.ok(waitingTimes.every(row=>row.match && row.latencyMs<=1000), JSON.stringify(waitingTimes));
    result.checks.push('both group member statuses show native approval waiting');
    await client.eval('escapeToHome()');
    await until('home waiting', 'document.getElementById("home-metric-waiting")?.innerText==="1"');
    result.homeWaiting = await client.eval('({active:document.getElementById("home-metric-active").innerText,waiting:document.getElementById("home-metric-waiting").innerText})');
    await shot('home-waiting');
    await client.eval('document.getElementById("home-refresh").click()');
    await until('home refresh preserves pending approvals', `!document.getElementById('home-refresh').disabled && document.getElementById('home-metric-waiting').innerText==='1' && ${ids}.every(id=>sessions.get(id)?.nativeRuntime?.state==='waiting')`);
    await shot('home-refreshed'); result.checks.push('actual home refresh preserves both pending approvals and one meeting count');
    for (const id of meeting.subSessions) {
      await client.eval(`selectSession(${JSON.stringify(id)})`);
      const selector = provider === 'claude' ? '.claude-native-controls button[type=button]' : '.codex-native-controls button';
      await until('approval controls', `!!document.querySelector(${JSON.stringify(selector)})`);
      if (provider === 'claude') await client.eval(`document.querySelector(${JSON.stringify(selector)}).click()`);
      else await client.eval(`(()=>{const b=[...document.querySelectorAll('.codex-native-controls button')].find(e=>/拒绝/.test(e.innerText));if(!b)throw Error('missing decline');b.click();})()`);
      await until('member completed', `sessions.get(${JSON.stringify(id)})?.nativeRuntime?.state==='completed'`);
    }
    await client.eval(`window.MeetingRoom.openMeeting(${JSON.stringify(meeting.id)},${JSON.stringify(meeting)})`);
    await until('completed roster', `[...document.querySelectorAll('.mr-turn-lane-meta')].length===2 && [...document.querySelectorAll('.mr-turn-lane-meta')].every(e=>/已答/.test(e.innerText))`);
    result.completed = await groupSnapshot(); await shot('group-completed');
    await client.eval('escapeToHome()');
    await until('home completion', 'document.getElementById("home-metric-waiting")?.innerText==="0"');
    // Home "active" counts awake sessions, not running turns.
    assert.equal(await client.eval('document.getElementById("home-metric-active").innerText'), '2');
    await shot('home-completed'); result.checks.push('home clears waiting after both exact member completions; awake session count stays two');
    }
    result.events = await client.eval('consumerEvents');
    assert.deepEqual(result.rendererErrors, []);
    result.passed = true;
  } catch (error) {
    result.error = error.stack;
    if (client) try { result.failure = meeting ? await groupSnapshot() : await client.eval('document.body.innerText'); await shot('failure'); }
    catch (captureError) { result.captureError = captureError.message; }
    throw error;
  } finally {
    if (client) try { await client.close(); } catch (error) { result.cleanupErrors.push(error.message); }
    if (hub) try { result.exit = await gracefulQuit(hub); }
    catch (error) { result.cleanupErrors.push(error.message); result.termination = error.termination; result.teardownLog = error.logTail; }
    finally { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'), 'utf8'); }
    if (result.cleanupErrors.length) { result.passed = false; process.exitCode = 1; }
    fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ out, passed: result.passed, checks: result.checks, error: result.error, cleanupErrors: result.cleanupErrors }));
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
