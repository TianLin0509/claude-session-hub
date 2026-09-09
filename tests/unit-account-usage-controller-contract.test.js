const assert = require('assert');
const path = require('path');

const { createAccountUsageController, pickTightestWindow } = require(path.join(__dirname, '..', 'renderer', 'account-usage-controller.js'));

function testPickTightestWindow() {
  for (const [provider, window] of [['claude', '5h'], ['claude', '7d'], ['codex', '5h'], ['codex', '7d']]) {
    const snapshot = { claude: { usage5h: { pct: 12 }, usage7d: { pct: 24 } }, codex: { usage5h: { pct: 36 }, usage7d: { pct: 48 } } };
    snapshot[provider]['usage' + window].pct = 88;
    const before = JSON.stringify(snapshot);
    assert.deepStrictEqual(pickTightestWindow(snapshot), { provider, window, percent: 88, level: 'danger' });
    assert.strictEqual(JSON.stringify(snapshot), before, 'selection must not mutate its input');
  }
  assert.deepStrictEqual(pickTightestWindow({ deepseek: { balance: { totalBalance: '19.99' } } }),
    { provider: 'deepseek', window: 'balance', percent: 60, level: 'warn' });
  assert.strictEqual(pickTightestWindow({}), null);
  for (const [percent, level] of [[0, 'muted'], [59.9, 'muted'], [60, 'warn'], [85, 'warn'], [85.1, 'danger'], [101, 'danger']]) {
    assert.deepStrictEqual(pickTightestWindow({ codex: { usage7d: { pct: percent } } }), { provider: 'codex', window: '7d', percent, level });
  }
  for (const value of [null, undefined, NaN, Infinity, '', ' ', false]) {
    assert.strictEqual(pickTightestWindow({ claude: { usage5h: { pct: value } }, deepseek: { totalBalance: value } }), null);
  }
  assert.strictEqual(pickTightestWindow({ deepseek: { totalBalance: 20 } }), null);
  assert.deepStrictEqual(pickTightestWindow({ claude: { usage5h: { pct: 60 }, usage7d: { pct: 60 } }, codex: { usage5h: { pct: 60 } }, deepseek: { totalBalance: 0 } }),
    { provider: 'claude', window: '5h', percent: 60, level: 'warn' });
}


class Element {
  constructor(document, tag = 'div') {
    this.document = document; this.tagName = tag; this.children = []; this.listeners = {};
    this.attrs = {}; this.dataset = {}; this.className = ''; this.innerHTML = ''; this.textContent = '';
    this.style = { setProperty: (key, value) => { this.style[key] = value; } };
    this.classList = { toggle: (name, on) => {
      const names = new Set(this.className.split(' ').filter(Boolean));
      if (on) names.add(name); else names.delete(name);
      this.className = [...names].join(' ');
    }};
  }
  appendChild(el) { this.children.push(el); el.parent = this; return el; }
  querySelector(selector) {
    if (!this.children.length && this.innerHTML) {
      for (const match of this.innerHTML.matchAll(/<button\b([^>]*)>([^<]*)<\/button>/g)) {
        const el = this.document.createElement('button');
        el.className = /class="([^"]+)"/.exec(match[1])?.[1] || '';
        el.dataset.action = /data-action="([^"]+)"/.exec(match[1])?.[1];
        el.textContent = match[2];
        this.appendChild(el);
      }
    }
    return this.children.find(el => el.className.split(' ').includes(selector.slice(1))) || null;
  }
  setAttribute(k, v) { this.attrs[k] = v; }
  addEventListener(k, fn) { (this.listeners[k] ||= []).push(fn); }
  contains(el) { return el === this || this.children.some(c => c.contains(el)); }
  matches(selector) { return selector === ':hover' && !!this.hovered; }
  getBoundingClientRect() { return { right: 40, bottom: 800, width: 420, height: this.testHeight || 240 }; }
  focus() { this.document.activeElement = this; }
  click() { this.fire('click'); }
  fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, preventDefault() {}, stopPropagation() {}, ...event }); }
}

function makeDocument() {
  const elements = [];
  const document = {
    activeElement: null, listeners: {},
    createElement(tag) { const el = new Element(document, tag); elements.push(el); return el; },
    getElementById(id) { return elements.find(el => el.id === id) || null; },
    addEventListener: Element.prototype.addEventListener,
    fire: Element.prototype.fire,
    defaultView: { innerWidth: 1280, innerHeight: 900, addEventListener() {} },
  };
  for (const id of ['rail-usage', 'quota-ticker', 'btn-home']) document.createElement('div').id = id;
  document.byClass = name => elements.find(el => el.className.split(' ').includes(name));
  return document;
}

