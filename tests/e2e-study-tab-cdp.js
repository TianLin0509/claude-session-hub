'use strict';
// tests/e2e-study-tab-cdp.js
//
// 学习 Tab 的真环境接线验证：拉起一个**隔离数据目录 + 独立 CDP 端口**的 Hub，
// 点开「学习」按钮，检查仪表盘、侧栏 Agent 收纳、IPC 是否都通。
//
//   node tests/e2e-study-tab-cdp.js
//
// 刻意不碰生产 Hub：CLAUDE_HUB_DATA_DIR 走临时目录，端口另开，
// 结束后 gracefulQuit 只关自己 spawn 的那个进程。
//
// 这里**不真的调用 CLI**（不烧 token、不依赖网络）。真实 CLI 编排由
// tests/study-orchestration.test.js 用替身覆盖；这里验证渲染进程接线。
//
// 2026-09-02 改版后的面板是**全景仪表盘**，不再有材料 iframe 和 Agent 对话栏：
// 材料交给 Hub 已有的预览面板，教练交给左侧会话列表。所以断言也换成了
// 指标块 / 课程行 / 今日运行 / 教练入口。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const PORT = Number(process.env.STUDY_E2E_PORT || 9333);
const results = [];
function check(name, cond, detail) {
  results.push(cond ? ['PASS', name] : ['FAIL', name, detail || '断言失败']);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-e2e-'));
  const studyRoot = path.join(dataDir, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'),
    ['| # | 主题 |', '|---|---|', '| L1 | 冒烟用课程 |', '| L2 | 第二课 |'].join('\n'), 'utf8');
  // 一张假的成品卡：面板要能读出标题、体积、审阅条数
  fs.writeFileSync(path.join(studyRoot, 'days', '2026-09-02-L1.html'),
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body>'
    + '<h1>冒烟课程 · 标题取自 h1</h1></body></html>', 'utf8');
  fs.writeFileSync(path.join(studyRoot, 'days', '2026-09-02-L1-review.md'),
    ['# 审阅', '## 1. 第一条', '正文', '## 2. 第二条', '正文', '## 3. 第三条'].join('\n'), 'utf8');
  fs.writeFileSync(path.join(studyRoot, 'TERMS.json'),
    JSON.stringify({ count: 166, terms: [{ term: 'Agent Loop', en: '', desc: '' }] }), 'utf8');
  fs.writeFileSync(path.join(studyRoot, 'terms-state.json'), JSON.stringify({
    updatedAt: '2026-09-02T00:00:00Z',
    reportedLessons: [],
    terms: { 'Agent Loop': { asked: 2, correct: 0, wrong: 0 } },
  }), 'utf8');

  let hub = null; let page = null;
  try {
    hub = await launchIsolatedHub({
      dataDir, port: PORT, label: 'study-e2e',
      extraEnv: { AGENT_STUDY_DIR: studyRoot, CLAUDE_HUB_E2E: '1' },
      windowMode: 'visible',
    });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,2500))');

    // ---- nav 入口 ----
    const navText = await page.eval(`(() => {
      const b = document.getElementById('btn-study');
      return b ? b.textContent.trim() : '';
    })()`);
    check('nav 里有「学习」按钮', String(navText).includes('学习'), `实际：${navText}`);

    const initHidden = await page.eval(`getComputedStyle(document.getElementById('study-panel')).display`);
    check('面板初始不显示', initHidden === 'none', `实际 display=${initHidden}`);

    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,1400))');
    const shown = await page.eval(`getComputedStyle(document.getElementById('study-panel')).display`);
    check('点击后面板显示', shown === 'grid', `实际 display=${shown}`);

    // ---- 仪表盘骨架 ----
    const sk = await page.eval(`(() => {
      const q = (s) => !!document.querySelector(s);
      return {
        tiles: document.querySelectorAll('#study-tiles .study-tile').length,
        lessonRows: document.querySelectorAll('#study-lessons .study-lrow').length,
        head: q('#study-panel .study-head'),
        today: q('#study-today'),
        coaches: q('#study-coaches'),
        runBtn: q('#study-run'),
        openCoach: q('#study-open-coach'),
        // 改版后这三样必须已经消失
        legacyTabs: document.querySelectorAll('#study-panel .study-tab').length,
        legacyOutput: q('#study-output'),
        legacyAsk: q('#study-ask-input'),
        legacyIframe: q('#study-lesson-col iframe'),
      };
    })()`);
    check('顶部四个指标块齐全', sk.tiles === 4, `实际 ${sk.tiles} 个`);
    check('课程行渲染出来了（1 课 + 1 条待生成）', sk.lessonRows === 2, `实际 ${sk.lessonRows} 行`);
    check('今日运行 / 教练 / 生成按钮 / 打开教练 都在',
      sk.head && sk.today && sk.coaches && sk.runBtn && sk.openCoach, JSON.stringify(sk));
    check('旧的 Agent 对话栏已移除（页签/输出区/输入框全无）',
      sk.legacyTabs === 0 && !sk.legacyOutput && !sk.legacyAsk,
      `tabs=${sk.legacyTabs} output=${sk.legacyOutput} ask=${sk.legacyAsk}`);
    check('旧的材料 iframe 已移除（改走 Hub 预览面板）', !sk.legacyIframe);

    // ---- 课程行内容 ----
    const row = await page.eval(`(() => {
      const r = document.querySelector('#study-lessons .study-lrow');
      if (!r) return null;
      return {
        no: r.querySelector('.no') && r.querySelector('.no').textContent,
        title: r.querySelector('.ti') && r.querySelector('.ti').textContent,
        meta: r.querySelector('.mt') && r.querySelector('.mt').textContent,
        hasOpen: !!r.querySelector('button'),
      };
    })()`);
    check('课程行显示课号', row && row.no === 'L1', JSON.stringify(row));
    check('课程行标题取自 HTML 的 h1', row && /标题取自 h1/.test(row.title || ''), JSON.stringify(row));
    check('课程行显示审阅条数（review.md 里 3 条）', row && /审阅 3/.test(row.meta || ''), JSON.stringify(row));
    check('课程行有「打开」按钮', row && row.hasOpen === true);

    // ---- study:state 新增字段 ----
    const st = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`);
    check('study:state 返回 ok', st && st.ok === true, JSON.stringify(st && st.error));
    check('studyRoot 指向隔离目录', st && path.resolve(st.studyRoot) === path.resolve(studyRoot),
      `实际 ${st && st.studyRoot}`);
    check('课表总数解析为 2', st && st.planTotal === 2, `实际 ${st && st.planTotal}`);
    check('审阅总数汇总为 3', st && st.reviewTotal === 3, `实际 ${st && st.reviewTotal}`);
    check('术语状态读到 terms-state.json', st && st.terms && st.terms.hasData === true && st.terms.asked === 1,
      JSON.stringify(st && st.terms));
    check('掌握数为 0（无答题回流时不冒充）', st && st.terms && st.terms.mastered === 0,
      JSON.stringify(st && st.terms));
    check('待回流份数 = 已出课数 1', st && st.pendingReports === 1, `实际 ${st && st.pendingReports}`);
    check('两个 Agent 角色齐全且种类正确',
      st && st.agents && st.agents.length === 2
      && st.agents[0].kind === 'claude' && st.agents[1].kind === 'codex',
      JSON.stringify(st && st.agents && st.agents.map(a => a.kind)));

    // ---- 术语指标块口径：不能把「出过题」显示成「已掌握」----
    const termTile = await page.eval(`(() => {
      const t = document.querySelectorAll('#study-tiles .study-tile')[1];
      return t ? { k: t.querySelector('.k').textContent, v: t.querySelector('.v').textContent } : null;
    })()`);
    check('无答题回流时术语块显示「已出题」而不是「已掌握」',
      termTile && /已出题/.test(termTile.k), JSON.stringify(termTile));

    // ---- 侧栏 Agent 收纳 ----
    const groupRow = await page.eval(`(() => {
      const el = document.getElementById('session-agent-groups');
      if (!el) return 'missing';
      return { display: getComputedStyle(el).display, chips: el.querySelectorAll('.sag-chip').length };
    })()`);
    check('侧栏存在 Agent 收纳行容器', groupRow !== 'missing', JSON.stringify(groupRow));
    check('没有 Agent 会话时整行隐藏', groupRow && groupRow.display === 'none' && groupRow.chips === 0,
      JSON.stringify(groupRow));

    // ---- 侧栏 Agent 收纳：真的建两个学习会话再验开关 ----
    // 只创建会话、不发 prompt，所以不烧 token；这一步验的是分组、默认收起和开关行为。
    for (const role of ['author', 'reviewer']) {
      await page.eval(`require('electron').ipcRenderer.invoke('study:ensure-session', ${JSON.stringify({ role })})`);
    }
    await page.eval('new Promise(r=>setTimeout(r,2500))');

    const withAgents = await page.eval(`(() => {
      const el = document.getElementById('session-agent-groups');
      const chip = el && el.querySelector('.sag-chip[data-agent-group="study"]');
      const rows = document.querySelectorAll('#session-list [data-session-id]').length;
      const titles = Array.from(document.querySelectorAll('#session-list')).map(n => n.textContent).join(' ');
      return {
        display: el ? getComputedStyle(el).display : 'missing',
        chips: el ? el.querySelectorAll('.sag-chip').length : 0,
        chipText: chip ? chip.textContent.replace(/\s+/g, '') : '',
        chipOn: chip ? chip.classList.contains('on') : null,
        studyVisible: /学习 · 主笔/.test(titles),
        rows,
      };
    })()`);
    check('有 Agent 会话后收纳行出现', withAgents.display !== 'none' && withAgents.chips >= 1,
      JSON.stringify(withAgents));
    check('芯片显示分组名与条数（学习 2）', /学习2/.test(withAgents.chipText),
      `实际 ${withAgents.chipText}`);
    check('默认未勾选 → 学习会话被收起', withAgents.chipOn === false && withAgents.studyVisible === false,
      JSON.stringify(withAgents));

    // 建会话会直接亮出终端面板；主区是 flex，学习面板若没被隐藏就会和终端并排各占一半。
    const bothVisible = await page.eval(`(() => ({
      study: getComputedStyle(document.getElementById('study-panel')).display,
      terminal: getComputedStyle(document.getElementById('terminal-panel')).display,
    }))()`);
    check('建会话后学习面板自动让位，不与终端并排',
      bothVisible.study === 'none', JSON.stringify(bothVisible));

    // 重新打开面板，继续验开关
    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,800))');

    const afterToggle = await page.eval(`(() => {
      const chip = document.querySelector('.sag-chip[data-agent-group="study"]');
      if (!chip) return 'no-chip';
      chip.click();
      const titles = Array.from(document.querySelectorAll('#session-list')).map(n => n.textContent).join(' ');
      const again = document.querySelector('.sag-chip[data-agent-group="study"]');
      return { on: again.classList.contains('on'), studyVisible: /学习 · 主笔/.test(titles) };
    })()`);
    check('勾选后学习会话显示出来', afterToggle && afterToggle.on === true && afterToggle.studyVisible === true,
      JSON.stringify(afterToggle));

    const persisted = await page.eval(`localStorage.getItem('hubSessionAgentGroups')`);
    check('开关状态落盘（重开 Hub 保持）', /study/.test(String(persisted || '')), `实际 ${persisted}`);

    // ---- 与投研面板互斥 ----
    const exclusive = await page.eval(`(() => {
      const r = document.getElementById('btn-research');
      if (!r) return 'no-research-btn';
      r.click();
      return getComputedStyle(document.getElementById('study-panel')).display;
    })()`);
    check('打开投研时学习面板自动隐藏', exclusive === 'none', `实际 ${exclusive}`);

    // ---- 路径守卫 ----
    const guard = await page.eval(
      `require('electron').ipcRenderer.invoke('study:read-lesson', { path: ${JSON.stringify(path.join(dataDir, 'study-state.json'))} })`);
    check('study:read-lesson 拒绝越界读', guard && guard.ok === false && guard.error === 'path-outside-days',
      JSON.stringify(guard));

    const errs = await page.eval(`(window.__studyE2EErrors || []).length`).catch(() => 0);
    check('渲染进程无未捕获错误', !errs, `${errs} 个`);

  } catch (e) {
    check('E2E 执行', false, e && e.message);
  } finally {
    try { if (page && page.close) page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n学习 Tab · 真环境接线 E2E（隔离数据目录 + 独立 CDP 端口）\n');
  for (const [s, n, m] of results) console.log(`[${s}] ${n}${m ? '\n        ' + m : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} 通过 / ${failed} 失败 / 共 ${results.length}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E 异常：', e); process.exit(2); });
