'use strict';
// Explicit live subscription test: real Codex PTY, isolated auth copy and a
// read-only snapshot of recent natural-language history. Never touches production state.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), crypto = require('node:crypto'), assert = require('node:assert/strict');
const { DatabaseSync } = require('node:sqlite');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { SqliteSessionSearchIndex } = require('../core/session-search-sqlite-index');
const { auditCitations } = require('../core/hub-assistant/context');
const { hashPacket } = require('../core/hub-assistant/snapshots');
const { assistantContextDisplay } = require('../core/assistant-context-display');
const { frozenSnapshotOutputs } = require('./helpers/assistant-native-evidence');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const port = () => new Promise(resolve => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const j = JSON.stringify;
function snapshotHistory(destination) {
  const source = new DatabaseSync(path.join(os.homedir(), '.claude-session-hub/cache/session-search-v3.sqlite'), { readOnly: true });
  const now = Date.now(), groups = new Map();
  try {
    source.exec('PRAGMA query_only=ON;BEGIN');
    const rows = source.prepare(`SELECT d.*,s.provider,s.title,s.native_session_id,s.hub_session_id FROM docs d JOIN sessions s ON s.key=d.session_key JOIN sources z ON z.key=s.source_key WHERE d.scope IN ('user','assistant') AND d.event_id<>'last-output-preview' AND d.timestamp>=? AND d.timestamp<=? AND z.searchable=1 AND z.stale=0 AND s.provider<>'meeting' ORDER BY d.timestamp DESC LIMIT 120`).all(now - 24 * 3600000, now);
    for (const row of rows) { if (!groups.has(row.session_key)) groups.set(row.session_key, []); groups.get(row.session_key).push(row); }
  } finally { source.exec('ROLLBACK'); source.close(); }
  const target = new SqliteSessionSearchIndex(destination);
  let messages = 0, chars = 0;
  try {
    for (const [key, rows] of groups) {
      const first = rows[0]; messages += rows.length; chars += rows.reduce((n, row) => n + row.text.length, 0);
      target.replaceSource({ key: first.source_key, signature: 'live-readonly-snapshot-' + now,
        session: { key, provider: first.provider, title: first.title, updatedAt: first.timestamp, nativeSessionId: first.native_session_id, hubSessionId: first.hub_session_id },
        docs: rows.map(row => ({ eventId: row.event_id, scope: row.scope, role: row.role, text: row.text, timestamp: row.timestamp, ordinal: row.ordinal })) });
    }
  } finally { target.close(); }
  return { capturedAt: now, sessions: groups.size, messages, chars, limit: 120, scope: '最近24小时最多120条已入库自然问答的只读快照；不是全部历史' };
}
function rollouts(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? rollouts(path.join(root, entry.name)) : entry.name.endsWith('.jsonl') ? [path.join(root, entry.name)] : []);
}
function nativeRecord(home, id) {
  const file = rollouts(path.join(home, 'sessions')).find(file => file.includes(id));
  if (!file) return null;
  const records = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
  const finals = records.filter(row => row.type === 'response_item' && row.payload?.role === 'assistant' && row.payload?.phase === 'final_answer').map(row => ({ at: row.timestamp, text: (row.payload.content || []).map(item => item.text || '').join('') }));
  return { file, finals, records };
}
async function main() {
  const started = Date.now();
  const out = path.resolve('artifacts/assistant-tab-real', new Date().toISOString().replace(/[:.]/g, '-'));
  // Native Codex refuses helper executables below Windows Temp. This remains a
  // fully private test tree; the launcher exception is bounded by these paths.
  const root = path.join(out, 'private-run');
  const data = path.join(root, 'data'), home = path.join(root, 'home'), codexHome = path.join(home, 'codex'), workspace = path.join(root, 'workspaces');
  for (const dir of [out, data, home, codexHome, workspace]) fs.mkdirSync(dir, { recursive: true });
  const production = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-session-hub/config.json'), 'utf8'));
  const profile = production.providers?.codex?.subscription_profiles?.find(profile => profile.id === 'second' && profile.label === '主账号');
  if (!profile) throw Error('未找到明确的主账号 second');
  const sourceAuth = path.join(profile.home, 'auth.json'), beforeHash = hash(sourceAuth);
  const historyFile = path.join(data, 'assistant-history-snapshot.sqlite');
  const pasteFallback = process.argv.includes('--paste-fallback');
  const result = { passed: false, root, out, runtime: 'real Codex PTY', inputTransport: pasteFallback ? 'explicit HUB_CODEX_EDITOR_INPUT=0 standard PTY paste fallback' : 'default Codex editor-input', profile: profile.id, model: 'gpt-6-astra', checks: [], history: snapshotHistory(historyFile) };
  let hub, cdp, assistantId;
  const until = async (label, read, ms = 120000) => { for (const end = Date.now() + ms; Date.now() < end;) { const value = await read(); if (value) return value; await wait(350); } throw Error('timeout: ' + label); };
  const click = async selector => { await until('clickable ' + selector, () => cdp.eval(`document.querySelector(${j(selector)}) && !document.querySelector(${j(selector)}).disabled`), 30000); const point = await cdp.eval(`(()=>{const el=document.querySelector(${j(selector)});el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`); for (const type of ['mousePressed','mouseReleased']) await cdp.send('Input.dispatchMouseEvent', { type, ...point, button: 'left', clickCount: 1 }); };
  const shot = async name => { const value = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(value.data, 'base64')); };
  const session = async () => cdp.eval(`JSON.parse(JSON.stringify(sessions.get(${j(assistantId)})))`);
  const terminalText = sid => cdp.eval(`(()=>{const t=terminalCache.get(${j(sid)})?.terminal;if(!t)return '';const b=t.buffer.active;return Array.from({length:t.rows},(_,i)=>b.getLine(b.viewportY+i)?.translateToString(true)||'').join(String.fromCharCode(10));})()`);
  const send = async text => { const selector = `.floating-input-bar[data-session-id="${assistantId}"]`; await click(selector + ' .floating-input-box'); await cdp.send('Input.insertText', { text }); await click(selector + ' .floating-input-send'); };
  try {
    fs.copyFileSync(sourceAuth, path.join(codexHome, 'auth.json'));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), `model = "gpt-6-astra"\nmodel_reasoning_effort = "high"\n[projects.'${path.resolve(workspace).toLowerCase()}']\ntrust_level = "trusted"\n[projects.'${path.resolve('.').toLowerCase()}']\ntrust_level = "trusted"\n`, 'utf8');
    fs.writeFileSync(path.join(data, 'config.json'), j({ models: { defaults: { codex: 'gpt-6-astra' } }, providers: { codex: { backend: 'subscription', subscription_profile: 'second', subscription_profiles: [{ id: 'second', label: '主账号', home: codexHome }] } } }));
    for (const directory of [data, home, codexHome, workspace]) assert.ok(path.resolve(directory).startsWith(path.resolve(root) + path.sep));
    hub = await launchIsolatedHub({ dataDir: data, port: await port(), label: 'assistant-live-pty', windowMode: 'background', allowExternalState: true, extraEnv: {
      CLAUDE_HUB_E2E: '1', CLAUDE_HUB_ASSISTANT_HISTORY_DB: historyFile,
      CLAUDE_HUB_HOME_DIR: home, CLAUDE_CONFIG_DIR: path.join(home, 'claude'), CODEX_HOME: codexHome, CODEX_SQLITE_HOME: '',
      HUB_CODEX_PROFILE: '', HUB_CODEX_BACKEND: 'subscription', CLAUDE_HUB_AGENT_RUNTIME: 'pty',
      HUB_CODEX_EDITOR_INPUT: pasteFallback ? '0' : '1',
      CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: '', CLAUDE_HUB_NATIVE_FIXTURE_STORE: '', CLAUDE_HUB_NATIVE_FIXTURE_TRACE: '',
      OPENAI_API_KEY: '', CODEX_API_KEY: '', DEEPSEEK_API_KEY: '', AI_HUB_WORKSPACE_ROOT: workspace,
      HUB_SESSION_SEARCH_CODEX_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'empty'),
      HUB_SESSION_SEARCH_KIMI_ROOTS: path.join(root, 'empty'), HUB_SESSION_SEARCH_GEMINI_ROOTS: path.join(root, 'empty'),
    } });
    result.pid = hub.pid; cdp = await connectFirstPage(hub);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
    await until('renderer ready', () => cdp.eval('typeof assistantPanel!=="undefined"'));
    await click('#btn-assistant'); await click('[data-assistant-action="open"]');
    assistantId = await until('ordinary assistant input', () => cdp.eval('activeSessionId && document.querySelector(".floating-input-box") && activeSessionId'));
    result.assistantId = assistantId;
    const initial = await session(); result.runtimeObserved = initial.agentRuntime; result.effort = initial.effort;
    assert.equal(initial.agentRuntime, 'pty'); assert.equal(initial.purpose, 'hub-assistant'); assert.equal(initial.codexProfile, 'second');
    await until('Codex TUI ready', async () => { const text = await terminalText(assistantId); return /OpenAI Codex \(v/.test(text) && /Ask Codex to do anything/.test(text) && !/Folder access|Trust this folder|Do you trust/i.test(text); }, 90000);
    await shot('01-pty-ready'); result.checks.push('真实界面启用主账号 Codex，运行模式确认 PTY，普通输入框可用');
    await cdp.eval(`window.__assistantLiveReceipts=[];window.__assistantReceiptEvents=[];ipcRenderer.on('session:prompt-receipt',(_event,receipt)=>window.__assistantReceiptEvents.push({at:Date.now(),receipt}));const originalInvoke=ipcRenderer.invoke.bind(ipcRenderer);ipcRenderer.invoke=(channel,...args)=>{const operation=originalInvoke(channel,...args);if(channel==='session:send-prompt')operation.then(receipt=>window.__assistantLiveReceipts.push(receipt),error=>window.__assistantLiveReceipts.push({error:error.message}));return operation;};`);
    const question = '请根据本轮提供的近期工作记录，用白话汇报最近24小时最重要的两项变化，以及我现在需要做什么。每项给出材料引用，限180字。';
    const submissionStartedAt = Date.now();
    await send(question);
    const first = await until('native final answer', async () => { const s = await session(); const record = nativeRecord(codexHome, s.codexSid); return record?.finals.length ? { s, record } : null; }, 180000);
    result.nativeId = first.s.codexSid; result.transcriptPath = first.record.file;
    const answer = first.record.finals.at(-1).text; fs.writeFileSync(path.join(out, 'recent-answer.txt'), answer, 'utf8');
    const user = first.record.records.filter(row => row.type === 'response_item' && row.payload?.role === 'user').at(-1);
    const text = (user?.payload?.content || []).map(item => item.text || '').join('');
    const display = assistantContextDisplay(text, 'hub-assistant');
    assert.equal(display?.userText, question, '原生收到用户原话且信封完整');
    assert.ok(text.length < 2048, '正常问题应通过短请求提交');
    const envelope = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('[/AI_HUB_ASSISTANT_CONTEXT_V1]')).trim());
    assert.equal(envelope.history.manifestOnly, true);
    const frozen = JSON.parse(fs.readFileSync(path.join(data, 'assistant', 'snapshots', envelope.history.requestToken + '.json'), 'utf8'));
    const db = new DatabaseSync(path.join(data, 'assistant', 'assistant.sqlite'), { readOnly: true });
    let manifest; try { manifest = JSON.parse(db.prepare('SELECT value FROM meta WHERE key=?').get('snapshot:' + envelope.history.requestToken).value).manifest; } finally { db.close(); }
    const exactPrepared = require('../core/hub-assistant/context').buildBootstrapPrompt(question, manifest, 0);
    assert.equal(text, exactPrepared, '原生用户正文必须与宿主本轮短请求逐字相同');
    await until('ordinary UI submit receipt', () => cdp.eval('window.__assistantLiveReceipts.length>0'), 30000);
    result.submitReceipt = await cdp.eval('window.__assistantLiveReceipts[0]');
    await until('final ordinary UI delivery confirmed', () => cdp.eval(`floatingPromptDeliveries.get(${j(assistantId)})?.status==='confirmed'`), 30000);
    result.receiptEvents = await cdp.eval('window.__assistantReceiptEvents');
    result.finalUiDelivery = await cdp.eval(`JSON.parse(JSON.stringify(floatingPromptDeliveries.get(${j(assistantId)}) || null))`);
    assert.equal(result.submitReceipt?.ok, true); assert.equal(result.finalUiDelivery?.status, 'confirmed');
    assert.equal(result.finalUiDelivery.clientSubmissionId, result.submitReceipt.receipt.clientSubmissionId);
    const confirmedEvent = result.receiptEvents.find(event => event.receipt.clientSubmissionId === result.finalUiDelivery.clientSubmissionId && event.receipt.status === 'confirmed');
    assert.ok(confirmedEvent, '必须观察到本次提交的确定回执广播');
    result.confirmationLatencyMs = confirmedEvent.at - submissionStartedAt;
    result.initialRpcStatus = result.submitReceipt.receipt.status;
    result.initialUnknownDurationMs = result.receiptEvents.some(event => event.receipt.status === 'unconfirmed') ? confirmedEvent.at - result.receiptEvents.find(event => event.receipt.status === 'unconfirmed').at : 0;
    assert.equal(await cdp.eval(`!!document.querySelector(${j('.floating-input-bar[data-session-id="' + assistantId + '"] .fi-stuck')})`), false);
    const nativeTools = frozenSnapshotOutputs(first.record.records, envelope.history.requestToken);
    result.deliveryAudit = { bootstrapChars: text.length, frozenSources: frozen.packet.sources.length, frozenChars: frozen.packet.selectedChars, completeNativeToolOutputs: nativeTools.length, packetHash: frozen.packetHash };
    assert.equal(envelope.history.packetHash, frozen.packetHash);
    assert.equal(envelope.history.sourceCount, frozen.packet.sources.length);
    assert.equal(envelope.history.selectedChars, frozen.packet.selectedChars);
    assert.equal(hashPacket(frozen.packet), frozen.packetHash);
    const completeNativeTools = nativeTools.filter(tool => hashPacket(tool.packet) === frozen.packetHash);
    assert.ok(completeNativeTools.length > 0, '原生落盘必须有完整 MCP 冻结资料返回，不能只凭宿主已读取或模型另打印的分页摘要');
    result.deliveryAudit.completeNativeToolOutputs = completeNativeTools.length;
    result.deliveryAudit.additionalDerivedOutputs = nativeTools.length - completeNativeTools.length;
    for (const tool of completeNativeTools) {
      assert.equal(tool.snapshotReceipt.packetHash, frozen.packetHash);
      assert.equal(hashPacket(tool.packet), frozen.packetHash);
      assert.deepEqual(tool.packet, frozen.packet, 'MCP 原生返回每条来源及正文必须与宿主冻结资料逐字一致');
    }
    fs.writeFileSync(path.join(out, 'submitted-manifest.json'), j(envelope), 'utf8');
    fs.writeFileSync(path.join(out, 'native-snapshot-receipt.json'), j(completeNativeTools.at(-1).snapshotReceipt), 'utf8');
    result.deliveryAudit.completeDelivery = true;
    result.audit = auditCitations(answer, completeNativeTools.at(-1).packet); result.answerChars = answer.length;
    assert.ok(result.audit.cited.length > 0); assert.equal(result.audit.invalid.length, 0);
    if (await cdp.eval('document.getElementById("btn-backstage")?.getAttribute("aria-pressed")==="true"')) await click('#btn-backstage');
    await until('answer visible', () => cdp.eval('document.querySelectorAll(".turn-card.assistant").length>0'), 30000);
    assert.ok(await cdp.eval(`document.querySelector('.msg-overlay')?.textContent.includes(${j(answer.slice(0, 20))})`), '原生回答正文在普通卡片可见');
    await shot('02-real-answer'); result.checks.push('短请求完整落盘，MCP 冻结资料原生返回与宿主逐字一致；真实回答卡片可见且引用有效');
    result.readOnlyPassed = true;
    if (!process.argv.includes('--read-only')) {
      await until('first turn complete hook', async () => { const s = await session(); return s.status !== 'running' && !require('../core/session-runtime-truth').sessionRuntimeIsActive(s); }, 30000);
      const title = '助理真实验收目标-' + Date.now(), marker = 'HUB_ASSISTANT_TARGET_OK';
      await send(`请新建一个 Codex 会话，标题为「${title}」，交给它的唯一任务是回复「${marker}」。执行后告诉我目标会话标识及消息送达状态。`);
      const created = await until('created target', () => cdp.eval(`([...sessions.values()].find(s=>s.id!==${j(assistantId)} && (s.title===${j(title)} || s.name===${j(title)})) || null)`), 180000);
      result.targetId = created.id;
      const target = await until('target native reply', async () => { const s = await cdp.eval(`sessions.get(${j(created.id)})`); const r = nativeRecord(codexHome, s?.codexSid); return r?.finals.some(item => item.text.includes(marker)) ? { s, r } : null; }, 180000);
      result.targetNativeId = target.s.codexSid; result.targetTranscriptPath = target.r.file;
      fs.writeFileSync(path.join(out, 'target-answer.txt'), target.r.finals.at(-1).text, 'utf8');
      const actions = await cdp.eval('ipcRenderer.invoke("assistant:actions")');
      result.actions = actions.actions; assert.ok(actions.actions.some(action => action.state === 'acknowledged'));
      await shot('03-real-delegation'); result.checks.push('同界面委托创建隔离目标，真实目标回复落盘，Hub 动作账本收到确认回执');
      result.delegationPassed = true;
    }
    result.passed = true;
  } catch (error) { result.error = error.stack; process.exitCode = 1; if (cdp) { await shot('failure').catch(() => {}); if (assistantId) fs.writeFileSync(path.join(out, 'terminal.txt'), await terminalText(assistantId).catch(() => ''), 'utf8'); } }
  finally {
    if (cdp) cdp.close();
    if (hub) { fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'), 'utf8'); result.exit = await gracefulQuit(hub, { timeoutMs: 60000 }); }
    fs.rmSync(path.join(codexHome, 'auth.json'), { force: true }); result.authUnchanged = hash(sourceAuth) === beforeHash;
    if (!result.authUnchanged) { result.passed = false; process.exitCode = 1; }
    result.elapsedMs = Date.now() - started; fs.writeFileSync(path.join(out, 'result.json'), JSON.stringify(result, null, 2), 'utf8'); console.log(j(result));
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
