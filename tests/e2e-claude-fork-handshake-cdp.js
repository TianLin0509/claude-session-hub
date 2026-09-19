'use strict';
// 真实隔离 Hub：从一个「历史很大」的 Claude 会话分支时，握手等待预算必须按体积放宽。
//
// 2026-09-18 事故：17.1 MB 的父会话分支后，Claude 要 124.6 秒才连上，而 initialize
// 写死 60 秒 → 判连接失败 → 群聊那条提交被标「待核对」、侧栏亮异常 → 一分钟后
// 引擎其实连上并跑完了。这里用一个伪造的大 transcript 复现那个入口，断言：
//   · 主进程日志里出现放宽后的预算，且明显大于 60 秒
//   · 会话仍然正常启动、能答话（放宽不能把正常路径搞坏）
//
// 成员由 claude-stream fixture 扮演，不花钱；USERPROFILE 指向临时目录，
// 不碰真实的 ~/.claude/projects。

const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');
const assert = require('assert/strict');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const j = JSON.stringify;
const pause = ms => new Promise(r => setTimeout(r, ms));
const MB = 1024 * 1024;
const PARENT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

async function main() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-forkhandshake-'));
  const out = path.resolve(process.env.FORK_HANDSHAKE_EVIDENCE_DIR || 'artifacts/claude-fork-handshake');
  fs.mkdirSync(out, { recursive: true });
  const dataDir = path.join(root, 'data');
  const fakeHome = path.join(root, 'home');
  const cwd = path.join(root, 'workspace');
  fs.mkdirSync(cwd, { recursive: true });
  // 伪造的父会话 transcript：locator 按 <home>/.claude/projects/<slug>/<id>.jsonl 找。
  const slug = path.resolve(cwd).replace(/[^A-Za-z0-9]/g, '-');
  const projectDir = path.join(fakeHome, '.claude', 'projects', slug);
  fs.mkdirSync(projectDir, { recursive: true });
  const parentTranscript = path.join(projectDir, `${PARENT_ID}.jsonl`);
  fs.writeFileSync(parentTranscript, 'x'.repeat(12 * MB));

  const port = await new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const n = s.address().port; s.close(() => res(n)); });
  });

  let hub; let c;
  const evidence = { checks: [], passed: false, parentTranscriptMb: 12 };
  const check = (name, pass, detail) => {
    assert(pass, name + ': ' + j(detail));
    evidence.checks.push({ name, detail: detail === undefined ? null : detail });
    console.log('PASS ' + name);
  };
  const until = async (fn, label, ms = 90000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { if (await fn()) return; await pause(200); }
    throw new Error('timeout: ' + label);
  };

  try {
    hub = await launchIsolatedHub({
      dataDir, port, windowMode: 'hidden', label: 'claude-fork-handshake',
      extraEnv: {
        USERPROFILE: fakeHome,
        HOME: fakeHome,
        CLAUDE_HUB_CLAUDE_STREAM_FIXTURE: path.join(__dirname, 'fixtures/claude-stream.js'),
      },
    });
    evidence.pid = hub.pid;
    c = await connectFirstPage(hub);
    await until(() => c.eval('typeof sessions!=="undefined" && !!window.__hubE2E'), 'renderer');

    // 直接建一个「从大历史恢复」的会话：它和分支走同一条启动路径
    // （resumeSessionId 存在 → --resume，fork 时再加 --fork-session）。
    const session = await c.eval(`ipcRenderer.invoke('create-session', ${j({
      kind: 'claude',
      opts: { title: '大历史分支验证', cwd, model: 'claude-opus-5[1m]', mcpProfile: 'none', forkCCSessionId: PARENT_ID },
    })})`);
    evidence.session = session && session.id;
    check('会话创建成功', !!(session && session.id), session && session.id);

    await until(() => Promise.resolve(hub.log().some(line => line.includes('[claude-native] handshake budget'))),
      '主进程记录握手预算');
    const line = hub.log().find(l => l.includes('[claude-native] handshake budget'));
    const seconds = Number((/budget (\d+)s/.exec(line) || [])[1]);
    evidence.budgetSeconds = seconds;
    evidence.budgetLine = line;
    check('握手预算按 12 MB 历史放宽，明显大于原来的 60 秒', seconds > 60 && seconds <= 600, { seconds, line });

    // 放宽之后正常路径不能坏：fixture 引擎照常连上并答话。
    await until(async () => {
      const s = await c.eval(`(()=>{const s=sessions.get(${j(session.id)});return s?{conn:s.nativeRuntime&&s.nativeRuntime.connection,state:s.nativeRuntime&&s.nativeRuntime.state}:null;})()`);
      return s && s.conn === 'connected';
    }, '会话连上', 120000);
    check('放宽预算没有破坏正常启动：会话连上了', true);

    const reply = await c.eval(`ipcRenderer.invoke('session:send-prompt', ${j({ sessionId: session.id, text: '握手预算验证：随便答一句。' })})`);
    check('发送走通（拿到受理回执）', !!(reply && (reply.ok === true || reply.sendStatus)), reply);

    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    throw error;
  } finally {
    if (c) { try { await c.close(); } catch {} }
    if (hub) {
      fs.writeFileSync(path.join(out, 'hub.log'), hub.log().join('\n'));
      evidence.exit = await gracefulQuit(hub);
    }
    fs.writeFileSync(path.join(out, 'evidence.json'), j(evidence, null, 2));
    console.log(j({ passed: evidence.passed, checks: evidence.checks.length, budgetSeconds: evidence.budgetSeconds, exit: evidence.exit }));
    try { if (root.startsWith(os.tmpdir())) fs.rmSync(root, { recursive: true, force: true }); } catch {}
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
