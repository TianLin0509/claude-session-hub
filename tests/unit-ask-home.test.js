'use strict';
// 公司 CodeAgent 向家里求助（ask_home，2026-10-15）：
// 外发关口（少于 2 万字，MCP 和命令行都拦）→ 家里开 Claude 会话作答（Hub 默认配置）→ 回复送回发起的 CodeAgent 会话；
// Claude 起不来 / 额度用完 / 一直没答上时换 Codex 替补（带上之前的往来）；家里回公司查证据时不把「已发出」当答案；
// 追问进同一个家里会话；替家里办事的公司会话不挂 ask_home（不打转）；解除配对后两头的求助都作废。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { rig, pair } = require('./helpers/company-bridge-rig');
const { MAX_OUTBOUND_CHARS } = require('../core/company-bridge/ask-home');
const { INSTRUCTIONS, NO_ANSWER_MS } = require('../core/company-bridge/home-consult');

const QUESTION = '## 背景\nL2 调度里 PF 权重更新放在 TTI 末尾还是开头拿不准。\n## 要决定\n选哪种，理由。\n## 已试\n两种都跑过，吞吐差 1%。';
const companySession = (r, id = 'c1') => r.cs.map.set(id, { id, kind: 'codeagent', status: 'idle', title: 'L2 调度排查' });
const askHome = (r, question = QUESTION, sid = 'c1') => r.company.askHome.invoke({ name: 'ask_home', callerSessionId: sid, arguments: { question, title: 'PF 权重更新时机' } });
const consultSid = (r, kind) => r.hs.created.filter(c => c.opts.purpose === 'home-consult' && (!kind || c.kind === kind)).at(-1)?.opts.id;
const lastTo = (s, id) => s.sentTo(id).at(-1)?.text || '';

function runCli(args, env) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'ask-home.js'), ...args], { env: { ...process.env, ...env }, windowsHide: true });
    let out = ''; child.stdout.on('data', d => { out += d; });
    child.on('close', code => resolve({ code, json: JSON.parse(out.trim().split('\n').join('') || '{}') }));
  });
}

test('外发关口：正文少于 2 万字才发；本机接口、命令行都拦，追问同样拦', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  await assert.rejects(askHome(r, 'x'.repeat(MAX_OUTBOUND_CHARS)), /20000 字.*必须少于 20000 字/);
  await assert.rejects(askHome(r, '中'.repeat(MAX_OUTBOUND_CHARS + 5)), /20005 字/, '按字符数算，中文 1 字算 1');
  assert.equal(r.company.askHome.threads().length, 0, '超限的没有留下记录');
  const ok = await askHome(r, '好'.repeat(MAX_OUTBOUND_CHARS - 1));
  assert.equal(ok.chars, MAX_OUTBOUND_CHARS - 1);
  assert.match(ok.thread, /^H-\d{4}-01$/);
  // 命令行走同一个本机接口
  await r.company.askHome.start();
  const plan = r.company.sessionPlan({ kind: 'codeagent', opts: {}, id: 'c1' });
  const big = path.join(r.root, 'big.md'); fs.writeFileSync(big, '码'.repeat(MAX_OUTBOUND_CHARS + 100));
  const denied = await runCli(['ask', '--file', big], plan.env);
  assert.equal(denied.code, 1);
  assert.match(denied.json.error, /20100 字.*没有发出/);
  const small = path.join(r.root, 'small.md'); fs.writeFileSync(small, QUESTION);
  const sent = await runCli(['ask', '--file', small, '--title', '命令行求助'], plan.env);
  assert.equal(sent.code, 0); assert.equal(sent.json.ok, true); assert.match(sent.json.thread, /^H-/);
  const forged = await runCli(['show'], { ...plan.env, HUB_HOME_LINK_PASS: 'x'.repeat(64) });
  assert.equal(forged.code, 1, '通行证不对进不了本机接口');
  // 追问：等上一轮回复后才能追，同样受 2 万字限制
  await assert.rejects(r.company.askHome.invoke({ name: 'followup_home', callerSessionId: 'c1', arguments: { thread: ok.thread, question: '请再看看这个' } }), /还没回复/);
  const t1 = r.company.askHome.thread(ok.thread);
  r.company.askHome.saveThread({ ...t1, rounds: [{ ...t1.rounds[0], reply: '好', status: 'replied', delivered: true }] });
  await assert.rejects(r.company.askHome.invoke({ name: 'followup_home', callerSessionId: 'c1', arguments: { thread: ok.thread, question: 'y'.repeat(MAX_OUTBOUND_CHARS) } }), /追问内容 20000 字/);
});

