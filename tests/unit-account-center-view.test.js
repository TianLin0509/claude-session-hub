'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const { siteChip, cliChip, identityCards, unplacedClis, attentionCount } = require('../renderer/account-center-view');
const NOW = Date.UTC(2026, 8, 25, 8), DAY = 86400000;

test('a site chip says what the user can do about it, and only then offers the login', () => {
  assert.deepEqual(siteChip({ name: 'ChatGPT', state: 'signed_in', expiresAt: NOW + 90 * DAY }, NOW), { tone: 'ok', text: 'ChatGPT · 至 12/24', action: '' });
  assert.deepEqual(siteChip({ name: '千问', state: 'signed_out' }, NOW), { tone: 'warn', text: '千问 · 需登录', action: 'login' });
  assert.equal(siteChip({ name: 'DeepSeek', state: 'needs_browser' }, NOW).tone, 'idle', 'unknown is not the same as signed out');
  assert.equal(siteChip({ name: 'DeepSeek', state: 'needs_browser' }, NOW, true).text, 'DeepSeek · 点「检查登录」确认', 'with the browser up, say how to find out');
  assert.equal(siteChip({ name: 'X', state: 'needs_attention' }, NOW).text, 'X · 需人机验证');
  // A login about to lapse is worth renewing before a tool fails on it.
  assert.deepEqual(siteChip({ name: '豆包', state: 'signed_in', expiresAt: NOW + 3 * DAY }, NOW), { tone: 'warn', text: '豆包 · 至 9/28', action: 'login' });
  assert.equal(siteChip({ name: 'Claude', state: 'signed_in', expiresAt: 0 }, NOW).text, 'Claude', 'a session cookie has no date to show');
});
test('a CLI chip names the Codex profile, and never shows a token', () => {
  assert.deepEqual(cliChip({ kind: 'codex', name: 'Codex CLI', label: '主账号', state: 'authorized', account: 'a@b.c' }), { tone: 'ok', text: 'Codex CLI（主账号）', title: 'a@b.c' });
  assert.equal(cliChip({ kind: 'claude', name: 'Claude Code', state: 'expired' }).text, 'Claude Code · 需重新授权');
  assert.equal(cliChip({ kind: 'kimi', name: 'Kimi Code', state: 'missing' }).tone, 'warn');
});
const state = {
  identities: [
    { id: 'main', label: '主', account: 'lintian0509@gmail.com', sites: [
      { key: 'chatgpt', name: 'ChatGPT', state: 'signed_in', expiresAt: NOW + 90 * DAY },
      { key: 'qwen', name: '千问', state: 'signed_out' } ] },
    { id: 'alt', label: '副', account: '', sites: [{ key: 'chatgpt', name: 'ChatGPT', state: 'signed_in' }] },
  ],
  clis: [
    { id: 'codex:second', kind: 'codex', name: 'Codex CLI', label: '主账号', state: 'authorized', identity: 'main' },
    { id: 'codex:default', kind: 'codex', name: 'Codex CLI', label: '副账号', state: 'authorized', identity: '' },
    { id: 'claude', kind: 'claude', name: 'Claude Code', state: 'missing', identity: 'main' },
  ],
};
test('each identity card carries its own sites, its CLIs and how many things need the user', () => {
  const [main, alt] = identityCards(state, NOW);
  assert.deepEqual(main.sites.map(s => s.key), ['chatgpt', 'qwen']);
  assert.deepEqual(main.clis.map(c => c.id), ['codex:second', 'claude']);
  assert.equal(main.attention, 2, 'qwen needs a login and Claude Code is not authorised');
  assert.equal(alt.attention, 0);
  assert.equal(alt.account, '');
});
test('a CLI whose login could not be placed is listed on its own, never attached to a guess', () => {
  assert.deepEqual(unplacedClis(state).map(c => c.id), ['codex:default']);
  assert.equal(attentionCount(state, NOW), 2);
});
