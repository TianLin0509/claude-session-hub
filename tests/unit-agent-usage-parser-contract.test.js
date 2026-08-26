'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractCodexRateLimits,
  mergeCodexRateLimitCandidates,
  parseCodexUsage,
  parseGeminiUsage,
  parseKimiUsage,
  stripAnsi,
} = require('../main/usage/agent-usage-parser.js');

assert.strictEqual(stripAnsi('\x1b[31mhello\x1b[0m'), 'hello',
  'stripAnsi should remove terminal color escapes');

const gemini = parseGeminiUsage('gemini-2.5-pro (95% context left) 17% used');
assert.strictEqual(gemini.contextPct, 5,
  'Gemini context left should be converted to used percentage');
assert.ok(gemini.model && gemini.model.id === 'gemini-2.5-pro',
  'Gemini model id should be detected from footer');

const geminiQuota = parseGeminiUsage('gemini-2.5-flash 17% used');
assert.strictEqual(geminiQuota.quotaPct, 17,
  'Gemini quota footer should be parsed separately from context');

const codex = parseCodexUsage('gpt-5.4 medium Context 88% left\nToken usage: total=12,840 input=10 output=2');
assert.deepStrictEqual(codex.model, { id: 'gpt-5.4', displayName: 'gpt-5.4' },
  'Codex model id should be parsed from status bar');
assert.strictEqual(codex.contextPct, 12,
  'Codex context left should be converted to used percentage');
assert.strictEqual(codex.tokensUsed, 12840,
  'Codex token summary should parse comma-separated totals');

const codexContaminated = parseCodexUsage([
  'Tool output: selected backend gpt-image-gen2 for image generation',
  'The answer also mentions gpt-5.4 as a comparison.',
  'gpt-5.6-sol max fast · Context 87% left · C:\\repo',
].join('\n'));
assert.deepStrictEqual(codexContaminated.model, { id: 'gpt-5.6-sol', displayName: 'gpt-5.6-sol' },
  'tool-only image models in PTY history must not replace the Codex status-footer model');

const codexToolOnly = parseCodexUsage('Tool result: model = gpt-image-gen2');
assert.strictEqual(codexToolOnly.model, undefined,
  'arbitrary gpt-* text without a provider-owned status surface is not session metadata');
assert.strictEqual(parseCodexUsage('Model: gpt-5.4\nassistant-authored comparison').model, undefined,
  'a Model: line outside the real Codex usage surface must not poison session metadata');

const kimi = parseKimiUsage('Kimi K3  context: 6.3% (66.1k/1.0m)  YOLO');
assert.strictEqual(kimi.contextPct, 6.3,
  'Kimi statusline context percentage should be preserved');
assert.strictEqual(kimi.contextUsed, 66100,
  'Kimi statusline used tokens should parse compact units');
assert.strictEqual(kimi.contextMax, 1000000,
  'Kimi statusline context window should parse compact units');
assert.deepStrictEqual(kimi.model, { id: 'kimi-code/k3', displayName: 'Kimi K3' },
  'Kimi K3 statusline should expose the canonical model');

const codexUsageScreen = parseCodexUsage([
  'Visit https://chatgpt.com/codex/settings/usage for up-to-date information on rate limits and credits',
  '',
  'Model:                  gpt-5.5 (reasoning high, summaries auto)',
  '5h limit:               [█████████░] 91% left (resets 20:54)',
  'Weekly limit:           [███░░░░░░░] 30% left (resets 23:12 on 11 Jun)',
  'GPT-5.3-Codex-Spark limit:',
  '5h limit:               [██████████] 100% left (resets 00:52 on 8 Jun)',
  'Weekly limit:           [██████████] 100% left (resets 19:52 on 14 Jun)',
].join('\n'));
assert.strictEqual(codexUsageScreen.usage5h.pct, 9,
  'Codex /usage 5h "left" should be converted to used percentage');
assert.strictEqual(codexUsageScreen.usage7d.pct, 70,
  'Codex /usage weekly "left" should be converted to used percentage');
assert.ok(codexUsageScreen.usage5h.resetsAt,
  'Codex /usage 5h reset time should be parsed when present');
assert.ok(codexUsageScreen.usage7d.resetsAt,
  'Codex /usage weekly reset date should be parsed when present');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-rate-limit-'));
const jsonl = path.join(dir, 'rollout-test.jsonl');
fs.writeFileSync(jsonl, [
  JSON.stringify({ type: 'event_msg', payload: { type: 'other' } }),
  JSON.stringify({
    timestamp: '2026-07-10T17:16:43.051Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 42.4, resets_at: 123 },
        secondary: { used_percent: 11.8, resets_at: 456000 },
      },
    },
  }),
].join('\n'), 'utf8');

assert.deepStrictEqual(extractCodexRateLimits(jsonl), {
  usage5h: { pct: 42, resetsAt: 123000 },
  usage7d: { pct: 12, resetsAt: 456000000 },
  observedAt: Date.parse('2026-07-10T17:16:43.051Z'),
}, 'Codex JSONL rate limits should be extracted from token_count tail events');

