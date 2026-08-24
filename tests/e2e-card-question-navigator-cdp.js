'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { launchIsolatedHub, gracefulQuit, _waitMs } = require('./helpers/hub-launcher.js');
const { connectFirstPage } = require('./helpers/cdp-client.js');

const ROOT = path.resolve(__dirname, '..');
const RUN_ID = `${Date.now()}-${process.pid}`;
const ARTIFACT_DIR = path.join(ROOT, 'output', 'playwright', 'card-question-navigator');
const SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `question-navigator-${RUN_ID}.png`);
const RESPONSIVE_SCREENSHOT_PATH = path.join(ARTIFACT_DIR, `question-navigator-responsive-${RUN_ID}.png`);
const RESULT_PATH = path.join(ARTIFACT_DIR, `question-navigator-${RUN_ID}.json`);

function canListen(port) {
  return new Promise(resolve => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => server.close(() => resolve(true)));
    server.listen(port, '127.0.0.1');
  });
}

async function availablePort(preferred) {
  for (let port = preferred; port < preferred + 50; port += 1) {
    if (await canListen(port)) return port;
  }
  throw new Error('no free CDP port');
}

async function waitFor(client, expression, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try { if (await client.eval(expression)) return; } catch {}
    await _waitMs(100);
  }
  throw new Error(`timeout waiting for ${label}`);
}

