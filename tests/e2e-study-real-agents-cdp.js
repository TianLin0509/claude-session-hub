'use strict';
// tests/e2e-study-real-agents-cdp.js
//
// 真 CLI 冒烟：在隔离 Hub 里把学习 Tab 的两个常驻 Agent（Claude 主笔 / Codex 审阅）
// 真的拉起来，各发一轮极小的 prompt，确认整条链路通：
//
//   创建 Session → CLI 就绪（含 Codex 的 PowerShell 换行兜底）
//   → sendToPty 写入（中文 prompt 对 Codex 会走「落文件 + 发指针」这条特殊路径）
//   → 真的产生一轮回复
//
// 这是 tests/e2e-study-tab-cdp.js（只验接线，不碰 CLI）的补充。
// 会消耗少量 token，默认需要显式跑：node tests/e2e-study-real-agents-cdp.js
//
// 仍然完全隔离：临时 CLAUDE_HUB_DATA_DIR + 独立 CDP 端口，不碰生产 Hub。
// CODEX_HOME / Claude 凭据不被覆盖，所以认证沿用本机已登录状态。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const PORT = Number(process.env.STUDY_REAL_E2E_PORT || 9335);
const PER_AGENT_BUDGET_MS = Number(process.env.STUDY_REAL_BUDGET_MS || 210000);
const results = [];
const check = (name, cond, detail) => results.push(cond ? ['PASS', name] : ['FAIL', name, detail || '断言失败']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-real-'));
  const studyRoot = path.join(dataDir, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'),
    ['| # | 主题 |', '|---|---|', '| L1 | 冒烟 |'].join('\n'), 'utf8');

  let hub = null; let page = null;
  try {
    hub = await launchIsolatedHub({
      dataDir, port: PORT, label: 'study-real',
      extraEnv: { AGENT_STUDY_DIR: studyRoot },
      windowMode: 'visible',
    });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,2500))');
    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,800))');

    for (const [role, kindLabel, token] of [
      ['author', 'Claude', 'STUDY_PING_CLAUDE'],
      ['reviewer', 'Codex', 'STUDY_PING_CODEX'],
    ]) {
      // 1) 建会话
      const ens = await page.eval(
        `require('electron').ipcRenderer.invoke('study:ensure-session', ${JSON.stringify({ role })})`
      );
      check(`${kindLabel}：Session 创建成功`, ens && ens.ok === true, JSON.stringify(ens && (ens.message || ens.error)));
      if (!ens || !ens.ok) continue;

      // 2) 发一轮极小的中文 prompt。中文是刻意的——Codex 走非 ASCII 分支
      //    （prompt 落文件 + 发指针），这条路径正是最容易出错的地方。
      const started = Date.now();
      const ask = await page.eval(
        `require('electron').ipcRenderer.invoke('study:ask', ${JSON.stringify({ role, text: `请只回复这一个词，不要有任何其他内容：${token}` })})`
      );
      check(`${kindLabel}：prompt 成功写入并确认 turn 启动`, ask && ask.ok === true,
        JSON.stringify(ask && (ask.message || ask.error)));
      if (!ask || !ask.ok) continue;

      // 3) 等 transcript 级 turn-complete。
      //    刻意不去 PTY 缓冲里抓回令文本：TUI 是全屏重绘，缓冲里全是 ANSI 序列，
      //    回令会被覆盖/滚掉，抓不到不代表没跑（2026-09-01 实测踩过这个坑）。
      //    turn-complete 才是「这一轮真的结束了」的权威信号，编排器用的也是它。
      let turns = 0;
      while (Date.now() - started < PER_AGENT_BUDGET_MS) {
        await sleep(4000);
        const tc = await page.eval(`require('electron').ipcRenderer.invoke('study:turn-counts')`).catch(() => null);
        turns = (tc && tc.ok && tc.counts && tc.counts[role] && tc.counts[role].turns) || 0;
        if (turns >= 1) break;
      }
      check(`${kindLabel}：真的跑完一轮并收到 turn-complete（${Math.round((Date.now() - started) / 1000)}s）`,
        turns >= 1, `${Math.round(PER_AGENT_BUDGET_MS / 1000)}s 内未收到 turn-complete`);

      // 4) 输出预览接口能拿到内容（这条挂过：snapshot 路径在没挂终端时返回空）
      const out = await page.eval(`require('electron').ipcRenderer.invoke('study:agent-output', ${JSON.stringify({ role })})`);
      check(`${kindLabel}：右栏输出预览拿得到内容`,
        out && out.ok === true && String(out.text || '').trim().length > 50,
        `ok=${out && out.ok} textLen=${out && String(out.text || '').length} rawLen=${out && out.rawLength}`);
    }

    // 4) 状态里两个 Agent 都已绑定且在线
    const st = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`);
    const alive = (st && st.agents || []).filter((a) => a.alive).length;
    check('两个 Agent 都已绑定为在线会话', alive === 2, `实际在线 ${alive} 个：${JSON.stringify(st && st.agents && st.agents.map(a => [a.kind, a.status]))}`);

  } catch (e) {
    check('真 CLI 冒烟执行', false, e && e.message);
  } finally {
    try { if (page && page.close) page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n学习 Tab · 真 CLI 冒烟（隔离 Hub，两个 Agent 各跑一轮）\n');
  for (const [s, n, m] of results) console.log(`[${s}] ${n}${m ? '\n        ' + m : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} 通过 / ${failed} 失败 / 共 ${results.length}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('异常：', e); process.exit(2); });
