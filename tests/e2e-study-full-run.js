'use strict';
// tests/e2e-study-full-run.js
//
// 真实完整跑一次三棒，并在中途模拟用户提问。
//
//   node tests/e2e-study-full-run.js
//
// 与其它 E2E 的区别：这次**真的会产出一课**，落到真实学习项目里
// （AGENT_STUDY_DIR 默认 C:\Vibe\AI\agent-study）。Hub 数据目录仍然隔离，
// 不碰生产 Hub 的会话与状态。
//
// 验证点：
//   1) 三棒依次推进（draft→review→finalize），每棒派给正确的 CLI
//   2) 正在跑的 Agent 拒绝插话，另一个 Agent 能正常回答（学习中随时提问）
//   3) 最终产物过七道红线
//   4) 全程无未捕获错误

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const STUDY_ROOT = process.env.AGENT_STUDY_DIR || 'C:\\Vibe\\AI\\agent-study';
const PORT = Number(process.env.STUDY_FULL_PORT || 9339);
const MAX_MS = Number(process.env.STUDY_FULL_MAX_MS || 100 * 60 * 1000);
const LOG = path.join(os.tmpdir(), `study-full-run-${Date.now()}.log`);

const results = [];
const check = (n, c, d) => { results.push(c ? ['PASS', n] : ['FAIL', n, d || '']); say(`${c ? 'PASS' : 'FAIL'}  ${n}${c ? '' : '  << ' + (d || '')}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function say(s) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${s}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-full-'));
  say(`学习项目：${STUDY_ROOT}`);
  say(`Hub 隔离数据目录：${dataDir}`);
  say(`日志：${LOG}`);

  let hub = null; let page = null;
  const seenStages = [];
  let askedIdle = false;
  let lastReportedMin = 0;
  let askedBusy = false;

  try {
    hub = await launchIsolatedHub({
      dataDir, port: PORT, label: 'study-full',
      extraEnv: { AGENT_STUDY_DIR: STUDY_ROOT },
      windowMode: 'visible',
    });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,2500))');
    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,800))');

    const before = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`);
    const lessonId = before && before.nextLessonId;
    say(`本次将生成：${lessonId} · 今日 ${before && before.todayDate}`);
    check('有待生成的课程', !!lessonId, '课表已全部完成？');
    if (!lessonId) return;

    const started = await page.eval(`require('electron').ipcRenderer.invoke('study:run-now', {})`);
    check('触发生成成功', started && started.ok === true, JSON.stringify(started && (started.message || started.error)));
    if (!started || !started.ok) return;

    const t0 = Date.now();
    let last = '';
    let finalRun = null;

    while (Date.now() - t0 < MAX_MS) {
      await sleep(15000);
      const st = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`).catch(() => null);
      if (!st || !st.ok) { say('state 读取失败，继续等'); continue; }
      const run = (st.runs || []).find((r) => r.lessonId === lessonId);
      const stage = (st.currentRun && st.currentRun.stage) || '';

      if (stage && stage !== last) {
        last = stage;
        seenStages.push(stage);
        say(`>>> 进入第 ${seenStages.length} 棒：${stage}（${stage === 'review' ? 'Codex' : 'Claude'}）`);
      }

      // ── 模拟用户交互：正在跑第一棒（Claude）时 ──
      if (stage === 'draft' && !askedBusy) {
        askedBusy = true;
        const busy = await page.eval(`require('electron').ipcRenderer.invoke('study:ask', ${JSON.stringify({ role: 'author', text: '在忙吗' })})`);
        check('正在跑的 Agent 拒绝插话并说明原因',
          busy && busy.ok === false && busy.error === 'agent-busy',
          JSON.stringify(busy));
        // 另一个 Agent（Codex，此时空闲）应该能正常回答
        const idle = await page.eval(`require('electron').ipcRenderer.invoke('study:ask', ${JSON.stringify({ role: 'reviewer', text: '用一句话回答：ReAct 里的两个动作分别是什么？' })})`);
        check('空闲的另一个 Agent 可以正常提问', idle && idle.ok === true, JSON.stringify(idle));
        askedIdle = idle && idle.ok === true;
      }

      if (run && (run.status === 'done' || run.status === 'failed')) { finalRun = run; break; }
      if (!st.running && run && run.status !== 'running') { finalRun = run; break; }

      // 每 5 分钟播报一次。用「上次播报的分钟数」去重——只判 mins % 5 会在
      // 整第 5 分钟内被每次轮询重复触发，刷屏。
      const mins = Math.floor((Date.now() - t0) / 60000);
      if (mins && mins % 5 === 0 && mins !== lastReportedMin) {
        lastReportedMin = mins;
        say(`… 已跑 ${mins} 分钟，当前棒次 ${stage || '(切换中)'}`);
      }
    }

    check('三棒都执行到了', seenStages.length >= 3, `实际经过：${seenStages.join(' → ')}`);
    check('run 最终成功', finalRun && finalRun.status === 'done',
      finalRun ? `status=${finalRun.status} ${JSON.stringify(Object.entries(finalRun.stages || {}).map(([k, v]) => [k, v.status, v.error]))}` : '超时未结束');

    if (finalRun && finalRun.stages) {
      for (const [k, v] of Object.entries(finalRun.stages)) {
        check(`棒次 ${k} 完成（执行者 ${v.actor}）`, v.status === 'done', `${v.status} ${v.error || ''}`);
      }
    }

    // 空闲 Agent 的提问确实产生了一轮
    if (askedIdle) {
      const tc = await page.eval(`require('electron').ipcRenderer.invoke('study:turn-counts')`).catch(() => null);
      const t = tc && tc.ok && tc.counts && tc.counts.reviewer && tc.counts.reviewer.turns;
      check('提问的 Agent 真的回了（turn-complete ≥ 1）', (t || 0) >= 1, `turns=${t}`);
    }

    const errs = await page.eval(`(window.__studyE2EErrors || []).length`).catch(() => 0);
    check('渲染进程无未捕获错误', !errs, `${errs} 个`);

    // ── 产物检查 ──
    const outHtml = path.join(STUDY_ROOT, 'days', `${before.todayDate}-${lessonId}.html`);
    const review = path.join(STUDY_ROOT, 'days', `${before.todayDate}-${lessonId}-review.md`);
    check('成品 HTML 已产出', fs.existsSync(outHtml), outHtml);
    check('Codex 的审阅意见已产出', fs.existsSync(review), review);
    if (fs.existsSync(outHtml)) {
      const kb = (fs.statSync(outHtml).size / 1024).toFixed(0);
      say(`成品：${outHtml}（${kb}KB）`);
      try {
        const out = execFileSync(process.execPath, [path.join(STUDY_ROOT, 'scripts', 'check-lesson.js'), outHtml],
          { cwd: STUDY_ROOT, encoding: 'utf8' });
        say(out.trim().split('\n').slice(-14).join('\n'));
        check('成品通过七道红线', /七道红线全部通过|通过，但有/.test(out), '见上方自检输出');
      } catch (e) {
        say(String(e.stdout || e.message).slice(-2000));
        check('成品通过七道红线', false, '自检返回非零');
      }
    }
  } catch (e) {
    check('完整跑执行', false, e && e.message);
  } finally {
    try { if (page && page.close) page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  say('');
  say('===== 汇总 =====');
  for (const [s, n, d] of results) say(`[${s}] ${n}${d ? '  << ' + d : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  say(`${results.length - failed} 通过 / ${failed} 失败 / 共 ${results.length}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { say('异常：' + (e && e.message)); process.exit(2); });
