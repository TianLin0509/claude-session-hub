'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  extractCodexRateLimits,
  parseCodexUsage,
  parseGeminiUsage,
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

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-codex-rate-limit-'));
const jsonl = path.join(dir, 'rollout-test.jsonl');
fs.writeFileSync(jsonl, [
  JSON.stringify({ type: 'event_msg', payload: { type: 'other' } }),
  JSON.stringify({
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
}, 'Codex JSONL rate limits should be extracted from token_count tail events');

console.log('Agent usage parser contract: ok');