async function main() {
  testPickTightestWindow();
  let now = 1800000000000;
  const document = makeDocument();
  const timers = new Map();
  let timerId = 0, interval;
  const sessions = new Map([['s1', { contextUsed: 2000 }]]);
  const invokeCalls = [];
  let refreshResult = () => Promise.resolve({
    cache: { codex: { usage5h: { pct: 66 }, usage7d: { pct: 32 }, observedAt: now, ts: now, source: 'app-server',
      profileLabel: 'Main', accountEmail: 'current@example.com' } },
    providerResults: { codex: { ok: true } }, refreshedAt: now,
  });
  const controller = createAccountUsageController({
    document, sessions, escapeHtml: s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;'),
    ipcRenderer: { invoke(channel) { invokeCalls.push(channel); return refreshResult(); } },
    setIntervalFn: fn => { interval = fn; return 1; },
    setTimeoutFn: (fn, delay) => { const id = ++timerId; timers.set(id, { fn, delay }); return id; },
    clearTimeoutFn: id => timers.delete(id),
    nowFn: () => now,
  });
  assert.strictEqual(controller.pctClass(12), 'ok');
  assert.strictEqual(controller.pctClass(60), 'ok', 'home thresholds must remain unchanged');
  assert.strictEqual(controller.pctClass(74), 'warn');
  assert.strictEqual(controller.pctClass(85), 'danger', 'home threshold differs deliberately from the new ring');
  controller.applyUsageCache({
    claude: { usage5h: { pct: 101 }, usage7d: { pct: 8 }, ts: now - 300000 },
    codex: { usage5h: { pct: 65 }, usage7d: { pct: 31 }, observedAt: now - 300000, ts: now, profileLabel: 'Main', accountEmail: 'current@example.com' },
    kimi: { usage5h: { pct: 67 }, usage7d: { pct: 13 }, observedAt: now - 60000, source: 'kimi-api' },
    deepseek: { totalBalance: 60.6, currency: 'CNY', available: true, observedAt: now - 60000 },
  });
  const rows = document.byClass('usage-popover-rows');
  const button = document.byClass('rail-usage-button');
  const value = document.byClass('rail-usage-value');
  const popup = document.byClass('usage-popover');
  const refresh = document.byClass('usage-refresh');
  const notice = document.byClass('usage-refresh-notice');
  assert.strictEqual(document.getElementById('quota-ticker').style.display, 'none');
  for (const text of ['Claude', 'Codex·Main', 'DeepSeek', '¥60.60', '101%', 'current@example.com', '数据 5 分钟前']) assert.ok(rows.innerHTML.includes(text), text);
  assert.strictEqual((rows.innerHTML.match(/class="usage-provider-row"/g) || []).length, 3);
  assert.ok(!rows.innerHTML.includes('Kimi'));
  assert.ok(rows.innerHTML.includes('usage-bar-track'));
  assert.ok(!rows.innerHTML.includes('acc-ai-logo'));
  assert.ok(!rows.innerHTML.includes('↻—'));
  assert.strictEqual(document.byClass('btn-memo-toggle').dataset.action, 'open-memo');
  assert.strictEqual(value.textContent, '101%');
  assert.strictEqual(button.dataset.freshness, 'stale');
  assert.strictEqual(document.byClass('rail-usage-ring').style['--usage-percent'], '100%');

  button.fire('pointerenter');
  assert.strictEqual(popup.hidden, false);
  const hoverTop = popup.style.top;
  popup.testHeight = 280; // A new refresh-error line makes the dialog taller.
  controller.render();
  assert.strictEqual(popup.style.top, hoverTop, 'data updates must not move the hovered popover top');
  button.click(); // pin an already-hovered popup
  refresh.focus();
  await controller.refreshUsageNow();
  assert.deepStrictEqual(invokeCalls, ['refresh-usage-now']);
  assert.ok(rows.innerHTML.includes('66%'));
  assert.strictEqual(document.activeElement, refresh);
  assert.strictEqual(popup.hidden, false);
  assert.ok(notice.textContent.includes('刷新请求已完成'));
  assert.ok([...timers.values()].some(t => t.delay >= 60000 && t.delay < 61000));
  now += 61000;
  interval();
  assert.strictEqual(notice.hidden, true);
  assert.ok(rows.innerHTML.includes('66%'));
  document.fire('keydown', { key: 'Escape' });
  assert.strictEqual(popup.hidden, true);
  assert.strictEqual(document.activeElement, button);

  controller.applyUsageCache({
    claude: { usage5h: { pct: 12 }, usage7d: { pct: 20 }, ts: now },
    codex: { usage5h: { pct: 88 }, usage7d: { pct: 32 }, observedAt: now },
    deepseek: { totalBalance: 50, observedAt: now - 660000 },
  });
  assert.strictEqual(button.dataset.provider, 'codex');
  assert.strictEqual(button.dataset.level, 'danger');
  assert.strictEqual(button.dataset.freshness, 'fresh', 'old DeepSeek must not turn fresh Codex gray');
  assert.ok(document.byClass('usage-age').textContent.includes('数据 11 分钟前'));
  now += 120000; controller.render();
  assert.strictEqual(button.dataset.freshness, 'fresh');
  now += 1;
  const expiry = [...timers.values()].find(t => t.delay === 1);
  assert.ok(expiry, 'ring schedules its own staleness boundary');
  expiry.fn();
  assert.strictEqual(button.dataset.freshness, 'stale');
  assert.strictEqual(value.textContent, '88%');

  controller.applyUsageCache({ claude: { usage7d: { pct: 85 }, ts: now }, codex: { usage7d: { pct: 7 }, observedAt: now } });
  assert.strictEqual(button.dataset.provider, 'claude', 'weekly-only Claude cache must render');
  assert.strictEqual(button.dataset.window, '7d');
  assert.strictEqual(button.dataset.level, 'warn');
  assert.ok(rows.innerHTML.includes('<i>5h</i><b>—</b>'), 'weekly-only does not impersonate 5h');
  controller.applyUsageCache({ claude: { usage5h: { pct: 12 }, ts: now }, codex: { usage5h: { pct: 24 }, observedAt: now },
    deepseek: { balance: { totalBalance: 10, currency: 'CNY' }, observedAt: now } });
  assert.strictEqual(button.dataset.provider, 'deepseek');
  assert.strictEqual(value.textContent, '!');
  assert.ok(button.title.includes('¥10.00'));
  assert.ok(!rows.innerHTML.includes('>60%<'));
  controller.applyUsageCache({ deepseek: { totalBalance: null, observedAt: now } });
  assert.strictEqual(button.dataset.provider, 'codex', 'null balance must not become zero');

  let resolveRefresh;
  refreshResult = () => new Promise(resolve => { resolveRefresh = resolve; });
  const first = controller.refreshUsageNow();
  await Promise.resolve();
  const callCount = invokeCalls.length;
  assert.strictEqual(await controller.refreshUsageNow(), null);
  assert.strictEqual(invokeCalls.length, callCount);
  assert.strictEqual(refresh.attrs['aria-disabled'], 'true');
  resolveRefresh({ providerResults: { deepseek: { ok: false, error: '余额接口超时' } }, refreshedAt: now });
  await first;
  assert.ok(notice.textContent.includes('余额接口超时'));
  assert.strictEqual(controller.getSnapshot().codex.usage5h.pct, 24);
  refreshResult = () => { throw new Error('IPC unavailable'); };
  await assert.rejects(controller.refreshUsageNow(), /IPC unavailable/);
  assert.strictEqual(controller.getSnapshot().refresh.inFlight, false);
  assert.ok(notice.textContent.includes('IPC unavailable'));
  assert.strictEqual(refresh.attrs['aria-disabled'], 'false');

  const emptyDoc = makeDocument();
  const empty = createAccountUsageController({ document: emptyDoc, sessions, ipcRenderer: {}, escapeHtml: String,
    setIntervalFn() {}, setTimeoutFn() {}, nowFn: () => now });
  empty.render();
  assert.strictEqual(emptyDoc.byClass('rail-usage-value').textContent, '—');
  assert.strictEqual(emptyDoc.byClass('rail-usage-button').dataset.freshness, 'unknown');
  empty.applyUsageCache({ codex: { usage5h: { pct: 88 } } });
  assert.strictEqual(emptyDoc.byClass('rail-usage-button').dataset.freshness, 'unknown');

  const session = sessions.get('s1');
  session._tokenSamples = [{ t: now - 120000, used: 1000 }, { t: now, used: 7000 }];
  assert.ok(controller.sessionBurnRate(session).tokensPerMin > 0);
  assert.ok(controller.getSnapshot().kimi, 'Kimi remains in the home snapshot');
  console.log('unit-account-usage-controller-contract OK: 6 required selection cases + boundaries, lifecycle, refresh and home contracts');
}
main().catch(err => { console.error(err); process.exit(1); });
