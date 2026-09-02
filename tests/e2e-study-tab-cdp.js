'use strict';
// tests/e2e-study-tab-cdp.js
//
// 学习 Tab 的真环境验证：拉起一个**隔离数据目录 + 独立 CDP 端口**的 Hub，
// 点开「学习」按钮，检查面板、双 Agent 切换、IPC 是否都通。
//
//   node tests/e2e-study-tab-cdp.js
//
// 刻意不碰生产 Hub：CLAUDE_HUB_DATA_DIR 走临时目录，端口另开，
// 结束后 gracefulQuit 只关自己 spawn 的那个进程。
//
// 这里**不真的调用 CLI**（不烧 token、不依赖网络）。真实 CLI 编排由
// tests/study-orchestration.test.js 用替身覆盖；这里验证的是渲染进程接线：
// 按钮 → 面板显隐 → 骨架结构 → IPC 通道 → 与投研面板互斥。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const PORT = Number(process.env.STUDY_E2E_PORT || 9333);
const results = [];
const ok = (n) => results.push(['PASS', n]);
const bad = (n, m) => results.push(['FAIL', n, m]);

function check(name, cond, detail) {
  if (cond) ok(name); else bad(name, detail || '断言失败');
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-e2e-'));
  const studyRoot = path.join(dataDir, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'),
    ['| # | 主题 |', '|---|---|', '| L1 | 冒烟用课程 |'].join('\n'), 'utf8');
  // 放一张假的成品卡，验证左栏能读能渲染
  fs.writeFileSync(path.join(studyRoot, 'days', '2026-09-02-L1.html'),
    '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1 id="probe">冒烟课程</h1></body></html>', 'utf8');

  let hub = null; let page = null;
  try {
    hub = await launchIsolatedHub({
      dataDir, port: PORT, label: 'study-e2e',
      extraEnv: { AGENT_STUDY_DIR: studyRoot, CLAUDE_HUB_E2E: '1' },
      windowMode: 'visible',
    });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,2500))');

    // 1. nav 按钮存在
    const navOk = await page.eval(`(() => {
      const b = document.getElementById('btn-study');
      return b ? b.textContent.trim() : '';
    })()`);
    check('nav 里有「学习」按钮', String(navOk).includes('学习'), `实际：${navOk}`);

    // 2. 面板初始隐藏
    const initHidden = await page.eval(`getComputedStyle(document.getElementById('study-panel')).display`);
    check('面板初始不显示', initHidden === 'none', `实际 display=${initHidden}`);

    // 3. 点击后打开
    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,1200))');
    const shown = await page.eval(`getComputedStyle(document.getElementById('study-panel')).display`);
    check('点击后面板显示', shown === 'grid', `实际 display=${shown}`);

    // 4. 骨架结构
    const skeleton = await page.eval(`(() => {
      const q = (s) => !!document.querySelector(s);
      return {
        tabs: document.querySelectorAll('#study-panel .study-tab').length,
        head: q('#study-panel .study-head'),
        lessonCol: q('#study-lesson-col'),
        output: q('#study-output'),
        ask: q('#study-ask-input'),
        runBtn: q('#study-run'),
        select: q('#study-lesson-select'),
      };
    })()`);
    check('右栏有两个 Agent 页签', skeleton.tabs === 2, `实际 ${skeleton.tabs} 个`);
    check('顶部条 / 左栏 / 输出区 / 输入框 / 生成按钮 / 课程选择器齐全',
      skeleton.head && skeleton.lessonCol && skeleton.output && skeleton.ask && skeleton.runBtn && skeleton.select,
      JSON.stringify(skeleton));

    // 5. 两个页签的文案分别是 Claude 与 Codex
    const tabTexts = await page.eval(`Array.from(document.querySelectorAll('#study-panel .study-tab')).map(t=>t.textContent.trim())`);
    check('页签一是 Claude 主笔', String(tabTexts[0] || '').includes('Claude'), JSON.stringify(tabTexts));
    check('页签二是 Codex 审阅', String(tabTexts[1] || '').includes('Codex'), JSON.stringify(tabTexts));

    // 6. study:state IPC 通，且识别到隔离的学习目录
    const st = await page.eval(`require('electron').ipcRenderer.invoke('study:state')`);
    check('study:state 返回 ok', st && st.ok === true, JSON.stringify(st && st.error));
    check('studyRoot 指向隔离目录', st && path.resolve(st.studyRoot) === path.resolve(studyRoot), `实际 ${st && st.studyRoot}`);
    check('识别到两个 Agent 角色', st && st.agents && st.agents.length === 2, JSON.stringify(st && st.agents));
    check('角色种类是 claude 与 codex',
      st && st.agents && st.agents[0].kind === 'claude' && st.agents[1].kind === 'codex',
      JSON.stringify(st && st.agents && st.agents.map(a => a.kind)));
    check('扫描到已有的一张成品卡', st && st.lessons && st.lessons.length === 1, JSON.stringify(st && st.lessons && st.lessons.length));
    check('课表解析出 L1 且已出成品故 nextLessonId 为空',
      st && st.nextLessonId === null, `实际 ${st && st.nextLessonId}`);

    // 7. 左栏 iframe 真的把课程渲染出来了
    await page.eval('new Promise(r=>setTimeout(r,900))');
    const frameOk = await page.eval(`(() => {
      const f = document.querySelector('#study-lesson-col iframe');
      if (!f) return 'no-iframe';
      try { return f.contentDocument && f.contentDocument.getElementById('probe') ? 'rendered' : 'no-probe'; }
      catch (e) { return 'x:' + e.message; }
    })()`);
    check('左栏 iframe 渲染出课程内容', frameOk === 'rendered', `实际 ${frameOk}`);

    // 8. 切到 Codex 页签
    await page.eval(`document.querySelector('#study-panel .study-tab[data-role="reviewer"]').click()`);
    await page.eval('new Promise(r=>setTimeout(r,400))');
    const activeTab = await page.eval(`(() => {
      const on = document.querySelector('#study-panel .study-tab.on');
      return on ? on.dataset.role : '';
    })()`);
    check('可以切到 Codex 页签', activeTab === 'reviewer', `实际 ${activeTab}`);

    // 9. 与投研面板互斥
    const exclusive = await page.eval(`(() => {
      const r = document.getElementById('btn-research');
      if (!r) return 'no-research-btn';
      r.click();
      return getComputedStyle(document.getElementById('study-panel')).display;
    })()`);
    check('打开投研时学习面板自动隐藏', exclusive === 'none', `实际 ${exclusive}`);

    // 10. 路径守卫仍然生效（真环境下）
    const guard = await page.eval(`require('electron').ipcRenderer.invoke('study:read-lesson', { path: ${JSON.stringify(path.join(dataDir, 'study-state.json'))} })`);
    check('study:read-lesson 在真环境下也拒绝越界读', guard && guard.ok === false && guard.error === 'path-outside-days', JSON.stringify(guard));

    // 11. 渲染进程没有报错
    const errs = await page.eval(`(window.__studyE2EErrors || []).length`).catch(() => 0);
    check('渲染进程无未捕获错误', !errs, `${errs} 个`);

  } catch (e) {
    bad('E2E 执行', e && e.message);
  } finally {
    try { if (page) page.close && page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }

  console.log('\n学习 Tab · 真环境 E2E（隔离数据目录 + 独立 CDP 端口）\n');
  for (const [s, n, m] of results) console.log(`[${s}] ${n}${m ? '\n        ' + m : ''}`);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} 通过 / ${failed} 失败 / 共 ${results.length}\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('E2E 异常：', e); process.exit(2); });
