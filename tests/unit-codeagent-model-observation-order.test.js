'use strict';

// Execute the actual main.js observer; only I/O, metadata storage and renderer are controlled.
// getSession intentionally returns a shallow copy, matching the real SessionManager.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const models = require('../core/codeagent-models');

const main = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
const functionStart = main.indexOf('async function observeCodeAgentModel(');
const declaration = main.indexOf('const codeAgentModelObservations = new WeakMap();');
const end = main.indexOf('// Wire TranscriptTap', functionStart);
assert.ok(functionStart >= 0 && end > functionStart, 'actual main observer boundary must exist');
const source = main.slice(declaration >= 0 && declaration < functionStart ? declaration : functionStart, end);
const GLM = 'GLM-5.2-WX-Auto', MINI = 'MiniMax-M2.7';
const clone = value => JSON.parse(JSON.stringify(value));
const usage = input => ({ input_tokens: input, output_tokens: 20, cache_creation_input_tokens: 30, cache_read_input_tokens: 40 });
const latest = (model, input) => ({ model, usage: usage(input), text: 'controlled native answer', id: `answer-${model}-${input}`, ts: input });
function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

function harness({ model = GLM, transcriptPath = 'isolated-current.jsonl', read = async () => null } = {}) {
  const entries = new Map(), reads = [], updates = [], dirty = [], emitted = [], logs = [], warnings = [], recorded = [];
  let nextPid = 40000;
  function put(id = 'hub-1', fields = {}) {
    const entry = { pty: { pid: ++nextPid }, info: { id, kind: 'codeagent', transcriptPath,
      currentModel: { id: model, displayName: model }, codeagentActualModel: model,
      codeagentConfigDir: 'isolated-config', createdAt: nextPid, ...fields } };
    entries.set(id, entry);
    return entry;
  }
  put();
  const context = vm.createContext({
    require(name) {
      if (name === './core/codeagent-models') return { ...models,
        contextWindowFor: () => ({ window: 200000, source: 'fixture-account' }),
        recordObserved: (_dir, id) => { recorded.push(id); return false; },
        appendModelLog: (_dir, fields) => logs.push(clone(fields)) };
      if (name === './core/read-last-assistant') return { readLastAssistantMessage: file => { reads.push(file); return read(file, reads.length); } };
      if (name === './core/codeagent-config') return { resolveCodeAgentConfig: () => ({ configDir: 'isolated-config' }), localModelOptions: () => [] };
      throw new Error('unexpected observer dependency: ' + name);
    },
    sessionManager: {
      sessions: entries,
      getSession: id => entries.has(id) ? { ...entries.get(id).info } : undefined,
      updateSessionMeta(id, fields) {
        const entry = entries.get(id);
        if (!entry) return undefined;
        updates.push({ id, fields: clone(fields), pid: entry.pty.pid });
        Object.assign(entry.info, fields);
        return { ...entry.info };
      },
    },
    sessionStore: { markDirty: (id, fields) => dirty.push({ id, fields: clone(fields) }) },
    sendToRenderer: (channel, value) => emitted.push({ channel, value: clone(value) }),
    getHubDataDir: () => 'isolated-data',
    process: { env: {} },
    console: { warn: (...args) => warnings.push(args.map(String).join(' ')) },
  });
  vm.runInContext(source, context, { filename: 'main.js#observeCodeAgentModel' });
  return { entries, reads, updates, dirty, emitted, logs, warnings, recorded, put,
    state: (id = 'hub-1') => entries.get(id)?.info,
    observe: (event = {}, file = transcriptPath, via = 'turn-complete', id = 'hub-1') => context.observeCodeAgentModel(id, event, file, via),
    healthy: () => assert.deepEqual(warnings, [], 'observer must not silently catch an unexpected harness/product error'),
    effects: () => ({ updates: clone(updates), dirty: clone(dirty), emitted: clone(emitted), logs: clone(logs), recorded: clone(recorded) }),
  };
}

test('late complete with stale model and usage uses the latest native answer for both', async () => {
  const h = harness({ model: MINI, read: async () => latest(MINI, 3200) });
  await h.observe({ modelId: GLM, usage: usage(100), transcriptPath: 'isolated-current.jsonl' });
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().codeagentActualModel, MINI);
  assert.equal(h.state().contextUsed, 3290, 'context must use the same latest answer, not stale event usage');
  assert.equal(h.reads.length, 1, 'an event having both model and usage still requires native reconciliation');
  assert.equal(h.emitted.filter(e => e.channel === 'session-notice').length, 0);
});

test('stale event model cannot be mixed with the latest disk usage', async () => {
  const h = harness({ model: MINI, read: async () => latest(MINI, 4200) });
  await h.observe({ modelId: GLM });
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().codeagentActualModel, MINI);
  assert.equal(h.state().contextUsed, 4290);
});

test('latest disk answer without usage does not borrow a different old event usage', async () => {
  const h = harness({ model: MINI, read: async () => ({ model: MINI, id: 'latest-no-usage' }) });
  h.state().contextUsed = 777;
  await h.observe({ modelId: GLM, usage: usage(100) });
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().contextUsed, 777, 'absence of current usage is not evidence for the prior event usage');
  assert.equal(h.emitted.filter(e => e.channel === 'status-event').length, 0);
});

