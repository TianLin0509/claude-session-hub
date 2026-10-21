'use strict';
// Real Claude Haiku + independent WeLink fixture, NOT company CodeAgent/live WeLink acceptance.
// Questions are entered through the real assistant form. Tool-use proof comes from the
// native Claude transcript; neither tool responses nor final answers are injected.
// A dedicated config/data/CDP is used, and its copied credential is removed in finally.
// node tests/e2e-company-assistant-reliability-real.js
// HUB_RELIABILITY_FOLLOWUP=1: only rerun one meeting scope/route guard and inbox pagination.
// HUB_RELIABILITY_FOLLOWUP=meeting: only rerun the meeting scope/route guard.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net'), assert = require('node:assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const j = JSON.stringify, sleep = ms => new Promise(r => setTimeout(r, ms));
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const CODEAGENT = path.join(__dirname, 'fixtures', 'codeagent-standin', 'codeagent.cmd');
const WELINK = path.join(__dirname, 'fixtures', 'welink-cli-reliability.js');
const visibleText = value => String(value || '').replace(/\*\*/g, '').replace(/\s+/g, '');
function jsonLines(file) { return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : []; }
function filesBelow(dir) { return fs.existsSync(dir) ? fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? filesBelow(path.join(dir, e.name)) : [path.join(dir, e.name)]) : []; }
function toolEvidence(records) {
  const uses = new Map(), results = new Map(), models = new Set();
  for (const record of records) {
    if (record.message?.model) models.add(record.message.model);
    for (const part of Array.isArray(record.message?.content) ? record.message.content : []) {
      // Native transcript snapshots can repeat the same parallel tool-use block.
      if (part.type === 'tool_use') uses.set(part.id, { id: part.id, name: part.name, input: part.input });
      if (part.type === 'tool_result') {
        const text = typeof part.content === 'string' ? part.content : (part.content || []).filter(p => p.type === 'text').map(p => p.text).join('\n');
        let value; try { value = JSON.parse(text); } catch { value = { text }; }
        results.set(part.tool_use_id, { value, isError: !!part.is_error });
      }
    }
  }
  return { calls: [...uses.values()].map(use => ({ ...use, ...results.get(use.id) })), models: [...models] };
}
async function main() {
  const followup = ['1', 'meeting'].includes(process.env.HUB_RELIABILITY_FOLLOWUP);
  const onlyGuard = process.env.HUB_RELIABILITY_FOLLOWUP === 'meeting';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-company-reliability-'));
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
  const stamp = day.replaceAll('-', ''), out = path.resolve(__dirname, '..', 'output', `${stamp}-assistant-reliability-real-codex2-${path.basename(root).split('-').at(-1)}`);
  const cac = path.join(root, '.cac'), dataDir = path.join(root, 'data'), assistantDir = path.join(dataDir, 'company-assistant');
  const seedFile = path.join(root, 'welink-seed.json'), log = path.join(root, 'welink-calls.jsonl'), copiedCredential = path.join(cac, '.credentials.json');
  for (const dir of [cac, assistantDir, out]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(seedFile, j({ day, anchor: Date.now() - 60000 }));
  fs.writeFileSync(path.join(assistantDir, 'settings.json'), j({ workdays: [], enabled: true, refreshMinutes: 60 }));
  const result = { boundary: '真实 Claude Haiku，经 CodeAgent 启动替身；WeLink 是两个会话的独立合成 fixture，不是公司 CodeAgent 或真实公司数据。', mode: onlyGuard ? 'meeting-guard-followup' : followup ? 'meeting-guard-and-inbox-followup' : 'full', meetingRequested: followup ? 1 : 5, root, out, checks: [], meetingAttempts: [], turns: [], shots: [], launches: [], failures: [] };
  const receipt = path.join(out, `${stamp}-assistant-reliability-real-codex2.json`);
  const persist = () => fs.writeFileSync(receipt, j(result, null, 2), 'utf8');
  let hub, c;
  const until = async (fn, label, ms = 300000) => { const end = Date.now() + ms; let last; while (Date.now() < end) { try { const value = typeof fn === 'string' ? await c.eval(fn) : await fn(); if (value) return value; } catch (e) { last = e.message; } await sleep(400); } throw Error(`timeout: ${label}${last ? ' (' + last + ')' : ''}`); };
  const status = () => c.eval(`ipcRenderer.invoke('company-assistant:status')`);
  const shot = async name => { const data = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, `${stamp}-${name}-codex2.png`); fs.writeFileSync(file, Buffer.from(data.data, 'base64')); result.shots.push(file); persist(); };
  async function start() {
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'company-reliability', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: CODEAGENT, AI_HUB_CODEAGENT_CONFIG_DIR: cac, CLAUDE_HUB_HOME_DIR: path.join(root, 'home'), DEEPSEEK_API_KEY: '',
      AI_HUB_CODEAGENT_PICKER_LABELS: j({ 'GLM-5.2-WX-Auto': 'Haiku' }),
      HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'), CLAUDE_HUB_COMPANY_ASSISTANT: '1', CLAUDE_HUB_WELINK_CLI: WELINK,
      WELINK_RELIABILITY_SEED: seedFile, WELINK_RELIABILITY_LOG: log, CODEAGENT_STANDIN_NO_CHROME: '1',
      CODEAGENT_STANDIN_LAUNCH_LOG: path.join(root, 'claude-launches.jsonl'),
    } });
    result.launches.push({ pid: hub.pid, cdp: hub.cdpUrl, at: Date.now() });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await until(`typeof sessions !== 'undefined' && !!document.getElementById('btn-company-assistant')`, 'assistant rail', 60000);
    await c.eval(`document.getElementById('btn-company-assistant').click()`);
    await until(`!document.getElementById('company-assistant-page')?.hidden`, 'assistant page', 30000);
    await until(async () => { const s = await status(); return s.login?.ok && !s.job && s.brief && !s.brief.organizing; }, 'initial brief is idle', 420000);
  }
  async function stop() {
    if (!hub) return;
    if (c && hub.isAlive()) await c.eval('window.close()').catch(() => {});
    const end = Date.now() + 25000;
    while (hub.isAlive() && Date.now() < end) await sleep(300);
    await gracefulQuit(hub, { allowAlreadyExited: true });
    assert.equal(hub.isAlive(), false, 'isolated Hub must exit before restart');
    try { c?.close(); } catch {}
    fs.writeFileSync(path.join(out, `${stamp}-hub-${result.launches.length}-codex2.log`), hub.log().join('\n'), 'utf8');
    result.launches.at(-1).exitedAt = Date.now(); hub = null; c = null;
  }
  async function ask(question) {
    await until(async () => !(await status()).job, 'assistant idle');
    const offsets = new Map(filesBelow(path.join(cac, 'projects')).filter(f => f.endsWith('.jsonl')).map(f => [path.resolve(f).toLowerCase(), fs.statSync(f).size]));
    const previous = new Set((await status()).chat.map(x => x.id)), started = Date.now();
    await c.eval(`(() => { const form = document.querySelector('[data-slot="form"]'); const input = form.querySelector('textarea'); input.value = ${j(question)}; input.dispatchEvent(new Event('input', { bubbles: true })); form.requestSubmit(); })()`);
    const answer = await until(async () => { const item = (await status()).chat.find(x => !previous.has(x.id) && x.q === question); return item && ['done', 'error'].includes(item.state) && item; }, 'answer: ' + question, 420000);
    assert.equal(answer.state, 'done', answer.error || 'assistant answer failed');
    await sleep(700);
    const state = JSON.parse(fs.readFileSync(path.join(assistantDir, 'state.json'), 'utf8'));
    const binding = await c.eval(`(() => { const s = sessions.get(${j(state.sessionId)}); return s && { id:s.id, cc:s.ccSessionId, transcript:s.transcriptPath }; })()`);
    assert.ok(binding?.transcript && path.resolve(binding.transcript).toLowerCase().startsWith(path.resolve(cac, 'projects').toLowerCase() + path.sep), 'native transcript stays in isolated profile');
    const tail = fs.readFileSync(binding.transcript).subarray(offsets.get(path.resolve(binding.transcript).toLowerCase()) || 0).toString('utf8');
    const records = tail.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    const evidence = toolEvidence(records);
    assert.ok(evidence.models.length && evidence.models.every(m => /haiku/i.test(m)), 'real response model is Haiku: ' + evidence.models.join(','));
    const nativeText = records.filter(r => r.type === 'assistant' && Array.isArray(r.message?.content)).map(r => r.message.content.filter(p => p.type === 'text').map(p => p.text).join('\n')).filter(Boolean).at(-1) || '';
    const turn = { question, answer: answer.a, agentText: answer.agentText || null, queryCoverage: answer.queryCoverage || [], nativeText, chatId: answer.id, durationMs: Date.now() - started, binding, ...evidence };
    result.turns.push(turn); persist(); console.log(j({ progress: 'real-answer', turn: result.turns.length, question, seconds: Math.round(turn.durationMs / 1000), tools: turn.calls.map(x => x.name) }));
    return turn;
  }
  async function check(name, fn) {
    try { await fn(); result.checks.push(name); console.log(j({ check: name, ok: true })); }
    catch (error) { result.failures.push({ check: name, error: error.message }); console.log(j({ check: name, ok: false, error: error.message })); }
    persist();
  }
  try {
    const auth = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
    fs.copyFileSync(auth, copiedCredential);
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true,
      hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, theme: 'dark', projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    await start();
    const questions = followup ? ['请实时核对今天的会议与邮箱日历，告诉我各场的开始和结束时间，日期、星期和时间照查询结果写。'] : [
      '帮我重新查一下今天有哪些会议和日程，分别几点开始、几点结束？请保留查询给出的完整日期、星期和时间文字。',
      '再查一次今天的安排，把每场会议的时间范围原样列出来，我需要核对上海本地时间。',
      '请实时核对今天的会议与邮箱日历，告诉我各场的开始和结束时间，日期、星期和时间照查询结果写。',
      '今天的会分别安排在什么时间？请重新读取最新会议和日程，并照原文列出完整时间范围。',
      '麻烦再帮我查一遍今天会程，两路日程都查，直接引用每场完整的日期、星期和起止时间。',
    ];
    for (const [i, question] of questions.entries()) {
      await check(`会议自然语言问法 ${i + 1}/${questions.length}${followup ? '（范围措辞与统一查询入口回归）' : ''}`, async () => {
        const turn = await ask(question), calls = turn.calls.filter(x => /__welink_meetings$/.test(x.name));
        assert.ok(calls.length, 'this turn must really call MCP welink_meetings');
        assert.ok(calls.every(x => x.value && !x.isError), 'each meeting MCP result must succeed');
        const text = calls.map(x => x.value.text || '').join('\n');
        const expected = [
          { subject: '跨区评审', times: ['17:00', '18:00'], source: 'WeLink 待参加会议', sourcePrefix: 'meeting:utc-review:', queryTypes: ['1'] },
          { subject: '上午复盘（已结束）', times: ['09:00', '10:00'], source: 'WeLink 已结束会议', sourcePrefix: 'meeting:ended-morning:', queryTypes: ['2'] },
          { subject: '中国区对齐会', times: ['14:00', '15:00'], source: 'Exchange 日程', sourcePrefix: 'cal:china-sync:' },
        ];
        const queryEvidence = calls.map(call => {
          assert.equal(call.value.total, 3, 'actual MCP result has two WeLink records and one Exchange record');
          assert.match(call.value.queryId, /^[a-f0-9-]{36}$/);
          const query = JSON.parse(fs.readFileSync(path.join(assistantDir, 'queries', call.value.queryId + '.json'), 'utf8'));
          assert.equal(query.id, call.value.queryId); assert.equal(query.kind, 'meetings');
          assert.equal(query.items.length, 3); assert.equal(query.counts.meetings, 2); assert.equal(query.counts.calendar, 1);
          assert.equal(query.coverage.status, 'complete'); assert.equal(query.coverage.meeting.status, 'complete'); assert.equal(query.coverage.calendar.status, 'complete');
          assert.deepEqual(query.coverage.meeting.queryTypes, ['1', '2']); assert.equal(query.coverage.meeting.queryType, '1,2');
          for (const type of ['1', '2']) assert.equal(query.coverage.meeting.byType[type].status, 'complete');
          for (const item of expected) {
            const row = query.items.find(x => x.subject === item.subject);
            assert.ok(row?.sourceId.startsWith(item.sourcePrefix), 'source must belong to the expected original fixture record: ' + item.subject);
            if (item.queryTypes) assert.deepEqual(row.queryTypes, item.queryTypes);
          }
          return { queryId: query.id, counts: query.counts, coverage: query.coverage,
            rows: query.items.map(x => ({ sourceId: x.sourceId, subject: x.subject, displayRange: x.displayRange, queryTypes: x.queryTypes })) };
        });
        const sourceLines = expected.map(item => {
          const line = text.split('\n').find(value => value.includes(' · ' + item.subject + ' · '));
          assert.ok(line, 'all three source records must appear in actual MCP output: ' + item.subject);
          const range = line.split(' · ')[0];
          assert.ok(range.includes(day) && /周[日一二三四五六]/.test(range));
          for (const time of item.times) assert.ok(range.includes(time), 'fixture offset must yield ' + time);
          assert.ok(line.includes(' · ' + item.source + ' [' + item.sourcePrefix), 'MCP line must identify the source category and original record');
          assert.ok(turn.answer.replace(/\*\*/g, '').includes(range), 'answer must quote exact visible tool time range: ' + range);
          assert.ok(turn.answer.replace(/\*\*/g, '').includes(line), 'answer must quote the complete source line unchanged: ' + line);
          assert.ok(turn.nativeText.replace(/\*\*/g, '').includes(line), 'native model final must itself preserve each complete source line: ' + line);
          return line;
        });
        const ranges = sourceLines.map(line => line.split(' · ')[0]);
        assert.doesNotMatch(turn.answer, /(?:09:00|10:00).*跨区评审|跨区评审.*(?:09:00|10:00)/);
        if (followup) {
          const summaries = new Map(calls.map(call => [call.value.queryId, call.value.text.split('\n').filter(line => /^(?:覆盖：|范围说明：|在本次查询范围内找到)/.test(line))]));
          const actualCoverage = [...summaries.values()].flat();
          assert.ok(actualCoverage.length >= 3, 'real MCP query supplies source coverage, limitation and counts');
          assert.deepEqual(turn.queryCoverage, actualCoverage, 'saved coverage must come from this turn actual MCP results');
          const prefix = ['> **Hub 核实的查询范围**', ...actualCoverage.map(line => '> ' + line), ''].join('\n') + '\n';
          assert.ok(turn.answer.startsWith(prefix), 'Hub verified coverage must appear before any model prose');
          assert.match(prefix, /在本次查询范围内找到 3 [条场]/); assert.match(prefix, /WeLink 2 条、Exchange 1 条/);
          assert.match(prefix, /查询类型=1,2/); assert.match(prefix, /待参加及已结束会议（类型 1、2）/);
          assert.match(prefix, /其他会议类型未纳入本次查询/);
          assert.ok(turn.agentText, 'original model final is retained separately');
          assert.equal(turn.agentText.trim(), turn.nativeText.trim(), 'agentText is the actual native final, not generated test text');
          assert.equal(turn.answer.slice(prefix.length), turn.agentText, 'verified prefix must not rewrite or hide the original native answer');
          const rendered = await c.eval(`[...document.querySelectorAll('.ca-message-row.assistant')].at(-1)?.innerText || ''`);
          assert.ok(rendered.includes('Hub 核实的查询范围'), 'real UI renders the verified coverage prefix');
          const rawQuery = turn.calls.filter(x => /(?:welink-ro|welink-cli)[\s\S]*(?:calendar\s+list|meeting\s+query-list)/i.test(x.input?.command || x.input?.cmd || x.input?.script || ''));
          assert.equal(rawQuery.length, 0, 'MCP must remain the sole meeting/calendar query entry');
          const nativeFirst = turn.agentText.split('\n').find(line => line.trim());
          result.meetingGuard = { displayedPrefix: prefix, nativeFirstConclusion: nativeFirst, nativeFirstRespectsScope: /(?:本次|当前).*(?:范围|条件)/.test(nativeFirst), rawQueryCalls: rawQuery.length, tools: turn.calls.map(x => x.name) };
        }
        result.meetingAttempts.push({ number: i + 1, ok: true, ranges, sourceLines, queryEvidence, toolIds: calls.map(x => x.id), chatId: turn.chatId });
      });
      if (!result.meetingAttempts.some(x => x.number === i + 1)) result.meetingAttempts.push({ number: i + 1, ok: false });
    }
    await shot('01-meeting-answers');
    if (!onlyGuard) {
    await check('最近 24 小时私聊 250 条和群 @本人完整 MCP 翻页', async () => {
      const turn = await ask('请把最近24小时的私聊和群里@我的消息完整查一遍，翻完所有分页后，告诉我总条数和需要我处理的事项，不用逐条复述日常进展。');
      const calls = turn.calls.filter(x => /__welink_inbox$/.test(x.name));
      assert.ok(calls.length > 1, 'real MCP pagination required');
      assert.ok(calls.every(x => x.value && !x.isError), 'inbox MCP pages succeed');
      const ids = new Set(), cursors = new Set(calls.map(x => x.input.cursor).filter(Boolean));
      for (const call of calls) { for (const m of String(call.value.text || '').matchAll(/\[(msg:[^\]]+)\]/g)) ids.add(m[1]); if (call.value.nextCursor) assert.ok(cursors.has(call.value.nextCursor), 'every returned nextCursor is actually fetched'); }
      assert.equal(ids.size, 251, '250 private + 1 @self, ordinary group message excluded');
      const header = calls[0].value.text.split('\n')[0];
      assert.ok(visibleText(turn.answer).includes(visibleText(header)), 'answer preserves every visible coverage word (Markdown/spacing ignored)');
      assert.match(turn.answer, /250/); assert.match(turn.answer, /17:30/); assert.match(turn.answer, /11:20/); assert.match(turn.answer, /16:45/);
      const cli = jsonLines(log), privateCalls = cli.filter(x => x.args[0] === 'im' && x.args[1] === 'query-history-message' && x.args.includes('colleague_a'));
      assert.ok(privateCalls.some(x => x.args.includes('--message-id') && x.args.includes('0')), 'WeLink CLI history also paginated backward');
      result.inbox = { uniqueMessages: ids.size, mcpPages: calls.length, cliPrivatePages: privateCalls.length, coverage: header, knownConversations: 2 };
    });
    await shot('02-inbox-answer');
    }
    if (!followup) {
    let memoryTurn;
    await check('自然语言显式记忆经真实 MCP 保存', async () => {
      memoryTurn = await ask('记住：人甲是项目负责人。以后提到人甲，就按这个关系理解。');
      const calls = memoryTurn.calls.filter(x => /__assistant_memory$/.test(x.name));
      assert.ok(calls.some(x => ['add', 'update'].includes(x.input.op) && x.value && !x.isError), 'memory persistence must be a real MCP write');
      const memory = JSON.parse(fs.readFileSync(path.join(assistantDir, 'memory.json'), 'utf8'));
      assert.ok(memory.items.some(x => x.key === '人甲' && /项目负责人/.test(x.text) && x.source.ref === memoryTurn.chatId));
      result.memoryBeforeRestart = memory.items.map(x => ({ id: x.id, key: x.key, text: x.text, source: x.source }));
    });
    if (memoryTurn) await check('真正重启 Hub 后新助理原生会话仍能记住', async () => {
      const previousNative = memoryTurn.binding.cc;
      await stop();
      // Only the isolated assistant-session binding is reset. Memory and prior native
      // transcript stay untouched; no old conversation is injected into the new agent.
      const statePath = path.join(assistantDir, 'state.json'), state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      delete state.sessionId; delete state.primed; fs.writeFileSync(statePath, j(state));
      result.restart = { previousNative, method: '真实退出 Hub；只清隔离 state 的 sessionId/primed；保留 memory.json；重新启动并新建原生会话' };
      await start();
      const turn = await ask('你还记得人甲在项目中是什么关系吗？');
      assert.notEqual(turn.binding.cc, previousNative, 'a new native conversation is required');
      assert.match(turn.answer, /人甲/); assert.match(turn.answer, /项目负责人/);
      result.restart.newNative = turn.binding.cc; result.restart.answer = turn.answer;
      await shot('03-memory-after-restart');
    });
    await check('记忆设置真实 UI 修改、删除和截图', async () => {
      await c.eval(`document.querySelector('[data-ca="settings"]').click()`);
      await until(`!!document.querySelector('[data-ca="settings-tab:brief"]')`, 'brief tab', 15000);
      await c.eval(`document.querySelector('[data-ca="settings-tab:brief"]').click()`);
      await until(`!!document.querySelector('[data-memory-edit]')`, 'memory item', 15000);
      await c.eval(`document.querySelector('[data-memory-edit]').click()`);
      await until(`!!document.querySelector('[data-memory-text]')`, 'memory editor', 15000);
      await c.eval(`(() => { const input = document.querySelector('[data-memory-text]'); input.value = '项目总负责人，负责跨团队决策'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('[data-memory-save]').click(); })()`);
      await until(`document.querySelector('.ca-memory-list')?.innerText.includes('项目总负责人，负责跨团队决策')`, 'edited memory', 15000);
      const edited = JSON.parse(fs.readFileSync(path.join(assistantDir, 'memory.json'), 'utf8')).items;
      assert.ok(edited.some(x => x.key === '人甲' && x.text === '项目总负责人，负责跨团队决策' && x.source.ref === 'settings-edit'));
      await c.eval(`document.querySelector('[data-slot="assistant-memory"]').scrollIntoView({ block: 'center' })`); await shot('04-memory-edited');
      await c.eval(`document.querySelector('[data-memory-remove]').click()`);
      await until(`!document.querySelector('[data-memory-remove]') && /还没有保存的记忆/.test(document.querySelector('.ca-memory-list')?.innerText || '')`, 'deleted memory', 15000);
      assert.equal(JSON.parse(fs.readFileSync(path.join(assistantDir, 'memory.json'), 'utf8')).items.some(x => x.key === '人甲'), false);
      await shot('05-memory-deleted');
    });
    }
    result.meetingScore = `${result.meetingAttempts.filter(x => x.ok).length}/${result.meetingRequested}`;
    result.passed = result.failures.length === 0 && result.checks.length === (followup ? onlyGuard ? 1 : 2 : 9);
  } catch (error) {
    result.failures.push({ check: 'test infrastructure', error: error.stack });
    if (c) await shot('failure').catch(() => {});
    result.passed = false;
  } finally {
    try { await stop(); } catch (error) { result.teardownError = error.message; result.passed = false; }
    fs.rmSync(copiedCredential, { force: true });
    result.credentialCopyRemoved = !fs.existsSync(copiedCredential);
    result.meetingScore = `${result.meetingAttempts.filter(x => x.ok).length}/${result.meetingRequested}`;
    result.endedAt = new Date().toISOString(); persist();
    console.log(j({ passed: result.passed, meetingScore: result.meetingScore, checks: result.checks.length, failures: result.failures, receipt, credentialCopyRemoved: result.credentialCopyRemoved }, null, 2));
  }
  if (!result.passed) throw Error('reliability real-agent E2E failed; see ' + receipt);
}
main().then(() => setTimeout(() => process.exit(0), 300), error => { console.error(error.message); setTimeout(() => process.exit(1), 300); });
