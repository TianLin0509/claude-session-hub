'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../renderer/preview-webview-preload.js'), 'utf8');

function fixture(reply) {
  const listeners = new Map(), calls = [], feedback = [];
  const selection = { rangeCount: 1, toString: () => 'HTML 选区', getRangeAt: () => ({ cloneContents: () => ({}) }) };
  vm.runInNewContext(source, {
    require: name => {
      assert.equal(name, 'electron', 'sandboxed preloads cannot load local modules');
      return { ipcRenderer: { invoke: async (...args) => { calls.push(args); return reply; }, sendToHost: (...args) => feedback.push(args) } };
    },
    window: { addEventListener: (name, fn) => { if (!listeners.has(name)) listeners.set(name, []); listeners.get(name).push(fn); }, getSelection: () => selection },
    document: { createElement: () => ({ appendChild() {}, innerHTML: '<b>HTML 选区</b>' }) },
    innerWidth: 800, innerHeight: 600,
  });
  let prevented = false;
  return { calls, feedback, selection, prevented: () => prevented,
    async fire(type, extra = {}) {
      const event = { isTrusted:true, ctrlKey:true, key:'c', code:'KeyC', target:{closest:()=>null}, preventDefault(){prevented=true;},stopImmediatePropagation(){},...extra };
      for (const fn of listeners.get(type) || []) fn(event);
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

test('sandboxed preview Ctrl+C writes through main and preserves both text formats', async () => {
  const f = fixture({ ok:true, attempts:1 }); await f.fire('keydown');
  assert.equal(f.prevented(),true);
  assert.equal(f.calls[0][0],'clipboard:write-text');
  assert.equal(f.calls[0][1],'HTML 选区');
  assert.equal(f.calls[0][2].html,'<b>HTML 选区</b>');
  assert.equal(f.feedback[0][0],'preview-copy-feedback');
  assert.equal(f.feedback[0][1].ok,true);
});
test('sandboxed native copy reports a failed main acknowledgement as failure', async () => {
  const f=fixture({ok:false,reason:'busy'}); await f.fire('copy');
  assert.equal(f.feedback[0][1].ok,false);
});
test('right click sends the exact selection and coordinates to the host menu', async () => {
  const f=fixture({ok:true}); await f.fire('contextmenu',{clientX:20,clientY:30});
  assert.equal(f.calls.length,0);
  assert.equal(f.feedback[0][0],'preview-selection-menu');
  assert.equal(f.feedback[0][1].text,'HTML 选区');
  assert.equal(f.feedback[0][1].x,20);
});
test('Ctrl+C without selection remains available to the embedded page', async () => {
  const f=fixture({ok:true}); f.selection.toString=()=>''; await f.fire('keydown');
  assert.equal(f.prevented(),false); assert.equal(f.calls.length,0);
});

test('page-created synthetic clipboard events cannot overwrite the system clipboard', async () => {
  const f=fixture({ok:true});
  for (const event of ['keydown','copy','contextmenu']) await f.fire(event,{isTrusted:false});
  assert.equal(f.calls.length,0); assert.equal(f.feedback.length,0);
});