test('current writer transcript path wins over a late event and caller path', async () => {
  const h = harness({ model: MINI, read: async file => file === 'isolated-current.jsonl' ? latest(MINI, 1000) : latest(GLM, 100) });
  await h.observe({ transcriptPath: 'isolated-stale-event.jsonl' }, 'isolated-stale-caller.jsonl');
  h.healthy();
  assert.deepEqual(h.reads, ['isolated-current.jsonl']);
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().contextUsed, 1090);
});

test('older asynchronous observation cannot overwrite a newer result completed first', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ read: (_file, index) => index === 1 ? first.promise : second.promise });
  const oldWork = h.observe({}, undefined, 'stop-hook');
  const newWork = h.observe({}, undefined, 'turn-complete');
  assert.equal(h.reads.length, 2);
  second.resolve(latest(MINI, 9000)); await newWork;
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  const accepted = h.effects();
  first.resolve(latest(GLM, 100)); await oldWork;
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().contextUsed, 9090);
  assert.deepEqual(h.effects(), accepted, 'stale work must not emit notices, persist metadata, or record an old model');
});

test('session closed while a read waits receives no metadata or UI updates', async () => {
  const pending = deferred(), h = harness({ read: () => pending.promise });
  const work = h.observe(); h.entries.delete('hub-1');
  pending.resolve(latest(MINI, 1000)); await work;
  h.healthy();
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.dirty, []);
  assert.deepEqual(h.emitted, []);
  assert.deepEqual(h.recorded, []);
});

test('new writer with the same Hub id cannot consume the old writer pending result', async () => {
  const pending = deferred(), h = harness({ read: () => pending.promise });
  const oldEntry = h.entries.get('hub-1'), work = h.observe();
  const replacement = h.put('hub-1', { transcriptPath: 'isolated-new-writer.jsonl', contextUsed: 501 });
  assert.notEqual(replacement, oldEntry);
  pending.resolve(latest(MINI, 9000)); await work;
  h.healthy();
  assert.equal(h.state().currentModel.id, GLM);
  assert.equal(h.state().contextUsed, 501);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.emitted, []);
});

test('explicit model choice during a read is not rolled back by that older observation', async () => {
  const pending = deferred(), h = harness({ read: () => pending.promise });
  const work = h.observe();
  Object.assign(h.state(), { currentModel: { id: MINI, displayName: 'MiniMax M2.7' }, codeagentModelPick: true, contextUsed: 501 });
  pending.resolve(latest(GLM, 9000)); await work;
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().contextUsed, 501);
  assert.deepEqual(h.updates, []);
  assert.deepEqual(h.emitted, []);
});

test('observations for independent writers do not cancel each other', async () => {
  const first = deferred(), second = deferred();
  const h = harness({ read: (_file, index) => index === 1 ? first.promise : second.promise });
  h.put('hub-2', { transcriptPath: 'isolated-second.jsonl' });
  const one = h.observe(), two = h.observe({}, undefined, 'stop-hook', 'hub-2');
  second.resolve(latest(MINI, 2200)); await two;
  first.resolve(latest('deepseek-v4-pro', 1100)); await one;
  h.healthy();
  assert.equal(h.state('hub-1').currentModel.id, 'deepseek-v4-pro');
  assert.equal(h.state('hub-2').currentModel.id, MINI);
  assert.equal(h.state('hub-1').contextUsed, 1190);
  assert.equal(h.state('hub-2').contextUsed, 2290);
});

test('missing native record retains real event fallback and reports a real model mismatch', async () => {
  const h = harness({ read: async () => null });
  await h.observe({ modelId: MINI, usage: usage(800) });
  h.healthy();
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().codeagentActualModel, MINI);
  assert.equal(h.state().codeagentRequestedModel, GLM);
  assert.equal(h.state().contextUsed, 890);
  const notices = h.emitted.filter(e => e.channel === 'session-notice');
  assert.equal(notices.length, 1);
  assert.match(notices[0].value.message, /GLM.*MiniMax.*权限/);
});

test('no transcript path still accepts the actual event model without disk access', async () => {
  const h = harness({ transcriptPath: null, read: () => { throw Error('must not read without path'); } });
  await h.observe({ modelId: MINI, usage: usage(1200) }, null);
  h.healthy();
  assert.deepEqual(h.reads, []);
  assert.equal(h.state().currentModel.id, MINI);
  assert.equal(h.state().contextUsed, 1290);
});

test('Auto family policy preserves the selected family model while recording actual model', async () => {
  const h = harness({ read: async () => latest('GLM-5.2-WX', 1800) });
  await h.observe();
  h.healthy();
  assert.equal(h.state().currentModel.id, GLM);
  assert.equal(h.state().codeagentActualModel, 'GLM-5.2-WX');
  assert.equal(h.state().contextUsed, 1890);
  assert.equal(h.state().codeagentRequestedModel, undefined);
  assert.equal(h.emitted.filter(e => e.channel === 'session-notice').length, 0);
});
