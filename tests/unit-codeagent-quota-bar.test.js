'use strict';
// CodeAgent 额度条（2026-10-16）：读屏幕 Stats 面板的 Credit，认出是「今日忙时」还是「月度」，每个账号一行。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCodeAgentCredit } = require('../core/codeagent-screen-stats');
const { createCodeAgentQuotaBar } = require('../renderer/codeagent-quota-bar');

test('额度解析：公司真机读数（白天每日忙时 2500、晚上月度 20000），面板与正文同一行也认得', () => {
  // Q-1016-09 第 9 轮 / Q-1016-19 回执里的原样画面行
  assert.deepEqual(parseCodeAgentCredit(['                                                                                                              Credit       2,477.1 (99.1%)']),
    { remaining: 2477.1, pct: 99.1, total: 2500, bucket: '今日忙时' });
  assert.deepEqual(parseCodeAgentCredit(['  Credit      19,111.8 (95.6%)']), { remaining: 19111.8, pct: 95.6, total: 20000, bucket: '月度' });
  assert.equal(parseCodeAgentCredit(['┃  只回复两个字：好的                                  Credit       2,188.1 (87.5%)']).bucket, '今日忙时');
  assert.equal(parseCodeAgentCredit(['Credit 0 (0%)']).bucket, '当前额度');
  assert.equal(parseCodeAgentCredit(['没有额度行']), null);
  assert.equal(parseCodeAgentCredit(['Credit 12 (130%)']), null);
});

function fakeDoc() {
  const host = { hidden: true, innerHTML: '' };
  const events = [];
  return { host, events, doc: { getElementById: id => (id === 'rail-codeagent-quota' ? host : null), dispatchEvent: e => events.push(e), defaultView: { CustomEvent: class { constructor(t, o) { this.type = t; this.detail = o.detail; } } } } };
}

test('额度条：有读数才显示；每个账号一行；低于 20% 标 warn、低于 10% 标 danger；读数过旧标出时间；通知订阅方', () => {
  let t = 1_800_000_000_000;
  const store = new Map();
  const storage = { getItem: k => store.get(k) || null, setItem: (k, v) => store.set(k, v) };
  const { host, events, doc } = fakeDoc();
  const bar = createCodeAgentQuotaBar({ document: doc, storage, now: () => t });
  bar.render();
  assert.equal(host.hidden, true);
  bar.update({ remaining: 2477.1, pct: 99.1, total: 2500, bucket: '今日忙时' });
  assert.equal(host.hidden, false);
  assert.match(host.innerHTML, /CodeAgent<\/span>/);
  assert.match(host.innerHTML, /今日忙时/);
  // 读数格只放百分比（底栏摘要按 parseFloat 挑最紧张的一家），剩余点数在悬停说明里
  assert.match(host.innerHTML, /<b class="sidebar-quota-value">99\.1%<\/b>/);
  assert.match(host.innerHTML, /title="CodeAgent 个人账号 今日忙时剩余 99\.1%（2,477\.1 \/ 2,500）/);
  assert.match(host.innerHTML, /logo-codeagent/);
  assert.equal(events.length, 1); assert.equal(events[0].type, 'codeagent-quota');
  bar.update({ remaining: 300, pct: 12, total: 2500, bucket: '今日忙时' }, { account: '号池 · 号 B' });
  assert.match(host.innerHTML, /号池 · 号 B/);
  assert.match(host.innerHTML, /data-level="warn"/);
  t += 4 * 3600 * 1000;
  bar.render();
  assert.match(host.innerHTML, /data-freshness="stale"/);
  assert.match(host.innerHTML, /4 小时前/);
  // 重启后从本机存储恢复
  const again = fakeDoc();
  createCodeAgentQuotaBar({ document: again.doc, storage, now: () => t }).render();
  assert.equal(again.host.hidden, false);
});

test('接线：每轮回答结束读屏幕时一并更新额度条，按会话的账号记', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'renderer.js'), 'utf8');
  assert.match(src, /stats\.parseCodeAgentCredit\(lines\)/);
  assert.match(src, /codeagentQuotaBar\.update\(credit, \{ account: session\.codeagentPoolLabel \|\| '个人账号' \}\)/);
  const html = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'index.html'), 'utf8');
  assert.match(html, /id="rail-codeagent-quota"/);
  // 冷白外壳把「余量」挪进窗口底栏、侧栏那块隐藏；额度条要跟着进底栏，否则有读数也看不见
  const shell = fs.readFileSync(path.join(__dirname, '..', 'renderer', 'coldwhite-shell.js'), 'utf8');
  assert.match(shell, /getElementById\('rail-codeagent-quota'\);\s*if \(codeagentQuota\) footer\.append\(codeagentQuota\)/);
});
