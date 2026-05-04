// Spec 2 · S10 — E2E validation: card view + 圆桌 regression check
// Connects to isolated Hub via CDP (port 9350), runs 11 auto + 2 manual scenarios,
// then 圆桌 regression checks (function existence + IPC + transcript-tap diff).
//
// Prereq:
//   - Isolated Hub running at http://127.0.0.1:9350 (started via start-hub-spec1.bat)
//   - Production Hub MUST NOT be touched
//
// Run:
//   node "C:\\Users\\lintian\\hub-feat-ui-redesign-spec1\\tests\\e2e-spec2-card-view.js"
// Exit: 0 if all auto pass, 1 otherwise.

const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const http = require('http');

const HUB_ROOT = 'C:\\Users\\lintian\\hub-feat-ui-redesign-spec1';
const WS_MOD = path.join(HUB_ROOT, 'node_modules', 'ws');
const WebSocket = require(WS_MOD);

const TRANSCRIPT_FIXTURE = 'C:\\Users\\lintian\\.claude\\projects\\C--Users-lintian\\30a4345b-0083-4acc-8030-0fd8b3d5fded.jsonl';

// ---------- helpers ----------

function getCdpPageId() {
  return new Promise((resolve, reject) => {
    http.get('http://127.0.0.1:9350/json', (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const arr = JSON.parse(data);
          // Prefer renderer page (url contains index.html), else first
          const pick = arr.find((p) => p.type === 'page' && /index\.html/i.test(p.url || '')) || arr.find((p) => p.type === 'page') || arr[0];
          if (!pick) return reject(new Error('no CDP pages'));
          resolve(pick);
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

function makeEvaluator(wsUrl) {
  // Returns { evaluate(expr) -> Promise<value>, close() }
  const ws = new WebSocket(wsUrl);
  let nextId = 1;
  const pending = new Map();
  let opened = false;
  const ready = new Promise((resolve, reject) => {
    ws.on('open', () => { opened = true; resolve(); });
    ws.on('error', (e) => { if (!opened) reject(e); });
  });
  ws.on('message', (m) => {
    const data = JSON.parse(m.toString());
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      if (data.error) return reject(new Error('CDP error: ' + JSON.stringify(data.error)));
      const r = data.result && data.result.result;
      if (!r) return resolve(undefined);
      if (r.subtype === 'error') return reject(new Error('JS error in page: ' + (r.description || r.value)));
      if ('value' in r) return resolve(r.value);
      return resolve(r);
    }
  });
  function evaluate(expression, opts = {}) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        id, method: 'Runtime.evaluate',
        params: {
          expression,
          returnByValue: true,
          awaitPromise: !!opts.awaitPromise,
        },
      }));
    });
  }
  function close() { try { ws.close(); } catch {} }
  return { ready, evaluate, close };
}

// ---------- result tracking ----------

const results = []; // { id, label, status: 'PASS'|'FAIL'|'MANUAL', detail }
function record(id, label, status, detail = '') {
  results.push({ id, label, status, detail });
  const icon = status === 'PASS' ? '[PASS]' : status === 'FAIL' ? '[FAIL]' : '[MANUAL]';
  console.log(`${icon} ${id}. ${label}${detail ? '  --  ' + detail : ''}`);
}

// ---------- main ----------

