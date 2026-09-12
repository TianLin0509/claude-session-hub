'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSidebarProjectFilter } = require('../renderer/sidebar-project-filter');

function setup(saved = 'all') {
  const events = {}, attrs = new Map(), options = [];
  const control = { value: '', addEventListener: (name, fn) => { events[name] = fn; },
    setAttribute: (k, v) => attrs.set(k, v), removeAttribute: k => attrs.delete(k),
    replaceChildren: () => { options.length = 0; }, appendChild: o => options.push(o) };
  const note = { hidden: true }, prefs = new Map([['hubSidebarProjectFilter', saved]]);
  let respond = async () => ({ items: [] }), changes = 0;
  const filter = createSidebarProjectFilter({
    document: { getElementById: id => id.endsWith('-note') ? note : control, createElement: () => ({}) },
    storage: { getItem: key => prefs.get(key), setItem: (key, value) => prefs.set(key, value) },
    ipcRenderer: { invoke: (...args) => respond(...args) }, onChange: () => { changes++; },
  });
  return { filter, note, options, prefs, attrs, events, control, get changes() { return changes; },
    response(fn) { respond = fn; }, select(value) { control.value = value; events.change(); } };
}

const projects = [
  { name: '同名', path: 'C:/Repo/App', searchRoots: ['C:/Tasks/App'] },
  { name: '子项目', path: 'C:/Repo/App/Nested' },
  { name: '同名', path: 'D:/Repo/App' },
];

test('project ownership uses directory boundaries and longest root, including meetings and worktrees', async () => {
  const h = setup(); h.response(async () => ({ items: projects })); await h.filter.refresh();
  assert.deepEqual(h.options.slice(0, 2).map(o => o.value), ['random', 'all']);
  assert.match(h.options[2].textContent, /C:\/Repo\/App/);
  h.select('c:/repo/app');
  for (const item of [{ cwd: 'c:\\REPO\\app\\src' }, { cwd: 'C:/Tasks/App/src' },
    { _isMeeting: true, _meeting: { workspace: 'C:/Repo/App' } }]) assert(h.filter.matches(item));
  for (const cwd of ['C:/Repo/App2', 'C:/Repo/App/Nested/src', 'D:/Repo/App', '']) assert(!h.filter.matches({ cwd }));
  h.select('random');
  assert(h.filter.matches({ cwd: 'C:/Repo/App2' }));
  assert(!h.filter.matches({ cwd: 'C:/Repo/App/Nested/src' }));
  assert(!h.filter.matches({ _isMeeting: true, _meeting: { workspace: 'C:/Repo/App' } }));
});

test('failed first load never classifies all paths as random, retry recovers with a visible error', async () => {
  const h = setup('random'); h.response(async () => { throw new Error('offline'); });
  await h.filter.refresh();
  assert.equal(h.note.hidden, false); assert.match(h.note.textContent, /无法判断/);
  assert(!h.filter.matches({ cwd: 'C:/Repo/App' }));
  assert.equal(h.attrs.has('aria-busy'), false);
  h.response(async () => ({ items: projects })); await h.filter.refresh();
  assert.equal(h.note.hidden, true); assert(h.filter.matches({ cwd: 'C:/Else' }));
  h.response(async () => { throw new Error('offline again'); }); await h.filter.refresh();
  assert.match(h.note.textContent, /无法判断项目归属/); assert(!h.filter.matches({ cwd: 'C:/Repo/App' }));
});

test('missing saved projects do not broaden results; explicit search reveal clears the filter', async () => {
  const h = setup('c:/deleted'); h.response(async () => ({ items: projects })); await h.filter.refresh();
  assert.equal(h.control.value, 'c:/deleted'); assert(!h.filter.matches({ cwd: 'C:/Else' }));
  assert(h.options.some(o => o.textContent === '项目暂不可用'));
  h.filter.reveal({ cwd: 'C:/Else' }); assert.equal(h.control.value, 'all');
  assert.equal(h.prefs.get('hubSidebarProjectFilter'), 'all'); assert(h.filter.matches({ cwd: 'C:/Else' }));
});

test('concurrent focus refreshes share one pending library request', async () => {
  const h = setup(); let finish, calls = 0;
  h.response(() => { calls++; return new Promise(resolve => { finish = resolve; }); });
  const first = h.filter.refresh(), second = h.filter.refresh();
  assert.equal(first, second); assert.equal(calls, 1);
  finish({ items: projects }); await first;
  assert.equal(h.changes, 1); assert.equal(h.control.value, 'all');
});
