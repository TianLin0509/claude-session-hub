'use strict';
// Real subscription Haiku through the CodeAgent compatibility launcher -> Hub MCP.
// Only the PPT corpus and WeLink transport are synthetic; no scripted model answers.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const assert = require('node:assert/strict'), crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { PptLibrary } = require('../core/company-assistant/ppt-library');
const j = JSON.stringify, sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const freePort = () => new Promise((resolve, reject) => { const server = net.createServer(); server.on('error', reject); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
function transcripts(root) {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap(entry => entry.isDirectory() ? transcripts(path.join(root, entry.name)) : entry.name.endsWith('.jsonl') ? [path.join(root, entry.name)] : []);
}
function nativeEvents(root) {
  return transcripts(path.join(root, 'projects')).flatMap(file => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }));
}
const benchmark = [
  ['少量射频通道如何驱动一大堆天线，适合给新人看哪页？', 'array-architecture', 1],
  ['想解释模拟网络和基带权重各自负责什么，找一页旧材料。', 'array-architecture', 1],
  ['找讲先固定一部分参数再换另一部分更新的波束赋形方法。', 'array-architecture', 2],
  ['相移器为什么只能改相位不能随便改幅度，有材料吗？', 'array-architecture', 2],
  ['找能说明少用射频链换来了什么硬件约束的页。', 'array-architecture', 3],
  ['全数字方案和混合方案硬件数量差在哪里？帮我找页。', 'array-architecture', 3],
  ['给新人介绍终端发射功率的基础控制点和路损补偿，用哪页？', 'uplink-power', 1],
  ['小区边缘手机为什么不能一直把发射功率往上加？', 'uplink-power', 1],
  ['找基站发指令在基础功率附近修正残余误差的材料。', 'uplink-power', 2],
  ['闭环功控能不能突破终端的最大功率限制，有原话吗？', 'uplink-power', 2],
  ['想讲把边缘用户功率抬高对邻小区的副作用，找素材。', 'uplink-power', 3],
  ['功控优化除了接收功率，还该看哪些量？', 'uplink-power', 3],
  ['有人把导频端口数当成终端天线数，找页帮我讲清楚。', 'channel-notes', 1],
  ['为什么接收权重不能把信道相位扔掉，只留功率？', 'channel-notes', 1],
  ['两个本来有效的信道样本平均之后可能抵消，哪页能解释？', 'channel-notes', 2],
  ['先求复数平均再算功率，和先算功率再平均一样吗？', 'channel-notes', 2],
  ['想说明高速移动时测到的信道到调度时已经旧了，找素材。', 'channel-notes', 3],
  ['总挑速率最高的用户为什么会饿死边缘用户？哪页有对比？', 'scheduling-notes', 1],
  ['吞吐差不多，最早排队的数据等待情况也会相同吗？', 'scheduling-notes', 2],
  ['重传多了为什么不能把误块率直接当成业务吞吐？找原页。', 'scheduling-notes', 3],
];

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-ppt-agent-real-')), dataDir = path.join(root, 'data');
  const dir = path.join(dataDir, 'company-assistant'), cac = path.join(root, '.cac'), pool = path.join(root, 'pool');
  const variant = process.env.PPT_AGENT_VARIANT || '';
  const out = path.resolve(__dirname, '..', 'output'), resultPath = path.join(out, `20261021-ppt-agent-real${variant}-codex2.json`);
  for (const p of [dir, cac, out]) fs.mkdirSync(p, { recursive: true });
  const python = process.env.CLAUDE_HUB_PPT_PYTHON || 'python';
  const build = spawnSync(python, [path.join(__dirname, 'fixtures/company-ppt-agent-library.py'), pool], { windowsHide: true, encoding: 'utf8' });
  assert.equal(build.status, 0, build.stderr);
  const settings = { enabled: false, ppt: { python, roots: [pool], db: path.join(root, 'no-doctor', 'index.db') } };
  fs.writeFileSync(path.join(dir, 'settings.json'), j(settings));
  const now = Date.now(), day = new Date(now).toLocaleDateString('sv-SE');
  fs.writeFileSync(path.join(dir, `brief-${day}.json`), j({ day, by: 'rules', generatedAt: now, total: 0, sections: [] }));
  fs.writeFileSync(path.join(dir, `raw-${day}.json`), j({ day, at: now, login: { ok: true }, meetings: [], calendar: [], mails: [], messages: {}, errors: [],
    meetingCoverage: { status: 'complete', reasonLabel: '会议查询完成' }, calendarCoverage: { status: 'failed', reasonLabel: '测试日程来源不可用' }, mailCoverage: { status: 'complete', records: 0, reasonLabel: '未读邮件查询完成' },
    scope: { lookbackHours: 24, fetched: 50, messages: 0, listCap: 50, listFull: true, limited: false, partial: 0, directoryInvalid: 1, conversations: [{ id: 'scope-fixture', name: '仅供状态测试', status: 'complete', unknownTime: 1 }] } }));
  const preparer = new PptLibrary({ dir, now: Date.now, settings: () => settings, changed() {} });
  preparer.startIndex(); await preparer.indexJob;
  assert.equal(preparer.indexState.indexed, 5); preparer.close();
  const fileHashes = Object.fromEntries(fs.readdirSync(pool).map(name => [name, sha(path.join(pool, name))]));
  const indexHash = sha(preparer.ownedDb());
  const result = { root, checks: [], shots: [], provenance: '真实 Haiku/Hub/MCP；合成 OOXML 素材；未连接公司 CodeAgent 或真实 WeLink', started: now };
  const save = () => fs.writeFileSync(resultPath, JSON.stringify(result, null, 2));
  let hub, c;
  const until = async (fn, label, timeout = 60000) => { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await sleep(500); } throw new Error('timeout: ' + label); };
  const ui = (expr, label, timeout) => until(() => c.eval(expr), label, timeout);
  const click = selector => c.eval(`document.querySelector(${j(selector)}).click()`);
  const value = (selector, text) => c.eval(`document.querySelector(${j(selector)}).value=${j(text)}`);
  const shot = async name => { const image = await c.send('Page.captureScreenshot', { format: 'png' }); const file = path.join(out, `20261021-ppt-agent${variant}-${name}-codex2.png`); fs.writeFileSync(file, Buffer.from(image.data, 'base64')); result.shots.push(file); };
  const ask = async (question, timeout = 600000) => {
    const started = Date.now();
    await value('[data-slot="form"] textarea', question);
    await c.eval(`document.querySelector('[data-slot="form"]').dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}))`);
    let chat;
    await until(async () => { const status = await c.eval(`ipcRenderer.invoke('company-assistant:status')`); chat = status.chat.findLast(item => item.q === question); return chat && ['done', 'error'].includes(chat.state); }, 'real Agent answer', timeout);
    assert.equal(chat.state, 'done', chat.error);
    return { ...chat, elapsedMs: Date.now() - started };
  };
  try {
    fs.copyFileSync(path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json'), path.join(cac, '.credentials.json'));
    fs.writeFileSync(path.join(cac, '.claude.json'), j({ hasCompletedOnboarding: true, lastOnboardingVersion: '2.1.205', bypassPermissionsModeAccepted: true, skipDangerousModePermissionPrompt: true, hasSeenAutoDefaultNudge: true, hasResetAutoModeOptInForDefaultOffer: true, hasSeenAutoModeEntryWarning: true, projects: {} }));
    fs.writeFileSync(path.join(cac, '.cac.json'), j({ hasCompletedOnboarding: true, projects: {} }));
    fs.writeFileSync(path.join(cac, 'settings.json'), j({ model: 'haiku', permissions: { defaultMode: 'bypassPermissions' }, skipDangerousModePermissionPrompt: true }));
    const state = path.join(root, 'welink-state'); fs.writeFileSync(state, 'ok');
    hub = await launchIsolatedHub({ dataDir, port: await freePort(), windowMode: 'hidden', label: 'ppt-agent-real', extraEnv: {
      AI_HUB_CODEAGENT_COMMAND: path.join(__dirname, 'fixtures/codeagent-standin/codeagent.cmd'), AI_HUB_CODEAGENT_CONFIG_DIR: cac,
      CODEAGENT_STANDIN_NO_CHROME: '1', CODEAGENT_STANDIN_MODEL: 'haiku', CLAUDE_HUB_COMPANY_ASSISTANT: '1',
      CLAUDE_HUB_WELINK_CLI: path.join(__dirname, 'fixtures/welink-cli-standin.js'), WELINK_STANDIN_STATE: state,
      WELINK_STANDIN_LOG: path.join(root, 'welink.log'), HUB_SESSION_SEARCH_CLAUDE_ROOTS: path.join(root, 'none'),
    } });
    c = await connectFirstPage(hub);
    await c.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await ui('!!document.getElementById("btn-company-assistant")', 'assistant rail'); await click('#btn-company-assistant');
    assert.match(await c.eval('document.querySelector(".ca-status").innerText'), /日程失败/);
    assert.match(await c.eval('document.querySelector(".ca-status").innerText'), /邮件已查/);
    await click('[data-ca="settings-tab:welink"]');
    await ui('/消息/.test(document.querySelector(".ca-tab-body")?.innerText || "")', 'independent coverage');
    assert.match(await c.eval('document.querySelector(".ca-tab-body").innerText'), /未取全/);
    assert.match(await c.eval('document.querySelector(".ca-tab-body").innerText'), /目录达到 50 个上限/);
    await click('[data-ca="close-panel"]');
    result.checks.push('UI状态夹具：邮件成功不掩盖日程失败；会话目录封顶、坏行及未知时间标成未取全');
    await ui('!!document.querySelector("[data-ca=ppt-assist]")', 'PPT capability'); await click('[data-ca="ppt-assist"]');
    assert.match(await c.eval('document.querySelector("[data-slot=form] textarea").value'), /讲清楚/);
    await value('[data-slot="form"] textarea', '保留我写到一半的请求'); await click('[data-ca="ppt-assist"]');
    assert.equal(await c.eval('document.querySelector("[data-slot=form] textarea").value'), '保留我写到一半的请求');
    await click('[data-ca="settings"]'); await click('[data-ca="settings-tab:ppt"]');
    await ui('/5 份/.test(document.querySelector(".ca-tab-body")?.innerText || "")', 'self-built index');
    assert.equal(await c.eval('!!document.querySelector("[data-ppt-query]")'), false);
    await shot('01-settings'); result.checks.push('侧栏进入自然语言对话并保留草稿；5 份/14 页自建库，无 Doctor');
    // Real memory UI: edit the stable id across kind/key; remove the same entry.
    await click('[data-ca="settings-tab:brief"]'); await ui('!!document.querySelector("[data-memory-add]")', 'memory list');
    await click('[data-memory-add]'); await value('[data-memory-key]', '测试偏好'); await value('[data-memory-text]', '先说结论'); await click('[data-memory-save]');
    await ui('!!document.querySelector("[data-memory-edit]")', 'saved memory'); await click('[data-memory-edit]');
    await value('[data-memory-kind]', 'routine'); await value('[data-memory-key]', '周报时间'); await value('[data-memory-text]', '周五下午整理'); await click('[data-memory-save]');
    await ui('/周报时间/.test(document.querySelector(".ca-memory-list")?.innerText || "")', 'edited memory');
    assert.equal(await c.eval('document.querySelectorAll(".ca-memory-row").length'), 1);
    await click('[data-memory-remove]'); await ui('/还没有保存/.test(document.querySelector(".ca-memory-list")?.innerText || "")', 'deleted memory');
    result.checks.push('记忆真实界面新增、跨类别/主题修改仍只有一条、删除');
    await click('[data-ca="close-panel"]');
    result.primary = await ask('我要给新同事讲清楚，为什么 64 根天线只用 4 条射频链也能工作，模拟相位和数字权重怎么配合？帮我找 2–3 页最合适的旧 PPT，说明推荐理由和原文依据。');
    save();
    assert.match(result.primary.a, /已核对的原文/);
    assert.match(result.primary.a, /本轮完整读过 \d+ 页/);
    assert.ok(result.primary.agentText, 'native free-form draft is retained separately for audit');
    assert.doesNotMatch(result.primary.a, /(?:14\s*页|全库|全部(?:的)?材料)[^\n。；]{0,12}(?:全|均|都)[^\n。；]{0,5}英文/, 'do not infer the language of unread pages');
    assert.ok(result.primary.pptResults?.some(p => /array-architecture/.test(p.path)), 'actual evidence report must create source cards');
    await ui('!!document.querySelector("[data-ca^=ppt-open]")', 'open-page cards');
    await c.eval('document.querySelector(".ca-scroll").scrollTop=document.querySelector(".ca-scroll").scrollHeight');
    await shot('02-real-answer');
    result.checks.push('自然语言真实 Haiku 调用 MCP 扩搜、读完整页、核验报告后显示页码来源卡');
    if (process.env.PPT_AGENT_BENCHMARK === '1') {
      result.benchmark = { corpus: '5 份14页合成文字事实，20个口语请求；基线是原单关键词接口直接传入整句', cases: [], batches: [] };
      for (let offset = 0; offset < benchmark.length; offset += 5) {
        const batch = benchmark.slice(offset, offset + 5);
        const question = '下面是五个彼此独立的 PPT 素材请求。请逐题使用 ppt_find，把对应的完整 Q 编号和原问题放入 question，每题自主扩展 3–8 组短查询，limit=5；每题再用 ppt_read 读最合适的 1–2 页并核对。最后用表格给出每题推荐的真实文件名、页码及一句原文依据。只需本轮五题，不要复用上一题的答案。\n' + batch.map(([q], i) => `Q${String(offset + i + 1).padStart(2, '0')}：${q}`).join('\n');
        result.benchmark.batches.push(await ask(question, 900000)); save();
        console.log(`real model batch ${offset / 5 + 1}/4 completed`);
      }
      const uses = nativeEvents(cac).flatMap(e => e.message?.content || []).filter(e => e.type === 'tool_use' && /ppt_find$/.test(e.name));
      const returns = new Map(nativeEvents(cac).flatMap(e => e.message?.content || []).filter(e => e.type === 'tool_result').map(e => [e.tool_use_id, e.content]));
      for (let i = 0; i < benchmark.length; i += 1) {
        const [question, file, page] = benchmark[i], id = `Q${String(i + 1).padStart(2, '0')}`;
        const calls = uses.filter(u => new RegExp(`\\b${id}\\b`).test(u.input?.question || ''));
        const candidates = calls.flatMap(u => { const raw = returns.get(u.id); const text = typeof raw === 'string' ? raw : (raw || []).filter(c => c.type === 'text').map(c => c.text).join('\n'); try { return JSON.parse(text).candidates || []; } catch { return []; } });
        const baseline = await preparer.execute('search', { query: question, limit: 5 });
        result.benchmark.cases.push({ id, question, expectedFile: file, expectedPage: page, modelQueries: calls.flatMap(u => u.input.queries), modelCalled: calls.length > 0,
          before: baseline.candidates.some(c => c.ref.name.includes(file) && c.ref.page === page), after: candidates.some(c => c.ref.name.includes(file) && c.ref.page === page),
          candidates: candidates.map(c => ({ name: c.ref.name, page: c.ref.page })) });
      }
      result.benchmark.beforeHits = result.benchmark.cases.filter(c => c.before).length;
      result.benchmark.afterHits = result.benchmark.cases.filter(c => c.after).length;
      assert.equal(result.benchmark.cases.filter(c => c.modelCalled).length, 20, 'all 20 questions must have real model tool calls');
    }
    const events = nativeEvents(cac), uses = events.flatMap(e => e.message?.content || []).filter(e => e.type === 'tool_use');
    result.models = [...new Set(events.map(e => e.message?.model).filter(Boolean))];
    result.toolCalls = uses.map(u => ({ name: u.name, op: u.input?.op, question: u.input?.question, queries: u.input?.queries, ids: u.input?.ids }));
    for (const tool of ['ppt_find', 'ppt_read']) assert.ok(uses.some(u => u.name.endsWith(tool)), 'native trace needs ' + tool);
    assert.ok(uses.some(u => u.name.endsWith('ppt_library') && u.input?.op === 'report'));
    assert.ok(result.models.some(m => /haiku/i.test(m)), 'actual native model identity');
    for (const [name, digest] of Object.entries(fileHashes)) assert.equal(sha(path.join(pool, name)), digest);
    assert.equal(sha(preparer.ownedDb()), indexHash); assert.equal(fs.existsSync(settings.ppt.db), false);
    result.checks.push('原生轨迹确认 Haiku 与实际 MCP 工具；原素材及索引 SHA-256 未变；未生成 Doctor 索引');
    result.ok = true;
  } catch (error) { result.ok = false; result.error = error.stack; if (c) await shot('failure').catch(() => {}); throw error; }
  finally {
    result.elapsedMs = Date.now() - now;
    if (hub) {
      try { if (c && hub.isAlive()) { await c.eval('window.close()'); await until(() => !hub.isAlive(), 'normal close', 30000); } result.teardown = await gracefulQuit(hub, { allowAlreadyExited: true }); }
      catch (error) { result.teardownError = error.message; result.ok = false; if (hub.isAlive()) await gracefulQuit(hub).catch(e => { result.cleanupError = e.message; }); }
      result.hubLogTail = hub.log().slice(-25);
    }
    c?.close(); fs.rmSync(path.join(cac, '.credentials.json'), { force: true });
    result.credentialsRemoved = !fs.existsSync(path.join(cac, '.credentials.json')); save();
    console.log(JSON.stringify({ ok: result.ok, resultPath, error: result.error, checks: result.checks, benchmark: result.benchmark && { before: result.benchmark.beforeHits, after: result.benchmark.afterHits }, elapsedMs: result.elapsedMs }));
    if (!result.ok) process.exitCode = 1;
  }
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
