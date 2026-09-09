'use strict';
// Real transcript files -> search child / SQLite -> IPC -> physical facet clicks.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');

const ROOT = path.resolve(__dirname, '..');
const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-t3-search-facet-'));
const DATA = path.join(TEMP, 'data');
const HOME_DIR = path.join(TEMP, 'home');
const CLAUDE_ROOT = path.join(HOME_DIR, '.claude', 'projects');
const CODEX_ROOT = path.join(HOME_DIR, '.codex', 'sessions');
const KIMI_ROOT = path.join(HOME_DIR, '.kimi-code', 'sessions');
const GEMINI_ROOT = path.join(HOME_DIR, '.gemini', 'tmp');
const OUT = path.join(ROOT, 'artifacts', '20260908-T3-facet-fix-codex1');
const NEEDLE = 'facetbodyneedle';
const result = { dataDir: DATA, ok: false };

async function waitFor(label, read, timeout = 45000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await _waitMs(100);
  }
  throw new Error(`Timeout: ${label}`);
}

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function click(client, selector) {
  const point = await client.eval(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('Missing control: ' + ${JSON.stringify(selector)});
    const rect = element.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  })()`);
  await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
  await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', buttons: 1, clickCount: 1 });
  await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', buttons: 0, clickCount: 1 });
}

async function typeQuery(client, text) {
  await click(client, '#search-query');
  await client.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await client.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await client.send('Input.insertText', { text });
}

function writeFixtures() {
  const dir = path.join(CLAUDE_ROOT, 'T3-facet-fixtures');
  for (const folder of [DATA, dir, CODEX_ROOT, KIMI_ROOT, GEMINI_ROOT, OUT]) fs.mkdirSync(folder, { recursive: true });
  const now = Date.now() - 2 * 86400000;
  const sessions = [];
  for (let i = 0; i < 202; i += 1) {
    const sid = randomUUID();
    const timestamp = now - i * 1000;
    const transcriptPath = path.join(dir, `${sid}.jsonl`);
    fs.writeFileSync(transcriptPath, JSON.stringify({
      type: 'assistant', uuid: randomUUID(), timestamp: new Date(timestamp).toISOString(),
      message: { role: 'assistant', model: 'claude-sonnet', stop_reason: 'end_turn',
        content: [{ type: 'text', text: i === 201 ? 'leaguebodyneedle 投研正文' : `${NEEDLE} 完整正文命中` }] },
    }) + '\n', 'utf8');
    sessions.push({
      schemaVersion: 1, hubId: `hub-facet-${i}`, kind: 'claude', ccSessionId: sid,
      title: i === 200 ? '归档学习样本' : i === 201 ? '归档投研样本' : `普通记录 ${i}`,
      cwd: TEMP, transcriptPath, createdAt: timestamp, updatedAt: timestamp,
      lastMessageTime: timestamp, status: 'dormant',
      purpose: i === 200 ? 'study-companion' : i === 201 ? 'agent-league' : null,
    });
  }
  fs.writeFileSync(path.join(DATA, 'state.json'), JSON.stringify({ version: 1, cleanShutdown: true,
    sessions, meetings: [], immersiveByMeeting: {},
  }), 'utf8');
}

async function main() {
  writeFixtures();
  let hub, client;
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), label: 'T3-search-facet', windowMode: 'hidden',
      extraEnv: { CLAUDE_HUB_E2E: '1', CLAUDE_HUB_HOME_DIR: HOME_DIR,
        HUB_SESSION_SEARCH_CLAUDE_ROOTS: CLAUDE_ROOT, HUB_SESSION_SEARCH_CODEX_ROOTS: CODEX_ROOT,
        HUB_SESSION_SEARCH_KIMI_ROOTS: KIMI_ROOT, HUB_SESSION_SEARCH_GEMINI_ROOTS: GEMINI_ROOT,
      },
    });
    result.pid = hub.pid; result.port = hub.port;
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url));
    await client.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    await client.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1080, deviceScaleFactor: 1, mobile: false });
    await waitFor('search UI and restored catalogue', () => client.eval(`!!window.__hubE2E?.globalSessionSearch && sessions.size === 202`));
    assert.equal(await client.eval('process.env.CLAUDE_HUB_DATA_DIR'), DATA);
    result.index = await client.eval(`require('electron').ipcRenderer.invoke('refresh-session-search', { force: true })`);
    assert.equal(result.index.ready, true, JSON.stringify(result.index));
    assert.equal(result.index.index.sessions, 202, '索引只能包含本次构造的隔离会话');
    assert.equal(result.index.staleSources, 0);
    const unfiltered = await client.eval(`require('electron').ipcRenderer.invoke('search-past-sessions', {
      query: '${NEEDLE}', sort: 'recent', limit: 200
    })`);
    assert.equal(unfiltered.totalSessions, 201);
    assert.equal(unfiltered.results.length, 200);
    assert.equal(unfiltered.results.some(hit => hit.hubSessionId === 'hub-facet-200'), false);
    const titles = await client.eval(`require('electron').ipcRenderer.invoke('search-past-sessions', { query: '${NEEDLE}', scopes: ['title'] })`);
    assert.equal(titles.totalSessions, 0);
    result.globalQuery = { total: unfiltered.totalSessions, shown: unfiltered.results.length, targetAbsent: true, titleHits: 0 };

    await click(client, '.session-archive-entry');
    await waitFor('archive scope', () => client.eval(`window.__hubE2E.globalSessionSearch.state().activeScope === 'dormant'`));
    await click(client, '[data-agent="study"]');
    await typeQuery(client, NEEDLE);
    result.study = await waitFor('201st body result and full preview', () => client.eval(`(() => {
      const state = window.__hubE2E.globalSessionSearch.state();
      const snippet = document.querySelector('.session-search-result-snippet')?.textContent || '';
      return state.query === '${NEEDLE}' && state.activeAgent === 'study' && state.resultCount === 1
        && state.previewTitle === '归档学习样本' && snippet.includes('${NEEDLE}') ? { ...state, snippet } : null;
    })()`));
    assert.equal(result.study.totalSessions, 1);
    const screenshot = await client.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    fs.writeFileSync(path.join(OUT, 'T3-archive-search-201.png'), Buffer.from(screenshot.data, 'base64'));

    await click(client, '[data-agent="league"]');
    await waitFor('league excludes study body', () => client.eval(`(() => {
      const state = window.__hubE2E.globalSessionSearch.state();
      return state.activeAgent === 'league' && state.resultCount === 0
        && !document.querySelector('#search-modal').textContent.includes('全文检索中');
    })()`));
    await typeQuery(client, 'leaguebodyneedle');
    result.league = await waitFor('league body result', () => client.eval(`(() => {
      const state = window.__hubE2E.globalSessionSearch.state();
      return state.query === 'leaguebodyneedle' && state.resultCount === 1 && state.previewTitle === '归档投研样本' ? state : null;
    })()`));
    result.persistedFacets = await client.eval(`JSON.parse(localStorage.getItem('hub.search.facets'))`);
    assert.equal(result.persistedFacets.agent, 'league');
    result.ok = true;
  } catch (error) {
    result.error = error.stack;
    if (hub) result.hubLog = hub.log().slice(-60);
    throw error;
  } finally {
    try {
      if (client) await client.close();
    } finally {
      try { if (hub) result.shutdown = await gracefulQuit(hub); }
      catch (error) { result.ok = false; result.shutdownError = error.stack; throw error; }
      finally { fs.writeFileSync(path.join(OUT, '20260908-T3-facet-e2e-codex1.json'), JSON.stringify(result, null, 2), 'utf8'); }
    }
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(error => { console.error(error.stack); process.exitCode = 1; });