test('全流程：公司求助 → 家里开 Claude 会话（默认配置）作答 → 回复送回发起的 CodeAgent 会话；追问进同一个家里会话', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  const asked = await askHome(r);
  assert.equal(asked.status, '已发出');
  await r.home.checkNow();
  const created = r.hs.created.find(c => c.opts.purpose === 'home-consult');
  assert.equal(created.kind, 'claude', '优先 Claude');
  assert.equal(created.opts.model, 'claude-default', '用 Hub 的默认配置');
  assert.equal(created.opts.effort, 'high');
  const sid = created.opts.id;
  const prompt = lastTo(r.hs, sid);
  assert.ok(prompt.startsWith(INSTRUCTIONS), '第一轮带说明');
  assert.match(prompt, /ask_company/); assert.match(prompt, /5–15 分钟/); assert.match(prompt, /一次问清/);
  assert.match(prompt, new RegExp(`编号 ${asked.thread}`)); assert.ok(prompt.includes(QUESTION));
  assert.equal(r.home.status().consults[0].state, 'running');
  await r.company.checkNow();
  assert.match(r.company.askHome.thread(asked.thread).rounds[0].note, /家里 Claude 正在作答/);
  r.hs.answer(sid, '结论：放在 TTI 末尾。\n理由：……\n把握程度：中');
  await r.home.checkNow();
  assert.equal(r.home.consult.thread(asked.thread).state, 'replied');
  await r.company.checkNow();
  const delivered = lastTo(r.cs, 'c1');
  assert.match(delivered, new RegExp(`【家里回复 ${asked.thread} · 第 1 轮 · Claude】`));
  assert.match(delivered, /结论：放在 TTI 末尾/); assert.match(delivered, /followup_home/);
  const ct = r.company.askHome.thread(asked.thread);
  assert.equal(ct.rounds[0].meta.agent, 'claude'); assert.equal(ct.rounds[0].delivered, true);
  assert.equal(r.company.askHome.openThreads().length, 0);
  assert.ok(r.notices.some(n => /家里回复了/.test(n.title)));
  // 追问：同一个家里会话，只带追问本身
  const fu = await r.company.askHome.invoke({ name: 'followup_home', callerSessionId: 'c1', arguments: { thread: asked.thread, question: '如果改成 TTI 开头，风险在哪？' } });
  assert.equal(fu.round, 2);
  await r.home.checkNow();
  assert.equal(r.hs.created.filter(c => c.opts.purpose === 'home-consult').length, 1, '没有新开会话');
  assert.match(lastTo(r.hs, sid), /^## 公司 CodeAgent 的追问（编号 H-\d{4}-01，第 2 轮）/);
  r.hs.answer(sid, '风险：权重滞后一个 TTI。');
  await r.home.checkNow(); await r.company.checkNow();
  assert.match(lastTo(r.cs, 'c1'), /第 2 轮 · Claude】[\s\S]*权重滞后/);
});

test('Codex 替补：Claude 额度用完换 Codex 重答同一轮（新会话带说明）；之后的追问交给 Codex 并带上之前的往来', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  const asked = await askHome(r);
  await r.home.checkNow();
  const claude = consultSid(r, 'claude');
  r.hs.answer(claude, "You've hit your usage limit · resets 3am (Asia/Shanghai)");
  await r.home.checkNow();
  const codex = consultSid(r, 'codex');
  assert.ok(codex, '换 Codex 新开了会话');
  const created = r.hs.created.find(c => c.opts.id === codex);
  assert.equal(created.opts.model, 'codex-default');
  assert.ok(lastTo(r.hs, codex).startsWith(INSTRUCTIONS));
  await r.company.checkNow();
  assert.match(r.company.askHome.thread(asked.thread).rounds[0].note, /Claude 额度已用尽，改由 Codex 作答|家里 Codex 正在作答/);
  assert.ok(r.notices.some(n => /换 Codex 作答/.test(n.title)));
  r.hs.answer(codex, '结论：末尾。');
  await r.home.checkNow(); await r.company.checkNow();
  const reply = lastTo(r.cs, 'c1');
  assert.match(reply, /第 1 轮 · Codex】/);
  assert.equal(r.company.askHome.thread(asked.thread).rounds[0].meta.fallbackReason, '额度已用尽');
  assert.ok(!reply.includes('usage limit'), '额度报错没有当成答案发回');
  // 追问走 Codex 会话
  await r.company.askHome.invoke({ name: 'followup_home', callerSessionId: 'c1', arguments: { thread: asked.thread, question: '那开头呢？' } });
  await r.home.checkNow();
  assert.match(lastTo(r.hs, codex), /^## 公司 CodeAgent 的追问/);
  assert.equal(r.hs.sentTo(claude).length, 1, 'Claude 会话不再收到追问');
});