(async () => {
  const tempRoot = path.join(os.tmpdir(), `hub-card-question-nav-${RUN_ID}`);
  const dataDir = path.join(tempRoot, 'hub-data');
  const homeDir = path.join(tempRoot, 'home');
  const port = await availablePort(Number(process.env.HUB_CARD_QUESTION_NAV_E2E_PORT || 19641));
  let hub = null;
  let client = null;
  let testBodyPassed = false;
  const result = { runId: RUN_ID, port };
  try {
    fs.mkdirSync(ARTIFACT_DIR, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(homeDir, { recursive: true });
    hub = await launchIsolatedHub({
      dataDir,
      port,
      label: 'card-question-navigator',
      windowMode: 'hidden',
      extraEnv: {
        CLAUDE_HUB_E2E: '1',
        CLAUDE_HUB_HOME_DIR: homeDir,
        DEEPSEEK_API_KEY: '',
      },
    });
    await _waitMs(1400);
    client = await connectFirstPage(hub, target => target.type === 'page' && /renderer[\\/]index\.html/.test(target.url || ''));
    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 1500,
      height: 960,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await waitFor(
      client,
      `document.readyState === 'complete'
        && window.__hubE2E?.cardQuestionNavigator
        && typeof window._mountSessionTurnCard === 'function'`,
      'card question navigator ready',
    );

    result.fixture = await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture()`);
    assert.equal(result.fixture.state.count, 6);
    assert.equal(result.fixture.state.visible, true);
    assert.ok(result.fixture.navRefreshMs < 50, JSON.stringify(result.fixture));
    assert.ok(result.fixture.scrollHeight > result.fixture.clientHeight * 2, JSON.stringify(result.fixture));

    await waitFor(
      client,
      `document.querySelectorAll('#card-question-nav .card-question-nav-item').length === 6
        && !document.getElementById('card-question-nav').hidden`,
      'six visible question markers',
    );
    result.initial = await client.eval(`(() => {
      const root = document.getElementById('card-question-nav');
      const overlay = document.getElementById('msg-overlay');
      const buttons = [...root.querySelectorAll('.card-question-nav-item')];
      buttons[2].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
      return {
        state: window.__hubE2E.cardQuestionNavigator.state(),
        markerTexts: buttons.map(button => button.textContent.trim()),
        tabStops:buttons.filter(button => button.tabIndex === 0).map(button => Number(button.dataset.questionIndex)),
        dotCount: root.querySelectorAll('.card-question-nav-dot').length,
        labels: buttons.map(button => button.getAttribute('aria-label')),
        tooltipHidden: root.querySelector('.card-question-nav-tooltip').hidden,
        tooltipText: root.querySelector('.card-question-nav-tooltip').textContent.trim(),
        overlayPaddingRight: getComputedStyle(overlay).paddingRight,
      };
    })()`);
    assert.deepEqual(result.initial.markerTexts, ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6']);
    assert.equal(result.initial.tabStops.length, 1);
    assert.equal(result.initial.tabStops[0], result.initial.state.activeIndex);
    assert.equal(result.initial.dotCount, 6);
    assert.equal(result.initial.tooltipHidden, false);
    assert.match(result.initial.tooltipText, /问题 3 \/ 6[\s\S]*第 3 个方案/);
    assert.ok(result.initial.labels.every(label => /^跳转到问题 \d/.test(label)));

    await client.eval(`document.querySelectorAll('#card-question-nav .card-question-nav-item')[3].click()`);
    result.highlightedImmediately = await client.eval(
      `document.querySelector('.turn-card[data-turn-id="question-4"]').classList.contains('question-jump-highlight')`
    );
    assert.equal(result.highlightedImmediately, true);
    await _waitMs(500);
    result.clicked = await client.eval(`(() => {
      const overlay = document.getElementById('msg-overlay');
      const card = overlay.querySelector('.turn-card[data-turn-id="question-4"]');
      return {
        state: window.__hubE2E.cardQuestionNavigator.state(),
        relativeTop: card.getBoundingClientRect().top - overlay.getBoundingClientRect().top,
        scrollTop: overlay.scrollTop,
      };
    })()`);
    assert.equal(result.clicked.state.activeIndex, 3);
    assert.ok(Math.abs(result.clicked.relativeTop - 10) < 8, JSON.stringify(result.clicked));
    assert.ok(result.clicked.scrollTop > 0);

    result.keyboard = await client.eval(`(() => {
      const button = document.querySelectorAll('#card-question-nav .card-question-nav-item')[3];
      button.focus();
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
      return {
        state: window.__hubE2E.cardQuestionNavigator.state(),
        focusedIndex: Number(document.activeElement.dataset.questionIndex),
        tabStops:[...document.querySelectorAll('#card-question-nav .card-question-nav-item')]
          .filter(item => item.tabIndex === 0)
          .map(item => Number(item.dataset.questionIndex)),
      };
    })()`);
    assert.equal(result.keyboard.state.activeIndex, 4);
    assert.equal(result.keyboard.focusedIndex, 4);
    assert.deepEqual(result.keyboard.tabStops, [4]);

    result.bottom = await client.eval(`(() => {
      const overlay = document.getElementById('msg-overlay');
      overlay.scrollTop = overlay.scrollHeight;
      window.__hubE2E.cardQuestionNavigator.update();
      return {
        state:window.__hubE2E.cardQuestionNavigator.state(),
        scrollTop:overlay.scrollTop,
        scrollHeight:overlay.scrollHeight,
        clientHeight:overlay.clientHeight,
        remaining:overlay.scrollHeight - overlay.scrollTop - overlay.clientHeight,
      };
    })()`);
    assert.equal(result.bottom.state.activeIndex, 5, JSON.stringify(result.bottom));

    await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({
      sessionId: 'card-question-nav-e2e', start: 7, count: 1, clear: false
    })`);
    await waitFor(
      client,
      `window.__hubE2E.cardQuestionNavigator.state().count === 7`,
      'incremental seventh marker',
    );
    result.incremental = await client.eval(`window.__hubE2E.cardQuestionNavigator.state()`);
    assert.match(result.incremental.summaries[6], /实时追加的新问题/);

    result.viewModes = await client.eval(`(() => {
      window.__hubE2E.cardQuestionNavigator.setViewMode('pty');
      const hiddenInPty = document.getElementById('card-question-nav').hidden;
      window.__hubE2E.cardQuestionNavigator.setViewMode('card');
      window.__hubE2E.cardQuestionNavigator.refresh();
      return {
        hiddenInPty,
        visibleBackInCard: !document.getElementById('card-question-nav').hidden,
        preservedCount: window.__hubE2E.cardQuestionNavigator.state().count,
      };
    })()`);
    assert.deepEqual(result.viewModes, { hiddenInPty: true, visibleBackInCard: true, preservedCount: 7 });

    result.preserve = await client.eval(`(() => {
      const root = document.getElementById('card-question-nav');
      window.__hubE2E.cardQuestionNavigator.preservePanel();
      window.__hubE2E.cardQuestionNavigator.refresh();
      return {
        connected: root.isConnected,
        sameNode: root === document.getElementById('card-question-nav'),
        count: window.__hubE2E.cardQuestionNavigator.state().count,
      };
    })()`);
    assert.deepEqual(result.preserve, { connected: true, sameNode: true, count: 7 });

    await client.eval(`(() => {
      const buttons = document.querySelectorAll('#card-question-nav .card-question-nav-item');
      buttons[4].dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    })()`);
    const desktopScreenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(SCREENSHOT_PATH, Buffer.from(desktopScreenshot.data, 'base64'));

    await client.send('Emulation.setDeviceMetricsOverride', {
      // Match the user's captured narrow-window geometry closely.
      width: 502,
      height: 1600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({
      sessionId: 'card-question-nav-dense', start: 1, count: 24, clear: true
    })`);
    await waitFor(
      client,
      `window.__hubE2E.cardQuestionNavigator.state().count === 24
        && document.getElementById('card-question-nav').classList.contains('dense')`,
      'dense 24-question rail',
    );
    await client.eval(`(() => {
      window.__hubE2E.cardQuestionNavigator.scrollTo(11);
      const button = document.querySelectorAll('#card-question-nav .card-question-nav-item')[11];
      button.dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
    })()`);
    await _waitMs(180);
    result.responsive = await client.eval(`(() => {
      const markerRects = [...document.querySelectorAll('#card-question-nav .card-question-nav-item')]
        .map(item => item.getBoundingClientRect());
      const tooltipRect = document.querySelector('#card-question-nav .card-question-nav-tooltip').getBoundingClientRect();
      return ({
      viewportWidth: innerWidth,
      bodyScrollWidth: document.body.scrollWidth,
      navRight: getComputedStyle(document.getElementById('card-question-nav')).right,
      visible: !document.getElementById('card-question-nav').hidden,
      dense: document.getElementById('card-question-nav').classList.contains('dense'),
      veryDense: document.getElementById('card-question-nav').classList.contains('very-dense'),
      markerCount: document.querySelectorAll('#card-question-nav .card-question-nav-item').length,
      activeText: document.querySelector('#card-question-nav .card-question-nav-item.active').textContent.trim(),
      activeLabelOpacity: getComputedStyle(document.querySelector('#card-question-nav .card-question-nav-item.active .card-question-nav-label')).opacity,
      inactiveLabelOpacity: getComputedStyle(document.querySelector('#card-question-nav .card-question-nav-item:not(.active) .card-question-nav-label')).opacity,
      tooltipText: document.querySelector('#card-question-nav .card-question-nav-tooltip').textContent.trim(),
      tooltipWidth:tooltipRect.width,
      minMarkerWidth:Math.min(...markerRects.map(rect => rect.width)),
      minMarkerHeight:Math.min(...markerRects.map(rect => rect.height)),
      tooltipTop:tooltipRect.top,
      tooltipBottom:tooltipRect.bottom,
    });
    })()`);
    assert.equal(result.responsive.bodyScrollWidth, result.responsive.viewportWidth);
    assert.equal(result.responsive.visible, true);
    assert.equal(result.responsive.dense, true);
    assert.equal(result.responsive.veryDense, false);
    assert.equal(result.responsive.markerCount, 24);
    assert.equal(result.responsive.activeText, 'Q12');
    assert.equal(result.responsive.activeLabelOpacity, '1');
    assert.equal(result.responsive.inactiveLabelOpacity, '0');
    assert.match(result.responsive.tooltipText, /问题 12 \/ 24/);
    assert.ok(result.responsive.tooltipWidth <= 181, JSON.stringify(result.responsive));
    assert.ok(result.responsive.minMarkerWidth >= 24, JSON.stringify(result.responsive));
    assert.ok(result.responsive.minMarkerHeight >= 24, JSON.stringify(result.responsive));
    assert.ok(result.responsive.tooltipTop >= 0 && result.responsive.tooltipBottom <= 1600, JSON.stringify(result.responsive));

    const responsiveScreenshot = await client.send('Page.captureScreenshot', { format: 'png', fromSurface: true });
    fs.writeFileSync(RESPONSIVE_SCREENSHOT_PATH, Buffer.from(responsiveScreenshot.data, 'base64'));

    await client.send('Emulation.setDeviceMetricsOverride', {
      width: 502,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({
      sessionId: 'card-question-nav-very-dense', start: 1, count: 32, clear: true
    })`);
    await waitFor(
      client,
      `window.__hubE2E.cardQuestionNavigator.state().count === 32
        && document.getElementById('card-question-nav').classList.contains('very-dense')`,
      'very-dense short question rail',
    );
    result.veryDense = await client.eval(`(() => {
      const root = document.getElementById('card-question-nav');
      const track = root.querySelector('.card-question-nav-track');
      const buttons = [...root.querySelectorAll('.card-question-nav-item')];
      buttons[0].dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
      const firstRect = root.querySelector('.card-question-nav-tooltip').getBoundingClientRect();
      buttons[0].dispatchEvent(new MouseEvent('mouseleave', { bubbles:true }));
      buttons.at(-1).dispatchEvent(new MouseEvent('mouseenter', { bubbles:true }));
      const lastRect = root.querySelector('.card-question-nav-tooltip').getBoundingClientRect();
      const markerRects = buttons.map(button => button.getBoundingClientRect());
      return {
        classApplied:root.classList.contains('very-dense'),
        trackScrollHeight:track.scrollHeight,
        trackClientHeight:track.clientHeight,
        minMarkerWidth:Math.min(...markerRects.map(rect => rect.width)),
        minMarkerHeight:Math.min(...markerRects.map(rect => rect.height)),
        firstTooltipTop:firstRect.top,
        lastTooltipBottom:lastRect.bottom,
        viewportHeight:innerHeight,
      };
    })()`);
    assert.equal(result.veryDense.classApplied, true);
    assert.ok(result.veryDense.trackScrollHeight > result.veryDense.trackClientHeight, JSON.stringify(result.veryDense));
    assert.ok(result.veryDense.minMarkerWidth >= 24 && result.veryDense.minMarkerHeight >= 24, JSON.stringify(result.veryDense));
    assert.ok(result.veryDense.firstTooltipTop >= 0, JSON.stringify(result.veryDense));
    assert.ok(result.veryDense.lastTooltipBottom <= result.veryDense.viewportHeight, JSON.stringify(result.veryDense));

    result.singleQuestion = await client.eval(`window.__hubE2E.cardQuestionNavigator.mountFixture({
      sessionId: 'card-question-nav-single', start: 1, count: 1, clear: true
    })`);
    assert.equal(result.singleQuestion.state.count, 1);
    assert.equal(result.singleQuestion.state.visible, false, 'one question should not create navigation clutter');
    result.screenshot = SCREENSHOT_PATH;
    result.responsiveScreenshot = RESPONSIVE_SCREENSHOT_PATH;
    testBodyPassed = true;
  } catch (error) {
    console.error(error.stack || error.message);
    if (hub) console.error(hub.log().slice(-60).join('\n'));
    process.exitCode = 1;
  } finally {
    try {
      if (client) { try { await client.close(); } catch (error) { console.warn('[question-nav-e2e] CDP close failed:', error.message); } }
      if (hub) result.teardown = await gracefulQuit(hub);
    } finally {
      const resolved = path.resolve(tempRoot);
      if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
          && path.basename(resolved).startsWith('hub-card-question-nav-')) {
        fs.rmSync(resolved, { recursive: true, force: true });
      }
    }
  }
  if (testBodyPassed) {
    result.success = true;
    fs.writeFileSync(RESULT_PATH, JSON.stringify(result, null, 2), 'utf8');
    console.log(JSON.stringify({ ok: true, resultPath: RESULT_PATH, ...result }, null, 2));
  }
})();
