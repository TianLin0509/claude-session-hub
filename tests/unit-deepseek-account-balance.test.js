'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseDeepSeekBalancePayload,
  readDeepSeekAccountBalance,
} = require('../main/usage/deepseek-account-balance.js');

test('parses the documented DeepSeek balance response and prefers CNY', () => {
  const parsed = parseDeepSeekBalancePayload({
    is_available: true,
    balance_infos: [
      { currency: 'USD', total_balance: '5.00', granted_balance: '1.00', topped_up_balance: '4.00' },
      { currency: 'CNY', total_balance: '39.47', granted_balance: '0.00', topped_up_balance: '39.47' },
    ],
  }, 1234);
  assert.deepStrictEqual({
    available: parsed.available,
    currency: parsed.currency,
    totalBalance: parsed.totalBalance,
    grantedBalance: parsed.grantedBalance,
    toppedUpBalance: parsed.toppedUpBalance,
    observedAt: parsed.observedAt,
    source: parsed.source,
  }, {
    available: true,
    currency: 'CNY',
    totalBalance: 39.47,
    grantedBalance: 0,
    toppedUpBalance: 39.47,
    observedAt: 1234,
    source: 'deepseek-balance-api',
  });
});

test('requests the official balance endpoint without exposing the key in output data', async () => {
  let request = null;
  const result = await readDeepSeekAccountBalance({
    apiKey: 'sk-test-secret',
    baseUrl: 'https://api.deepseek.example/',
    now: () => 5678,
    fetchImpl: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            is_available: true,
            balance_infos: [{
              currency: 'CNY', total_balance: '39.47', granted_balance: '0.00', topped_up_balance: '39.47',
            }],
          };
        },
      };
    },
  });
  assert.equal(request.url, 'https://api.deepseek.example/user/balance');
  assert.equal(request.options.headers.Authorization, 'Bearer sk-test-secret');
  assert.equal(result.totalBalance, 39.47);
  assert.equal(JSON.stringify(result).includes('sk-test-secret'), false);
});

test('rejects missing keys and invalid payloads clearly', async () => {
  await assert.rejects(() => readDeepSeekAccountBalance({ apiKey: '' }), /尚未配置/);
  assert.throws(() => parseDeepSeekBalancePayload({ balance_infos: [] }), /明细为空/);
});