(async () => {
  console.log('=== Spec 2 · S10 E2E Validation ===');
  let page;
  try {
    page = await getCdpPageId();
    console.log(`[setup] CDP page: ${page.id}  url=${page.url}`);
  } catch (e) {
    console.error(`[setup] FAILED to reach CDP: ${e.message}`);
    process.exit(2);
  }
  const ev = makeEvaluator(page.webSocketDebuggerUrl);
  try {
    await ev.ready;
  } catch (e) {
    console.error(`[setup] WS open failed: ${e.message}`);
    process.exit(2);
  }

  console.log('\n--- Phase 2: 13 scenarios ---');

  // 1. CSS variable + structural elements existence
  try {
    const probe = await ev.evaluate(`(() => {
      const cs = getComputedStyle(document.documentElement);
      return {
        purple1: cs.getPropertyValue('--ui-purple-1').trim(),
        purple2: cs.getPropertyValue('--ui-purple-2').trim(),
        viewToggle: !!document.querySelector('.view-toggle'),
        msgOverlay: !!document.getElementById('msg-overlay'),
        placeholder: !!document.querySelector('.msg-overlay-placeholder'),
      };
    })()`);
    const ok = probe.purple1 && probe.viewToggle && probe.msgOverlay;
    record(1, 'CSS vars + structural elements', ok ? 'PASS' : 'FAIL', JSON.stringify(probe));
  } catch (e) { record(1, 'CSS vars + structural elements', 'FAIL', e.message); }

  // 2. Default view = 'card'
  try {
    const view = await ev.evaluate(`typeof currentView !== 'undefined' ? currentView : (window.currentView || null)`);
    record(2, 'Default view = card', view === 'card' ? 'PASS' : 'FAIL', `currentView=${JSON.stringify(view)}`);
  } catch (e) { record(2, 'Default view = card', 'FAIL', e.message); }

  // 3. Mock turn injection + render
  try {
    // Clear any previous test cards first
    await ev.evaluate(`(() => {
      const ov = document.getElementById('msg-overlay');
      if (ov) ov.querySelectorAll('.turn-card[data-turn-id^="s10-"]').forEach(c => c.remove());
      return true;
    })()`);
    const r = await ev.evaluate(`(() => {
      const turn = { id: 's10-mock-1', role: 'assistant', text: 'hello from S10 test', ts: Date.now(), kind: 'claude' };
      const el = window._mountSessionTurnCard ? window._mountSessionTurnCard('test-sid', turn) : null;
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-1"]');
      return { mounted: !!el, cardInDom: !!card, html: card ? card.outerHTML.slice(0, 200) : null };
    })()`);
    const ok = r.mounted && r.cardInDom;
    record(3, 'Mock turn render via mountSessionTurnCard', ok ? 'PASS' : 'FAIL', JSON.stringify({ mounted: r.mounted, cardInDom: r.cardInDom }));
  } catch (e) { record(3, 'Mock turn render via mountSessionTurnCard', 'FAIL', e.message); }

  // 4. Tool fold (>15 lines)
  try {
    const r = await ev.evaluate(`(() => {
      const longStdout = Array.from({length: 25}, (_, i) => 'line-' + (i+1)).join('\\n');
      const turn = {
        id: 's10-mock-tool',
        role: 'assistant',
        text: 'tool test',
        ts: Date.now(),
        kind: 'claude',
        toolCalls: [{ name: 'bash', cmd: 'ls', stdout: longStdout, ok: true, durationMs: 100 }],
      };
      const el = window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-tool"]');
      const tc = card ? card.querySelector('.tc') : null;
      const expandBtn = card ? card.querySelector('[data-action="tc-expand"]') : null;
      return { hasToolBlock: !!tc, hasExpandToggle: !!expandBtn, foldText: expandBtn ? expandBtn.textContent : null };
    })()`);
    const ok = r.hasToolBlock && r.hasExpandToggle;
    record(4, 'Tool block folded (>15 lines)', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(4, 'Tool block folded (>15 lines)', 'FAIL', e.message); }

  // 5. Code block prism highlight
  try {
    const r = await ev.evaluate(`(() => {
      const text = '示例代码:\\n\\n\`\`\`javascript\\nconsole.log(\"hi\")\\nfunction foo(){return 1}\\n\`\`\`\\n';
      const turn = { id: 's10-mock-code', role: 'assistant', text, ts: Date.now(), kind: 'claude' };
      window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-code"]');
      const codeEl = card ? card.querySelector('pre > code') : null;
      const tokenKw = card ? card.querySelector('.token.keyword, .token.function') : null;
      return { hasCode: !!codeEl, hasToken: !!tokenKw, prismLoaded: !!(window.Prism && window.Prism.languages && window.Prism.languages.javascript) };
    })()`);
    const ok = r.hasCode && r.hasToken;
    record(5, 'Code block prism highlight', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(5, 'Code block prism highlight', 'FAIL', e.message); }

  // 6. Long code block fold
  try {
    const r = await ev.evaluate(`(() => {
      const lines = Array.from({length: 35}, (_, i) => 'var x' + i + ' = ' + i + ';').join('\\n');
      const text = '\`\`\`javascript\\n' + lines + '\\n\`\`\`';
      const turn = { id: 's10-mock-longcode', role: 'assistant', text, ts: Date.now(), kind: 'claude' };
      window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-longcode"]');
      const wrap = card ? card.querySelector('.code-block-wrap') : null;
      const toggle = card ? card.querySelector('.code-toggle') : null;
      return { hasWrap: !!wrap, hasToggle: !!toggle, toggleText: toggle ? toggle.textContent.slice(0, 50) : null, lines: wrap ? wrap.dataset.lines : null };
    })()`);
    const ok = r.hasWrap && r.hasToggle;
    record(6, 'Long code block has fold toggle', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(6, 'Long code block has fold toggle', 'FAIL', e.message); }

  // 7. Path link recognition
  try {
    const r = await ev.evaluate(`(() => {
      const turn = { id: 's10-mock-path', role: 'assistant', text: 'see src/foo.md for details', ts: Date.now(), kind: 'claude' };
      window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-path"]');
      const link = card ? card.querySelector('.rt-file-link[data-path="src/foo.md"]') : null;
      return { hasLink: !!link, allLinks: card ? Array.from(card.querySelectorAll('.rt-file-link')).map(a => a.dataset.path) : [] };
    })()`);
    const ok = r.hasLink;
    record(7, 'Path link recognized (src/foo.md)', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(7, 'Path link recognized (src/foo.md)', 'FAIL', e.message); }

  // 8. Operation buttons (copy + regen on assistant card)
  try {
    const r = await ev.evaluate(`(() => {
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-1"]');
      const copy = card ? card.querySelector('.ta-btn[data-action="copy"]') : null;
      const regen = card ? card.querySelector('.ta-btn[data-action="regen"]') : null;
      // Also check user variant
      const turn = { id: 's10-mock-user', role: 'user', text: 'hi', ts: Date.now() };
      window._mountSessionTurnCard('test-sid', turn);
      const ucard = document.querySelector('.turn-card[data-turn-id="s10-mock-user"]');
      const resend = ucard ? ucard.querySelector('.ta-btn[data-action="resend"]') : null;
      const editResend = ucard ? ucard.querySelector('.ta-btn[data-action="edit-resend"]') : null;
      return { copy: !!copy, regen: !!regen, resend: !!resend, editResend: !!editResend };
    })()`);
    const ok = r.copy && r.regen && r.resend && r.editResend;
    record(8, 'Operation buttons (copy/regen/resend/edit-resend)', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(8, 'Operation buttons', 'FAIL', e.message); }

  // 9. Thinking collapsed by default
  try {
    const r = await ev.evaluate(`(() => {
      const turn = { id: 's10-mock-think', role: 'assistant', text: 'answer text', ts: Date.now(), kind: 'claude', thinking: 'this is the thought process step 1\\nstep 2\\nstep 3' };
      window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-think"]');
      const details = card ? card.querySelector('details.turn-thinking') : null;
      const summary = details ? details.querySelector('summary.turn-thinking-summary') : null;
      return { hasDetails: !!details, hasSummary: !!summary, openAttr: details ? details.hasAttribute('open') : null, summaryText: summary ? summary.textContent.slice(0, 30) : null };
    })()`);
    const ok = r.hasDetails && r.hasSummary && r.openAttr === false;
    record(9, 'Thinking field collapsed by default', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(9, 'Thinking field collapsed by default', 'FAIL', e.message); }

  // 10. Long thinking preview (>5120 chars)
  try {
    const r = await ev.evaluate(`(() => {
      const longThink = '甲'.repeat(6000);
      const turn = { id: 's10-mock-think-long', role: 'assistant', text: 'a', ts: Date.now(), kind: 'claude', thinking: longThink };
      window._mountSessionTurnCard('test-sid', turn);
      const card = document.querySelector('.turn-card[data-turn-id="s10-mock-think-long"]');
      const summary = card ? card.querySelector('summary.turn-thinking-summary') : null;
      const txt = summary ? summary.textContent : '';
      return { hasSummary: !!summary, includesPreview: txt.includes('前 200 字符'), summarySnippet: txt.slice(0, 80) };
    })()`);
    const ok = r.hasSummary && r.includesPreview;
    record(10, 'Long thinking shows preview prefix', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(10, 'Long thinking shows preview prefix', 'FAIL', e.message); }

  // 11. parse-session-transcript IPC + tool_result not surfaced as user text
  try {
    const r = await ev.evaluate(`(async () => {
      const { ipcRenderer } = require('electron');
      const res = await ipcRenderer.invoke('parse-session-transcript', { transcriptPath: ${JSON.stringify(TRANSCRIPT_FIXTURE)}, opts: { limit: 200, fromTail: true } });
      const turns = res.turns || [];
      // Check no user turn has tool_result-like content (typical patterns: starts with "[Request interrupted" or contains JSON tool_use_id markers)
      const offenders = turns.filter(t => t.role === 'user' && typeof t.text === 'string' && (
        /tool_use_id/i.test(t.text) ||
        /^\\[?\\s*\\{?\\s*\"type\"\\s*:\\s*\"tool_result\"/i.test(t.text)
      ));
      return { count: turns.length, offenderCount: offenders.length, error: res.error, offenderSample: offenders.slice(0, 2).map(t => (t.text||'').slice(0, 100)) };
    })()`, { awaitPromise: true });
    const ok = (r.count > 0 || r.error == null) && r.offenderCount === 0;
    record(11, 'tool_result not shown as user text (real fixture)', ok ? 'PASS' : 'FAIL', JSON.stringify(r));
  } catch (e) { record(11, 'tool_result not shown as user text (real fixture)', 'FAIL', e.message); }

  // 12-15. MANUAL scenarios
  record(12, 'Real session switch (need actual Claude CLI process)', 'MANUAL', 'requires user-triggered Claude session start in Hub');
  record(13, 'Real assistant turn-complete (need actual Claude CLI generating)', 'MANUAL', 'requires real Claude turn-completion');
  record(14, 'openPreviewPanel for .md path click', 'MANUAL', 'requires user mouse click on .rt-file-link');
  record(15, 'Hover for .ta-btn visibility', 'MANUAL', 'requires real mouse hover on turn card');

  // ---------- Phase 3: 圆桌 regression ----------
  console.log('\n--- Phase 3: 圆桌 regression ---');

  // R1. Renderer 圆桌 functions intact (grep meeting-room.js)
  try {
    const mrPath = path.join(HUB_ROOT, 'renderer', 'meeting-room.js');
    const src = fs.readFileSync(mrPath, 'utf8');
    const hasFusedTabs = /function\s+_renderFusedTabs\s*\(/.test(src);
    const hasPreviewBlocks = /function\s+_renderPreviewBlocks\s*\(/.test(src);
    const ok = hasFusedTabs && hasPreviewBlocks;
    record('R1', 'renderer/meeting-room.js: _renderFusedTabs + _renderPreviewBlocks intact', ok ? 'PASS' : 'FAIL', JSON.stringify({ hasFusedTabs, hasPreviewBlocks }));
  } catch (e) { record('R1', 'renderer/meeting-room.js intact', 'FAIL', e.message); }

  // R2. core/meeting-room.js appendTurn intact
  try {
    const cmPath = path.join(HUB_ROOT, 'core', 'meeting-room.js');
    const src = fs.readFileSync(cmPath, 'utf8');
    const hasAppendTurn = /\bappendTurn\s*\(/.test(src);
    record('R2', 'core/meeting-room.js: appendTurn intact', hasAppendTurn ? 'PASS' : 'FAIL', JSON.stringify({ hasAppendTurn }));
  } catch (e) { record('R2', 'core/meeting-room.js intact', 'FAIL', e.message); }

  // R3. main.js still emits meeting-timeline-updated
  try {
    const mainPath = path.join(HUB_ROOT, 'main.js');
    const src = fs.readFileSync(mainPath, 'utf8');
    const matches = (src.match(/meeting-timeline-updated/g) || []).length;
    record('R3', `main.js emits 'meeting-timeline-updated' (count=${matches})`, matches >= 2 ? 'PASS' : 'FAIL', `${matches} occurrences`);
  } catch (e) { record('R3', 'main.js emits meeting-timeline-updated', 'FAIL', e.message); }

  // R4. core/transcript-tap.js: 0 lines changed since spec1 baseline (06d0ab1)
  try {
    let diffLines = 0;
    try {
      const out = execSync(`git -C "${HUB_ROOT}" log --oneline 06d0ab1..HEAD -- core/transcript-tap.js`, { encoding: 'utf8' });
      diffLines = out.trim() ? out.trim().split('\n').length : 0;
    } catch (e) { diffLines = -1; }
    record('R4', 'core/transcript-tap.js: 0 commits since spec1 baseline (06d0ab1)', diffLines === 0 ? 'PASS' : 'FAIL', `commits since baseline: ${diffLines}`);
  } catch (e) { record('R4', 'core/transcript-tap.js: 0 commits since spec1', 'FAIL', e.message); }

  // R5. MANUAL — real meeting flow
  record('R5', 'New meeting → 3 sub-sessions added → fanout turn → cards render', 'MANUAL', 'user must open meeting and verify圆桌 UI');

  ev.close();

  // ---------- Summary ----------
  console.log('\n=== Summary ===');
  const auto = results.filter(r => r.status !== 'MANUAL');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const manual = results.filter(r => r.status === 'MANUAL').length;
  console.log(`Auto: ${passed}/${auto.length} pass, ${failed} fail`);
  console.log(`Manual: ${manual} scenario(s) for user`);
  if (failed > 0) {
    console.log('\nFAILED scenarios:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  - ${r.id}. ${r.label}: ${r.detail}`));
  }
  process.exit(failed > 0 ? 1 : 0);
})().catch((e) => {
  console.error('FATAL:', e.stack || e.message);
  process.exit(2);
});
