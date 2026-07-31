'use strict';
// 🔍 查看完整 Prompt · raw 原文查看 —— 真实端到端。
//
// 这个功能唯一的价值就是「不是 mock」，所以 E2E 必须走完整链路，一步都不许替换：
//   隔离 Hub（真 electron.exe）→ 真 create-session（powershell kind，带真实 cwd）
//   → 真卡片 DOM + 真点击 🔍 → 真 IPC prompt-inspect → 真面板
//   → 真点击某条 CLAUDE.md → 真 IPC prompt-inspect-raw → 主进程 fs 实读
//   → 断言弹出的正文与磁盘文件**逐字节一致**（sha256 也对得上）
//
// 隔离铁律（CLAUDE.md）：CLAUDE_HUB_DATA_DIR + 独立 CDP 端口 + 直调
// node_modules/electron/dist/electron.exe + spawn 前剥离嵌套 CLAUDECODE env。
// 关闭只针对自己 spawn 的 PID，绝不 Get-Process electron 群杀。

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// —— spawn 前先剥离嵌套 Claude Code 会话 env ——
// 否则测试 Hub spawn 的 CLI 自认子会话（不写 transcript），
// 且残留的 CLAUDE_HUB_PORT 会让 hook 投给错误的 Hub。
for (const key of ['CLAUDECODE', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_ENTRYPOINT',
  'CLAUDE_CODE_SESSION_ID', 'CLAUDE_HUB_PORT', 'CLAUDE_HUB_TOKEN', 'CLAUDE_HUB_SESSION_ID']) {
  delete process.env[key];
}

const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const HUB_ROOT = path.resolve(__dirname, '..');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-');
const DATA_DIR = process.env.PI_RAW_E2E_DATA_DIR
  || path.join(process.env.LOCALAPPDATA || require('os').tmpdir(), 'Temp', 'hub-test-prompt');
const CDP_PORT = Number(process.env.PI_RAW_E2E_PORT || 9231);
const WORK_DIR = path.join(DATA_DIR, 'fixture-cwd');
const OUTPUT = path.join(HUB_ROOT, 'output', 'playwright', `prompt-inspect-raw-${STAMP}`);

// 夹具正文：混中英 + emoji + 长行，专门用来验证 UTF-8 不被切坏、正文不被加工。
const CLAUDE_MD_TEXT = [
  '# Prompt Raw E2E 夹具',
  '',
  '@sub/imported.md',
  '',
  '## 中文段落',
  '这一行用来验证磁盘原文与预览逐字一致：兔子🐇、括号（全角）、引号「」、制表符\t结束。',
  '',
  '```powershell',
  'Get-FileHash -Algorithm SHA256 "CLAUDE.md"',
  '```',
  '',
  `唯一标记 PI_RAW_MARKER_${STAMP}`,
  '尾行不带换行符之外的任何东西。',
  '',
].join('\n');

const IMPORTED_TEXT = '# 被 @import 拉进来的片段\n这一段必须在拼装预览里紧跟父 CLAUDE.md。\n';
const ORPHAN_TEXT = '# 孤儿 AGENTS.md\nClaude 从不自动读它，但面板要列出来且可点开。\n';

function sha256Of(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

async function waitForEval(client, expression, label, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = null;
  while (Date.now() < deadline) {
    try { if (await client.eval(`Boolean(${expression})`)) return; } catch (e) { lastErr = e; }
    await _waitMs(200);
  }
  throw new Error(`Timed out waiting for ${label}${lastErr ? ` (last: ${lastErr.message})` : ''}`);
}

async function capture(client, targetPath) {
  const shot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
  fs.writeFileSync(targetPath, Buffer.from(shot.data, 'base64'));
  return { path: targetPath, bytes: fs.statSync(targetPath).size };
}

function buildFixture() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(path.join(WORK_DIR, 'sub'), { recursive: true });
  fs.writeFileSync(path.join(WORK_DIR, 'CLAUDE.md'), CLAUDE_MD_TEXT, 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'sub', 'imported.md'), IMPORTED_TEXT, 'utf8');
  fs.writeFileSync(path.join(WORK_DIR, 'AGENTS.md'), ORPHAN_TEXT, 'utf8');
  return {
    claudeMd: path.join(WORK_DIR, 'CLAUDE.md'),
    imported: path.join(WORK_DIR, 'sub', 'imported.md'),
    orphan: path.join(WORK_DIR, 'AGENTS.md'),
  };
}

// CDP 端口被占用时直接说清楚，不要静默连到别人的实例（尤其是生产 Hub）
function assertPortFree(port) {
  return new Promise((resolve, reject) => {
    const server = require('net').createServer();
    server.once('error', () => reject(new Error(
      `CDP 端口 ${port} 已被占用。这个 E2E 必须独占 ${port}，绝不复用别的 Electron 实例。`)));
    server.once('listening', () => server.close(() => resolve()));
    server.listen(port, '127.0.0.1');
  });
}