const trailingJsonl = path.join(dir, 'rollout-large-trailing-lines.jsonl');
fs.writeFileSync(trailingJsonl, [
  JSON.stringify({
    timestamp: '2026-07-10T17:20:40.489Z',
    type: 'event_msg',
    payload: {
      type: 'token_count',
      rate_limits: {
        primary: { used_percent: 28, resets_at: 1234 },
        secondary: { used_percent: 6, resets_at: 5678 },
      },
    },
  }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'response_item', text: 'x'.repeat(24 * 1024) } }),
  JSON.stringify({ type: 'event_msg', payload: { type: 'agent_message', text: 'done' } }),
].join('\n'), 'utf8');

assert.deepStrictEqual(extractCodexRateLimits(trailingJsonl, { chunkBytes: 1024, maxScanBytes: 64 * 1024 }), {
  usage5h: { pct: 28, resetsAt: 1234000 },
  usage7d: { pct: 6, resetsAt: 5678000 },
  observedAt: Date.parse('2026-07-10T17:20:40.489Z'),
}, 'Codex JSONL scan should find token_count before large trailing response lines');

const now = 1_800_000_000_000;
assert.deepStrictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 0, resetsAt: now + 5 * 3600 * 1000 },
    usage7d: { pct: 0, resetsAt: now + 7 * 86400 * 1000 },
    observedAt: now,
    rolloutPath: 'newer-zero.jsonl',
  },
  {
    usage5h: { pct: 1, resetsAt: now + 4 * 3600 * 1000 },
    usage7d: { pct: 7, resetsAt: now + 6 * 86400 * 1000 },
    observedAt: now - 10_000,
    rolloutPath: 'active.jsonl',
  },
], now), {
  usage5h: { pct: 0, resetsAt: now + 5 * 3600 * 1000 },
  usage7d: { pct: 0, resetsAt: now + 7 * 86400 * 1000 },
  rolloutPath: 'newer-zero.jsonl',
  observedAt: now,
}, 'Codex merge should accept a newer coherent 0% snapshot when reset windows changed');

assert.deepStrictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 94, resetsAt: now + 2 * 3600 * 1000 },
    usage7d: { pct: 95, resetsAt: now + 2 * 86400 * 1000 },
    observedAt: now - 20_000,
    rolloutPath: 'old-account.jsonl',
  },
  {
    usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
    usage7d: { pct: 0, resetsAt: now + 7 * 86400 * 1000 },
    observedAt: now,
    rolloutPath: 'current-account.jsonl',
  },
], now, { minObservedAt: now - 1_000 }), {
  usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
  usage7d: { pct: 0, resetsAt: now + 7 * 86400 * 1000 },
  rolloutPath: 'current-account.jsonl',
  observedAt: now,
}, 'Codex merge should prefer snapshots after the current auth refresh when present');

assert.strictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 94, resetsAt: now + 2 * 3600 * 1000 },
    usage7d: { pct: 95, resetsAt: now + 2 * 86400 * 1000 },
    observedAt: now - 20_000,
    rolloutPath: 'old-account.jsonl',
  },
], now, { minObservedAt: now - 1_000 }), null,
'Codex merge must not relabel an old-account snapshot as the current auth scope');

assert.deepStrictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 26, resetsAt: now - 120_000 },
    usage7d: { pct: 6, resetsAt: now + 6 * 86400 * 1000 },
    observedAt: now - 60_000,
    rolloutPath: 'expired-primary.jsonl',
  },
  {
    usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
    usage7d: { pct: 7, resetsAt: now + 6 * 86400 * 1000 },
    observedAt: now,
    rolloutPath: 'current.jsonl',
  },
], now), {
  usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
  usage7d: { pct: 7, resetsAt: now + 6 * 86400 * 1000 },
  rolloutPath: 'current.jsonl',
  observedAt: now,
}, 'Codex merge should not resurrect expired 5h primary usage');

assert.deepStrictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
    usage7d: { pct: 7, resetsAt: now + 6 * 86400 * 1000 },
    observedAt: now,
    rolloutPath: 'latest-weekly.jsonl',
  },
  {
    usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
    usage7d: { pct: 29, resetsAt: now + 2 * 86400 * 1000 },
    observedAt: now - 24 * 3600 * 1000,
    rolloutPath: 'old-weekly-peak.jsonl',
  },
], now), {
  usage5h: { pct: 1, resetsAt: now + 5 * 3600 * 1000 },
  usage7d: { pct: 7, resetsAt: now + 6 * 86400 * 1000 },
  rolloutPath: 'latest-weekly.jsonl',
  observedAt: now,
}, 'Codex merge should use latest positive 7d rolling snapshot, not old weekly peak');

// 全部 candidate 的 5h primary 都已过期：返回 pct=0、expired=true
// （表示 codex 端窗口已重置，下一个请求会从 0% 起算）。
// 不能返回 null —— null 会让 UI 渲染成 "—"，用户分不清「无数据」与「已重置」。
assert.deepStrictEqual(mergeCodexRateLimitCandidates([
  {
    usage5h: { pct: 59, resetsAt: now - 6 * 3600 * 1000 },
    usage7d: { pct: 69, resetsAt: now + 5 * 86400 * 1000 },
    observedAt: now - 8 * 3600 * 1000,
    rolloutPath: 'stale.jsonl',
  },
], now), {
  usage5h: { pct: 0, resetsAt: null, expired: true },
  usage7d: { pct: 69, resetsAt: now + 5 * 86400 * 1000 },
  rolloutPath: 'stale.jsonl',
  observedAt: now - 8 * 3600 * 1000,
}, 'Expired 5h primary should surface as 0% (window reset), not null');

console.log('Agent usage parser contract: ok');