test('Codex 替补：Claude 会话起不来；Codex 接手的新会话带上 Claude 之前答过的往来', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  const asked = await askHome(r);
  await r.home.checkNow();
  const claude = consultSid(r, 'claude');
  r.hs.answer(claude, '第一轮答复：末尾。');
  await r.home.checkNow(); await r.company.checkNow();
  // Claude 会话被关掉、记录也没了，追问时又起不来
  r.hs.map.delete(claude); r.hs.failCreate.add('claude');
  await r.company.askHome.invoke({ name: 'followup_home', callerSessionId: 'c1', arguments: { thread: asked.thread, question: '那开头呢？' } });
  await r.home.checkNow();
  const codex = consultSid(r, 'codex');
  const prompt = lastTo(r.hs, codex);
  assert.ok(prompt.startsWith(INSTRUCTIONS));
  assert.match(prompt, /## 之前的往来[\s\S]*第一轮答复：末尾[\s\S]*第 2 轮）/);
  assert.match(r.home.consult.thread(asked.thread).rounds[1].fallbackReason, /没能开始：claude 启动失败/);
});

test('都没答上：Claude 停下 5 分钟没有回答换 Codex，Codex 也没有就告诉公司，送回发起的会话', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  const asked = await askHome(r);
  await r.home.checkNow();
  await r.home.checkNow(); // 第一次看到停着没回答，开始计时
  r.clock.now += NO_ANSWER_MS + 1000;
  await r.home.checkNow();
  assert.ok(consultSid(r, 'codex'), '换了 Codex');
  await r.home.checkNow();
  r.clock.now += NO_ANSWER_MS + 1000;
  await r.home.checkNow();
  assert.equal(r.home.consult.thread(asked.thread).state, 'failed');
  await r.company.checkNow();
  assert.match(lastTo(r.cs, 'c1'), /【家里回复 H-\d{4}-01 · 第 1 轮 · 没答上】[\s\S]*Codex 会话停下了，但一直没读到回答/);
});

test('家里回公司查证据：停下等回执时的「已发出」不算答案；回执送进家里会话、它答完后才回复公司', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  const asked = await askHome(r);
  await r.home.checkNow();
  const sid = consultSid(r);
  // 家里会话带「问公司」MCP（替公司拿主意的会话不论目录都挂）
  assert.equal(r.home.sessionPlan({ kind: 'claude', opts: { purpose: 'home-consult', cwd: 'C:/x/consult' }, id: sid }).mcp.name, 'company_bridge');
  const q = await r.home.invoke({ name: 'ask_company', callerSessionId: sid, arguments: { question: '## 目的\n核对 PF 权重在公司代码里何时更新\n## 问题\n1. 在哪个函数？' } });
  r.hs.answer(sid, `已用 ask_company 发出 ${q.thread}，等公司回执后继续。`);
  await r.home.checkNow();
  assert.equal(r.home.consult.thread(asked.thread).state, 'running', '没有把「已发出」发回公司');
  assert.deepEqual(r.home.consult.thread(asked.thread).rounds[0].companyAsks, [q.thread]);
  await r.company.checkNow();
  assert.match(r.company.askHome.thread(asked.thread).rounds[0].note, new RegExp(`在向公司查证据（${q.thread}）`));
  // 公司为 Q 开的 CodeAgent 会话是替家里办事的，不挂 ask_home
  const bridgeSession = r.cs.created.find(c => c.opts.purpose === 'company-bridge');
  assert.ok(bridgeSession);
  assert.equal(r.company.sessionPlan({ kind: 'codeagent', opts: bridgeSession.opts, id: bridgeSession.opts.id }), null);
  r.cs.answer(bridgeSession.opts.id, '结论：在 tti_end 里更新。把握程度：高。');
  await r.company.checkNow();
  await r.home.checkNow(); // 收回执、送进家里会话
  assert.match(lastTo(r.hs, sid), new RegExp(`【公司回执 ${q.thread}`));
  assert.equal(r.home.consult.thread(asked.thread).state, 'running', '回执刚送进去，家里会话还没答完');
  r.clock.now += 30000;
  await r.home.checkNow();
  assert.equal(r.home.consult.thread(asked.thread).state, 'running');
  r.hs.answer(sid, '最终结论：放在 TTI 末尾，和公司 tti_end 一致。');
  await r.home.checkNow(); await r.company.checkNow();
  const replies = r.cs.sentTo('c1').filter(x => /【家里回复/.test(x.text));
  assert.equal(replies.length, 1, '只回复一次');
  assert.match(replies[0].text, /最终结论：放在 TTI 末尾/);
  assert.equal(r.company.askHome.thread(asked.thread).rounds[0].meta.companyAsks, 1);
});