(async () => {
  await assertPortFree(CDP_PORT);
  fs.mkdirSync(OUTPUT, { recursive: true });
  const fx = buildFixture();
  const claudeMdDisk = fs.readFileSync(fx.claudeMd, 'utf8');
  const claudeMdSha = sha256Of(fx.claudeMd);
  const claudeMdBytes = fs.statSync(fx.claudeMd).size;

  const report = { ok: false, dataDir: DATA_DIR, port: CDP_PORT, workDir: WORK_DIR, screenshots: [] };
  let hub = null;
  let client = null;
  let sessionId = null;

  try {
    hub = await launchIsolatedHub({
      dataDir: DATA_DIR,
      port: CDP_PORT,
      label: 'prompt-inspect-raw',
      extraEnv: { CLAUDE_HUB_E2E: '1' },
    });
    report.pid = hub.pid;
    client = await connectFirstPage(hub, t => t.type === 'page' && /renderer[\\/]index\.html/.test(t.url || ''));
    await client.send('Runtime.enable');
    await client.send('Page.enable');
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await waitForEval(client, 'document.getElementById("msg-overlay") && window.togglePromptInspector', 'renderer ready');

    // ---- 1. 真实会话（powershell kind，不起任何 LLM，但 cwd 是真的） ----
    const session = await client.eval(`require('electron').ipcRenderer.invoke('create-session', {
      kind: 'powershell',
      opts: { title: 'Prompt raw E2E', cwd: ${JSON.stringify(WORK_DIR)} }
    })`);
    assert.ok(session && session.id, `create-session 失败：${JSON.stringify(session)}`);
    sessionId = session.id;
    report.sessionId = sessionId;
    // 选中新会话会异步清空 #msg-overlay，等它稳定再插卡片，否则卡片会被冲掉
    await _waitMs(1500);

    // ---- 2. 真卡片 + 真点击 🔍（走 renderer.js 的全局 click 派发） ----
    const opened = await client.eval(`(async () => {
      window.__piErrors = [];
      window.addEventListener('error', e => window.__piErrors.push(String(e.error || e.message)));
      window.addEventListener('unhandledrejection', e => window.__piErrors.push(String(e.reason)));

      const overlay = document.getElementById('msg-overlay');
      overlay.style.display = 'block';
      const turn = { id: 'pi-raw-e2e', role: 'user', kind: 'claude', text: '检视这个 cwd 会注入什么', ts: Date.now() };
      window._sessionTurns.set(turn.id, turn);
      overlay.insertAdjacentHTML('beforeend', window._renderTurnCard(turn));
      const card = overlay.querySelector('[data-turn-id="pi-raw-e2e"]');
      card.dataset.sessionId = ${JSON.stringify(sessionId)};
      const btn = card.querySelector('[data-action="prompt-inspect"]');
      if (!btn) throw new Error('🔍 按钮不存在');
      btn.click();                                  // 真 DOM 点击，走 document 委派
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const panel = card.querySelector('.pi-panel');
        if (panel && panel.querySelector('.pi-clickable')) break;
        await new Promise(r => setTimeout(r, 120));
      }
      const panel = card.querySelector('.pi-panel');
      return {
        hasPanel: !!panel,
        panelErr: panel ? (panel.querySelector('.pi-err')?.textContent || '') : 'no panel',
        clickableCount: panel ? panel.querySelectorAll('[data-pi-path]').length : 0,
        paths: panel ? Array.from(panel.querySelectorAll('[data-pi-path]')).map(el => el.getAttribute('data-pi-path')) : [],
        hasAssembleBtn: !!(panel && panel.querySelector('[data-pi-assemble]')),
        truthLabels: panel ? Array.from(panel.querySelectorAll('.pi-truth-item > b')).map(b => b.textContent) : [],
        errors: window.__piErrors.slice(),
      };
    })()`);
    assert.strictEqual(opened.hasPanel, true, `面板没出现：${opened.panelErr}`);
    assert.strictEqual(opened.panelErr, '', `面板报错：${opened.panelErr}`);
    assert.ok(opened.clickableCount >= 3, `可点击条目太少：${opened.clickableCount}`);
    assert.ok(opened.hasAssembleBtn, '缺少「完整拼装预览」入口');
    assert.deepStrictEqual(opened.truthLabels, ['磁盘实读原文', '按实测规则还原的顺序', '拿不到'],
      `三档诚实标注必须都在：${JSON.stringify(opened.truthLabels)}`);
    assert.deepStrictEqual(opened.errors, [], '面板渲染不许有运行时错误');
    const lower = opened.paths.map(p => p.toLowerCase());
    for (const need of [fx.claudeMd, fx.imported, fx.orphan]) {
      assert.ok(lower.includes(need.toLowerCase()), `面板里缺少可点条目：${need}`);
    }
    report.screenshots.push(await capture(client, path.join(OUTPUT, '01-panel.png')));

    // ---- 3. 真点击 CLAUDE.md 条目 → 真 raw IPC → 断言逐字一致 ----
    const raw = await client.eval(`(async () => {
      const row = Array.from(document.querySelectorAll('.pi-panel [data-pi-path]'))
        .find(el => el.getAttribute('data-pi-path').toLowerCase() === ${JSON.stringify(fx.claudeMd.toLowerCase())});
      if (!row) throw new Error('没找到夹具 CLAUDE.md 的可点行');
      const cs = getComputedStyle(row);
      row.click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        const pre = document.querySelector('.pi-modal-overlay .pi-raw');
        if (pre) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const modal = document.querySelector('.pi-modal-overlay');
      const pre = modal && modal.querySelector('.pi-raw');
      return {
        cursor: cs.cursor,
        modalShown: !!modal,
        title: modal?.querySelector('.pi-modal-title')?.textContent || '',
        meta: modal?.querySelector('.pi-modal-meta')?.innerText || '',
        sha12: modal?.querySelector('.pi-sha')?.textContent || '',
        status: modal?.querySelector('.pi-modal-status')?.textContent || '',
        hasCopy: !!modal?.querySelector('[data-pi-copy]'),
        text: pre ? pre.textContent : null,
        errors: window.__piErrors.slice(),
      };
    })()`);
    assert.strictEqual(raw.cursor, 'pointer', '可点击行必须是 cursor:pointer');
    assert.strictEqual(raw.modalShown, true, '预览 modal 没弹出');
    assert.strictEqual(raw.text, claudeMdDisk, 'CDP 取到的正文与磁盘原文不一致（这才是这个功能的全部意义）');
    assert.strictEqual(raw.sha12, claudeMdSha.slice(0, 12), `sha256 前 12 位不一致：${raw.sha12} vs ${claudeMdSha.slice(0, 12)}`);
    assert.ok(raw.meta.includes(String(claudeMdBytes)), `meta 里必须写明字节数 ${claudeMdBytes}`);
    assert.ok(raw.meta.includes('Get-FileHash'), 'meta 必须给出用户可自行复核的命令');
    assert.ok(/已显示全部 \d+ \/ \d+ 字节/.test(raw.status), `状态栏必须写清已显示多少字节：${raw.status}`);
    assert.ok(raw.hasCopy, '缺少「复制原文」按钮');
    assert.deepStrictEqual(raw.errors, [], 'raw 预览不许有运行时错误');
    report.rawFirst200 = raw.text.slice(0, 200);
    report.diskFirst200 = claudeMdDisk.slice(0, 200);
    report.screenshots.push(await capture(client, path.join(OUTPUT, '02-raw-preview.png')));

    // ---- 4. 完整拼装预览：顺序 + 起止偏移 ----
    const asm = await client.eval(`(async () => {
      window._promptInspectorCloseModal();
      document.querySelector('.pi-panel [data-pi-assemble]').click();
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (document.querySelector('.pi-modal-overlay .pi-asm-body .pi-seg-hdr')) break;
        await new Promise(r => setTimeout(r, 100));
      }
      const modal = document.querySelector('.pi-modal-overlay');
      const segs = Array.from(modal.querySelectorAll('.pi-asm-body .pi-asm-seg')).map(el => ({
        header: el.querySelector('.pi-seg-hdr')?.innerText.replace(/\\s+/g, ' ').trim() || '',
        path: el.querySelector('.pi-seg-path')?.textContent || '',
        offsets: el.querySelector('.pi-seg-off')?.textContent || '',
        text: el.querySelector('.pi-raw')?.textContent ?? null,
      }));
      return {
        segs,
        status: modal.querySelector('.pi-modal-status')?.textContent || '',
        indexRows: modal.querySelectorAll('.pi-asm-idx').length,
        unavailable: Array.from(modal.querySelectorAll('.pi-asm-index')).slice(-1)[0]?.innerText || '',
        errors: window.__piErrors.slice(),
      };
    })()`);
    assert.deepStrictEqual(asm.errors, [], '拼装预览不许有运行时错误');
    const idxClaude = asm.segs.findIndex(s => s.path.toLowerCase() === fx.claudeMd.toLowerCase());
    const idxImport = asm.segs.findIndex(s => s.path.toLowerCase() === fx.imported.toLowerCase());
    assert.ok(idxClaude >= 0, '拼装里必须有夹具 CLAUDE.md');
    assert.strictEqual(idxImport, idxClaude + 1, '@import 段必须紧跟它的父 CLAUDE.md');
    assert.strictEqual(asm.segs[idxClaude].text, claudeMdDisk, '拼装段正文也必须与磁盘逐字一致');
    assert.ok(/字节偏移 \[\d+, \d+\)/.test(asm.segs[idxClaude].offsets), `缺少起止字节偏移：${asm.segs[idxClaude].offsets}`);
    assert.ok(asm.segs[idxClaude].offsets.includes(claudeMdSha.slice(0, 12)), '拼装段必须带 sha256 前 12 位');
    // 偏移自洽：重复/读不到的证据行没有 .pi-seg-off；真正注入的相邻两段
    // end + 2（'\n\n'）=== 下一段 start。
    const parsed = asm.segs.map(s => {
      const m = s.offsets.match(/\[(\d+), (\d+)\)/);
      return m ? { start: Number(m[1]), end: Number(m[2]) } : null;
    }).filter(Boolean);
    for (let i = 1; i < parsed.length; i += 1) {
      assert.strictEqual(parsed[i].start, parsed[i - 1].end + 2,
        `第 ${i} 段偏移与上一段对不上：${JSON.stringify(parsed[i - 1])} → ${JSON.stringify(parsed[i])}`);
    }
    const claudeOffset = asm.segs[idxClaude].offsets.match(/\[(\d+), (\d+)\)/);
    assert.ok(claudeOffset, '夹具 CLAUDE.md 必须有可解析偏移');
    assert.strictEqual(Number(claudeOffset[2]) - Number(claudeOffset[1]), claudeMdBytes,
      '偏移宽度必须等于磁盘字节数');
    assert.ok(asm.unavailable.includes('拿不到'), '拼装预览必须如实列出拿不到的部分');
    assert.ok(asm.unavailable.includes('内置系统提示词'), '必须点名 CLI 内置系统提示词拿不到');
    assert.ok(!/系统提示词[\s\S]{0,40}You are/.test(asm.unavailable), '绝不许伪造一段系统提示词正文');
    report.assemblySegments = asm.segs.map((s, i) => ({ i, path: s.path, offsets: s.offsets }));
    report.assemblyStatus = asm.status;
    report.screenshots.push(await capture(client, path.join(OUTPUT, '03-assembly.png')));

    // ---- 5. 安全：越权路径必须被主进程拒绝 ----
    const guard = await client.eval(`(async () => {
      window._promptInspectorCloseModal();
      const ipc = require('electron').ipcRenderer;
      const probe = async (p) => {
        const r = await ipc.invoke('prompt-inspect-raw', { sessionId: ${JSON.stringify(sessionId)}, path: p });
        return { path: p, ok: r.ok, code: r.code, leaked: !!(r.data && r.data.text) };
      };
      return {
        denied: await Promise.all([
          probe('C:\\\\Windows\\\\win.ini'),
          probe(process.env.USERPROFILE + '\\\\.claude\\\\settings.json'),
          probe(${JSON.stringify(path.join(HUB_ROOT, 'package.json'))}),
          probe(${JSON.stringify(path.join(WORK_DIR, 'sub'))}),
        ]),
        allowed: await probe(${JSON.stringify(fx.orphan)}),
      };
    })()`);
    for (const d of guard.denied) {
      assert.strictEqual(d.ok, false, `越权路径被放行了：${d.path}`);
      assert.strictEqual(d.code, 'FORBIDDEN', `${d.path} 应报 FORBIDDEN，实际 ${d.code}`);
      assert.strictEqual(d.leaked, false, `${d.path} 被拒时仍回传了正文`);
    }
    assert.strictEqual(guard.allowed.ok, true, '白名单内的孤儿 AGENTS.md 应该可读');
    report.guard = guard;

    report.ok = true;
    console.log(JSON.stringify(report, null, 2));
    console.log('\n--- CDP 取到的正文前 200 字 ---\n' + report.rawFirst200);
    console.log('\n--- 磁盘文件前 200 字 ---\n' + report.diskFirst200);
    console.log('\n逐字一致: ' + (report.rawFirst200 === report.diskFirst200));
  } catch (error) {
    if (hub && typeof hub.log === 'function') {
      console.error('--- isolated hub log tail ---');
      console.error(hub.log().slice(-60).join('\n'));
    }
    throw error;
  } finally {
    if (client && sessionId) {
      await client.eval(`require('electron').ipcRenderer.invoke('close-session', ${JSON.stringify(sessionId)})`).catch(() => {});
      await _waitMs(400);
    }
    if (client) await client.close().catch(() => {});
    if (hub) await gracefulQuit(hub).catch(() => {});   // 只关自己 spawn 的 PID
  }
})().catch(error => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});
