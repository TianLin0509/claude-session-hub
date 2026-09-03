'use strict';
// tests/shot-study-dashboard.js — 给学习仪表盘和侧栏收纳截图（人工看效果用）
//   node tests/shot-study-dashboard.js [输出目录]
// 隔离数据目录 + 独立端口，不碰生产 Hub。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const OUT = process.argv[2] || path.join(os.tmpdir(), 'study-shots');
const PORT = Number(process.env.SHOT_PORT || 9345);

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'study-shot-'));
  const studyRoot = path.join(dataDir, 'agent-study');
  fs.mkdirSync(path.join(studyRoot, 'days'), { recursive: true });
  fs.writeFileSync(path.join(studyRoot, 'PLAN.md'), [
    '| # | 主题 |', '|---|---|',
    '| L1 | Agent 是什么 |', '| L2 | 工具设计 |', '| L3 | token 归因 |',
    '| L4 | 压缩与卸载 |', '| L5 | 评测起步 |',
  ].join('\n'), 'utf8');
  const mk = (id, title, reviews) => {
    fs.writeFileSync(path.join(studyRoot, 'days', `2026-09-02-${id}.html`),
      `<!DOCTYPE html><html><head><meta charset="utf-8"></head><body><h1>${title}</h1>`
      + 'x'.repeat(200000) + '</body></html>', 'utf8');
    fs.writeFileSync(path.join(studyRoot, 'days', `2026-09-02-${id}-review.md`),
      Array.from({ length: reviews }, (_, i) => `## ${i + 1}. 意见`).join('\n'), 'utf8');
  };
  mk('L1', 'Agent 是什么：一个带工具的循环', 16);
  mk('L2', '工具是写给模型看的 API 文档', 16);
  mk('L3', '上下文工程 I：token 去哪儿了', 14);
  fs.writeFileSync(path.join(studyRoot, 'TERMS.json'),
    JSON.stringify({ count: 166, terms: [{ term: 'Agent Loop' }] }), 'utf8');
  fs.writeFileSync(path.join(studyRoot, 'terms-state.json'), JSON.stringify({
    reportedLessons: [], terms: { 'Agent Loop': { asked: 3, correct: 0, wrong: 0 } },
  }), 'utf8');
  fs.writeFileSync(path.join(studyRoot, 'INSIGHTS.md'), '# 沉淀\n', 'utf8');

  let hub = null; let page = null;
  try {
    hub = await launchIsolatedHub({
      dataDir, port: PORT, label: 'study-shot',
      extraEnv: { AGENT_STUDY_DIR: studyRoot }, windowMode: 'visible',
    });
    page = await connectFirstPage(hub);
    await page.eval('new Promise(r=>setTimeout(r,3000))');
    await page.eval(`document.getElementById('btn-study').click()`);
    await page.eval('new Promise(r=>setTimeout(r,1500))');

    const shoot = async (name) => {
      const r = await page.send('Page.captureScreenshot', { format: 'png' });
      const file = path.join(OUT, name);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      console.log('截图:', file);
    };
    await shoot('dashboard.png');

    // 建两个学习会话，勾上收纳芯片，再截一次侧栏
    for (const role of ['author', 'reviewer']) {
      await page.eval(`require('electron').ipcRenderer.invoke('study:ensure-session', ${JSON.stringify({ role })})`);
    }
    await page.eval('new Promise(r=>setTimeout(r,3000))');
    await page.eval(`(() => { const c = document.querySelector('.sag-chip[data-agent-group="study"]'); if (c) c.click(); })()`);
    await page.eval('new Promise(r=>setTimeout(r,600))');
    await shoot('sidebar-groups.png');
  } catch (e) {
    console.error('异常：', e && e.message);
  } finally {
    try { if (page && page.close) page.close(); } catch {}
    try { if (hub) await gracefulQuit(hub); } catch {}
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch {}
  }
}
main();