test('挂载：配对后 Hub 打开的 CodeAgent 会话带 ask_home（MCP + 命令行）；替家里办事的、别的种类不带；会话管理器把它并进 CodeAgent 的 --mcp-config', async t => {
  const r = rig(t);
  assert.equal(r.company.sessionPlan({ kind: 'codeagent', opts: {}, id: 'a' }), null, '未配对什么都不挂');
  await pair(r);
  await r.company.askHome.start();
  const plan = r.company.sessionPlan({ kind: 'codeagent', opts: { cwd: 'D:/code/l2' }, id: 'a' });
  assert.equal(plan.mcp.name, 'home_bridge');
  assert.equal(plan.mcp.command, process.execPath);
  assert.ok(fs.existsSync(plan.mcp.args[0]));
  assert.equal(plan.mcp.env.ELECTRON_RUN_AS_NODE, '1', '公司版脚本在 app.asar 里，要以 Node 方式运行');
  assert.equal(plan.env.HUB_HOME_LINK_PASS, r.company.askHome.passFor('a'));
  assert.ok(fs.readFileSync(plan.env.HUB_ASK_HOME_CMD, 'utf8').includes('ELECTRON_RUN_AS_NODE=1'));
  assert.ok(r.company.sessionPlan({ kind: 'codeagent-resume', opts: {}, id: 'b' }).mcp);
  assert.equal(r.company.sessionPlan({ kind: 'codeagent', opts: { purpose: 'company-bridge' }, id: 'c' }), null);
  assert.equal(r.company.sessionPlan({ kind: 'powershell', opts: {}, id: 'd' }), null);
  // 会话管理器
  const { SessionManager } = require('../core/session-manager');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-extra-mcp-'));
  const old = process.env.CLAUDE_HUB_DATA_DIR; process.env.CLAUDE_HUB_DATA_DIR = dataDir;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_HUB_DATA_DIR; else process.env.CLAUDE_HUB_DATA_DIR = old; fs.rmSync(dataDir, { recursive: true, force: true }); });
  const sm = Object.create(SessionManager.prototype);
  sm.setExtraMcpProvider(p => r.company.sessionPlan(p));
  const existing = path.join(dataDir, 'meeting.json');
  fs.writeFileSync(existing, JSON.stringify({ mcpServers: { hub_meeting: { command: 'node', args: ['m.js'] } } }));
  const opts = sm._withExtraMcp('codeagent', { id: 'e', mcpConfigFile: existing });
  const merged = JSON.parse(fs.readFileSync(opts.mcpConfigFile, 'utf8'));
  assert.deepEqual(Object.keys(merged.mcpServers).sort(), ['home_bridge', 'hub_meeting']);
  assert.equal(opts.extraEnv.HUB_HOME_LINK_SESSION_ID, 'e');
  const { buildCodeAgentPtyLaunch } = require('../core/session-manager')._private;
  const config = { command: 'codeagent', configDir: os.tmpdir(), configDirEnv: 'CODEAGENT3_CONFIG_DIR', stateFile: '.cac.json' };
  const cmd = buildCodeAgentPtyLaunch('e', 'codeagent', { ...opts, mcpProfile: 'full' }, os.tmpdir(), {}, config).cmd;
  assert.ok(cmd.includes(path.basename(opts.mcpConfigFile)), 'CodeAgent 启动命令带上这份配置');
});

test('解除配对：两个方向在途的求助都作废；家里空闲时每分钟检查，有求助在途时每 10 秒', async t => {
  const r = rig(t);
  await pair(r);
  companySession(r);
  assert.equal(r.home.polling().intervalSeconds, 60);
  await askHome(r);
  await r.home.checkNow();
  assert.equal(r.home.polling().intervalSeconds, 10);
  assert.equal(r.company.polling().intervalSeconds, 10);
  r.home.unpair(); r.company.unpair();
  assert.equal(r.home.consult.threads()[0].state, 'cancelled');
  assert.equal(r.company.askHome.threads()[0].state, 'cancelled');
  await assert.rejects(askHome(r), /还没和家里配对/);
});
