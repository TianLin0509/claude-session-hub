'use strict';
// Renderer state contract using a minimal DOM; real Hub GUI has its own suite.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCodexBackstage}=require('../renderer/codex-backstage');

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.listeners = {};
    this.style = { setProperty() {} }; this.dataset = {}; this.textContent = '';
    this.scrollTop = this.scrollHeight = this.clientHeight = 0;
    this.isConnected = true; this.hidden = false; this.className = '';
    this.classList = { add() {}, remove() {}, toggle() {} };
  }
  append(...items) { this.children.push(...items); }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
  removeEventListener() {}
  replaceChildren(...items) { this.children = items; }
  get childElementCount() { return this.children.length; }
  get firstElementChild() { return this.children[0]; }
  get lastElementChild() { return this.children.at(-1); }
  getBoundingClientRect() { return { top: 0, bottom: 0 }; }
  querySelector(selector) {
    for (const node of this.children) {
      if (selector[0] === '.'
        ? node.className?.split(' ').includes(selector.slice(1))
        : node.tagName === selector) return node;
      const found = node.querySelector?.(selector);
      if (found) return found;
    }
    return null;
  }
  remove() {}
  click() { return this.listeners.click?.({ stopPropagation() {} }); }
}

global.localStorage = { getItem: () => null, setItem() {} };
global.ResizeObserver = class { observe() {} disconnect() {} };
global.requestAnimationFrame = () => 0;
global.cancelAnimationFrame = () => {};
const doc = {
  hidden: false,
  createElement: tag => new Element(tag),
  createTextNode: text => ({ textContent: text }),
  addEventListener() {}, removeEventListener() {},
};

async function until(fn) {
  const deadline = Date.now() + 1500;
  while (!fn()) {
    if (Date.now() > deadline) throw new Error('Compatibility probe timed out');
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

test('broker upgrade clears obsolete notices and restores export without racing an active export',async()=>{
  let calls = 0, exports = 0, releaseExport, upgraded = true;
  const ui = createCodexBackstage({
    document: doc, sessionId: 'review-compatibility',
    getSession: () => ({ nativeRuntime: { state: 'idle', connection: 'connected' } }),
    focusComposer() {},
    ipcRenderer: {
      async invoke(method) {
        if(method==='codex:backstage-export'){exports++;return new Promise(resolve=>{releaseExport=()=>resolve({ok:true});});}
        assert.equal(method, 'codex:backstage-read');
        return (++calls === 1 || !upgraded)
          ? { ok: true, unsupported: true, message: 'old broker' }
          : { ok: true, entries: [], revision: 1, more: false, historyMore: false };
      },
    },
  });
  try {
    ui.mount(new Element('main'));
    ui.setVisible(true);
    await until(() => ui.stats().mode === 'legacy');
    const exportButton = ui.root.querySelector('.cb-export');
    const compatibility = ui.root.querySelector('.cb-compat');

    assert.equal(exportButton.disabled, true);
    ui.root.querySelector('.cb-tabs').children[0].click();
    await until(() => ui.stats().revision === 1);

    assert.equal(exportButton.disabled, false, 'Successful upgraded read must restore export');
    assert.equal(compatibility.hidden, true, 'Successful upgraded read must hide obsolete notice');
    exportButton.click();await until(()=>exports===1);assert.equal(exportButton.disabled,true);
    exportButton.click();assert.equal(exports,1,'an in-flight export cannot start twice');
    upgraded=false;ui.root.querySelector('.cb-tabs').children[0].click();
    await until(()=>ui.stats().mode==='legacy');
    upgraded=true;ui.root.querySelector('.cb-tabs').children[0].click();
    await until(()=>compatibility.hidden);
    assert.equal(exportButton.disabled,true,'a successful upgraded read cannot unlock an in-flight export');
    releaseExport();await until(()=>!exportButton.disabled);
  } finally { ui.dispose(); }
});
