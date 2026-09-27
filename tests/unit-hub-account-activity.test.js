'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { recordActivity, readActivity, recordWebJob, combine } = require('../core/hub-account-activity');
const { usage, servicesHtml, aiHtml } = require('../renderer/account-workspace-view');
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'account-activity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, env: { CLAUDE_HUB_DATA_DIR: root } };
}
function write(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); }
test('opening is only opening; successful use survives a later login failure, without prompt leakage', t => {
  const { root, env } = fixture(t);
  recordActivity(root, { site: 'chatgpt', outcome: 'opened', at: 1000 });
  let value = readActivity(root, env).entries['main:chatgpt'];
  assert.equal(value.lastSuccessAt, 0); assert.match(usage(value).text, /打开过网页/); assert.equal(usage(value).login, false);
  recordActivity(root, { site: 'chatgpt', source: 'roundtable', outcome: 'success', at: 2000 });
  recordActivity(root, { site: 'chatgpt', source: 'roundtable', outcome: 'login_required', at: 3000 });
  recordActivity(root, { site: 'chatgpt', source: 'roundtable', outcome: 'success', at: 1500 });
  value = readActivity(root, env).entries['main:chatgpt'];
  assert.equal(value.at, 3000); assert.equal(value.lastSuccessAt, 2000); assert.equal(usage(value).login, true);
  assert.equal(combine([{ ...value, prompt: 'SECRET' }])['main:chatgpt'].prompt, undefined);
  assert.deepEqual(combine([null, {}]), {});
  assert.throws(() => recordActivity(root, { site: '../../escape', outcome: 'opened' }));
  fs.writeFileSync(path.join(root, 'account-activity/main-chatgpt-website.json'), '{');
  assert.equal(readActivity(root, env).warnings.length, 1);
  assert.throws(() => recordActivity(root, { site: 'chatgpt', outcome: 'opened' }), /无法读取/);
});
test('image records are read-only and follow verified bindings for each identity', t => {
  const { root, env } = fixture(t), pool = path.join(root, 'tool-fixtures/ChatGPTWebImagesPool');
  fs.mkdirSync(pool, { recursive: true });
  const { DatabaseSync } = require('node:sqlite'), db = new DatabaseSync(path.join(pool, 'queue.sqlite3'));
  try {
  db.exec('CREATE TABLE accounts (id TEXT,config_dir TEXT); CREATE TABLE jobs(account_id TEXT,status TEXT,updated REAL,error TEXT,result TEXT)');
  const bindings = ['main', 'alt'].map((identity, i) => {
    const configDir = path.join(pool, 'accounts', String(i));
    const config = path.join(configDir, 'settings.json'), entry = 'bound-' + identity;
    write(config, { cli_entry: entry, secret: 'SECRET' });
    db.prepare('INSERT INTO accounts VALUES (?,?)').run(identity, configDir);
    return { tool: 'images', identity, config, entry };
  });
  write(path.join(root, 'tool-bindings.json'), { tools: bindings });
  const add = (identity, status, updated, error, files = []) => db.prepare('INSERT INTO jobs VALUES (?,?,?,?,?)').run(identity, status, updated, JSON.stringify(error), JSON.stringify({ files, prompt: 'SECRET' }));
  add('main', 'complete', 1, null, [{ path: 'SECRET.png' }]);
  add('main', 'parked', 2, { code: 'rate_limited', message: 'SECRET' });
  add('alt', 'needs_attention', 3, { code: 'login_required' });
  let result = readActivity(root, env);
  assert.equal(result.entries['main:chatgpt'].outcome, 'rate_limited');
  assert.equal(result.entries['main:chatgpt'].lastSuccessAt, 1000);
  assert.equal(result.entries['alt:chatgpt'].outcome, 'login_required');
  assert.equal(JSON.stringify(result).includes('SECRET'), false);
  write(bindings[1].config, { cli_entry: 'changed' });
  assert.equal(readActivity(root, env).entries['alt:chatgpt'], undefined);
  add('main', 'complete', 4, null);
  assert.equal(readActivity(root, env).entries['main:chatgpt'].outcome, 'failed');
  assert.equal(db.prepare('SELECT count(*) AS n FROM jobs').get().n, 4);
  } finally { db.close(); }
});
test('roundtable events use the actual shared Chrome root, not the job storage root', t => {
  const { root, env } = fixture(t);
  const job = { kind: 'web', input: { provider: 'gemini', prompt: 'SECRET' }, state: 'succeeded', updatedAt: '2026-09-27T00:00:00Z' };
  recordWebJob(job, { ...env, AI_HUB_WEB_DATA_DIR: path.join(root, 'different-job-store') });
  assert.equal(readActivity(path.join(root, 'hub-chrome'), env).entries['main:google'].outcome, 'success');
  recordWebJob({ ...job, state: 'needs_attention', recovery: { reason: 'human_verification' }, updatedAt: '2026-09-27T00:01:00Z' }, env);
  assert.equal(readActivity(path.join(root, 'hub-chrome'), env).entries['main:google'].outcome, 'verification_required');
  assert.equal(fs.existsSync(path.join(root, 'different-job-store')), false);
});
test('categories stay separate and all account metadata is escaped', () => {
  const services = [{ id: 'github', name: 'GitHub', website: true, consumers: [], help: 'work' }, { id: 'social', name: 'Social', consumers: [], help: 'content' }, { id: 'bailian', name: '<unsafe>', consumers: [], help: 'api' }];
  const work = servicesHtml({ services }, 'work', '', {}, esc);
  assert.match(work, /GitHub/); assert.doesNotMatch(work, /Social|unsafe|data-operation="check"/);
  assert.match(servicesHtml({ services }, 'api', '', {}, esc), /&lt;unsafe>/);
  assert.doesNotMatch(aiHtml({ identities: [], clis: [] }, '', esc), /data-ac="check"|已登录/);
});
