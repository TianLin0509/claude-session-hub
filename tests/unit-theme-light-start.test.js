'use strict';
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const config = require('../core/theme-config');
const { THEME_STORAGE_KEY:key, THEME_PREFERENCE_KEY:marker, readInitialTheme } = config;
const store = initial => { const values = new Map(Object.entries(initial)); return { getItem:k=>values.get(k), setItem:(k,v)=>values.set(k,v) }; };
for (const saved of ['dark','frost','codex','banana',undefined]) {
  const storage = store({ [key]:saved });
  assert.equal(readInitialTheme(storage), 'codex');
  assert.equal(storage.getItem(marker), '1');
  storage.setItem(key, 'dark');
  assert.equal(readInitialTheme(storage), 'dark', 'subsequent explicit dark survives startup');
}
assert.equal(readInitialTheme(null), 'codex');
assert.equal(readInitialTheme({ getItem(){ throw Error('denied'); } }), 'codex');
assert.equal(readInitialTheme({ getItem(){ return null; }, setItem(){ throw Error('quota'); } }), 'codex');
const source = fs.readFileSync(require.resolve('../renderer/theme-bootstrap'), 'utf8');
for (const saved of ['dark','codex']) {
  const storage = store({ [key]:saved }); let actual;
  vm.runInNewContext(source, { require:()=>config, window:{localStorage:storage}, document:{documentElement:{setAttribute:(k,v)=>{actual=v;}}} });
  assert.equal(actual, 'codex', 'first-paint bootstrap migrates old preference');
  storage.setItem(key, 'dark');
  vm.runInNewContext(source, { require:()=>config, window:{localStorage:storage}, document:{documentElement:{setAttribute:(k,v)=>{actual=v;}}} });
  assert.equal(actual, 'dark');
}
console.log('PASS light startup migration, saved choices and unavailable storage');
