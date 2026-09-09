'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const {
  appendHighlightedText,
  formatSearchTime,
  indexProgressModel,
  normalizeTerms,
} = require('../renderer/global-session-search.js');

const ROOT = path.resolve(__dirname, '..');
const SEARCH_SOURCE = fs.readFileSync(path.join(ROOT, 'renderer', 'global-session-search.js'), 'utf8');

test('project library loads preserve the current selection and reject stale responses',async()=>{
  const vm=require('node:vm');
  const {projectPathKey}=require('../core/session-search-projects');
  function fixture() {
    const pending=[],events=[];
    const select={value:'C:/A',replaceChildren(...items){this.options=items;},setAttribute(){},removeAttribute(){}};
    const context=vm.createContext({projectSelect:select,projectRail:null,projectLibrary:[{name:'A',path:'C:/A'},{name:'B',path:'C:/B'}],
      projectLoadSequence:0,projectLoadError:'',projectPathKey,projectNote:{textContent:'',hidden:true},document:{createElement:()=>({})},
      ipcRenderer:{invoke:()=>new Promise((resolve,reject)=>pending.push({resolve,reject}))},isOpen:()=>true,
      scheduleSearch:()=>events.push('search'),announce:()=>{}});
    const start=SEARCH_SOURCE.indexOf('  function renderProjectLibrary()'),end=SEARCH_SOURCE.indexOf('  function resultScopeLabel(',start);
    vm.runInContext(SEARCH_SOURCE.slice(start,end),context);
    return {context,pending,events,select};
  }
  const changed=fixture(),changing=changed.context.loadProjectLibrary();
  changed.select.value='C:/B';changed.pending[0].resolve({items:[{name:'B',path:'C:/B'}]});await changing;
  assert.equal(changed.select.value,'C:/B');assert.equal(changed.context.projectNote.hidden,true);

  const stale=fixture(),loading=stale.context.loadProjectLibrary();
  stale.pending[0].resolve({items:[{name:'B',path:'C:/B'}]});await loading;
  assert.equal(stale.select.value,'C:/A','removed selection must not silently become all');
  assert.match(stale.context.projectNote.textContent,/移出/);
  stale.select.value='C:/B';stale.context.renderProjectLibrary();assert.equal(stale.context.projectNote.hidden,true);

  const racing=fixture(),first=racing.context.loadProjectLibrary(),second=racing.context.loadProjectLibrary();
  racing.pending[1].resolve({items:[{name:'new',path:'C:/A'}]});await second;
  racing.pending[0].resolve({items:[{name:'old',path:'C:/A'}]});await first;
  assert.equal(racing.context.projectLibrary[0].name,'new');assert.equal(racing.events.length,1);

  const failed=fixture(),failure=failed.context.loadProjectLibrary();
  failed.pending[0].reject(new Error('offline'));await failure;
  assert.equal(failed.select.value,'C:/A');assert.equal(failed.context.projectLibrary.length,2);
  assert.match(failed.context.projectNote.textContent,/读取失败/);

  const closed=fixture(),late=closed.context.loadProjectLibrary();closed.context.projectLoadSequence++;
  closed.pending[0].resolve({items:[]});await late;
  assert.equal(closed.context.projectLibrary.length,2);assert.equal(closed.events.length,0);
});

test('an indexed result upgrades a selected provisional title preview',()=>{
  const vm=require('node:vm');let loads=0;
  const old={sessionKey:'s',titleOnly:true,bestMatch:{eventId:null}},updated={...old,indexed:true,bestMatch:{eventId:'answer'}};
  const noop=()=>{};
  const context=vm.createContext({results:[old],activeIndex:0,activePreview:{context:[]},lastResponse:null,
    updateFacets:noop,lastTitleHits:[],summaryRoot:{firstElementChild:{},lastElementChild:{}},conditions:null,lastRequest:null,
    queryInput:{value:'word'},window:{localStorage:{}},document:{createDocumentFragment:()=>({append:noop})},
    resultsRoot:{replaceChildren:noop,querySelector:()=>({classList:{add:noop}})},createResultRow:noop,
    sameSession:require('../core/title-index').sameSession,announce:noop,loadPreview:()=>{loads++;},selectResult:noop,
    response:{results:[updated],totalSessions:1,state:'complete'}});
  const start=SEARCH_SOURCE.indexOf('  function renderResults('),end=SEARCH_SOURCE.indexOf('  function renderSearchError(',start);
  vm.runInContext(SEARCH_SOURCE.slice(start,end)+'\nrenderResults(response);',context);
  assert.equal(loads,1,'升级正文后必须自动加载相关问答，不能永久保留纯标题预览');
});

test('expanding a preview keeps its current page and search filters',async()=>{
  const vm=require('node:vm'),calls=[],hit={sessionKey:'s',indexed:true,bestMatch:{eventId:'a'}};
  const context=vm.createContext({previewSequence:0,previewMode:'conversation',previewPage:{},lastRequest:{scopes:['assistant'],time:{field:'eventTime',from:1,to:10}},
    queryInput:{value:'word'},ipcRenderer:{invoke:async(channel,payload)=>{calls.push(payload);return {context:[]};}},
    isOpen:()=>true,sameSession:()=>true,results:[hit],activeIndex:0,renderPreview:()=>{},hit});
  const start=SEARCH_SOURCE.indexOf('  async function loadPreview('),end=SEARCH_SOURCE.indexOf('  async function selectResult(',start);
  await vm.runInContext(SEARCH_SOURCE.slice(start,end)+"\n(async()=>{await loadPreview(hit,{afterEventId:'a20'});await loadPreview(hit,{expandEventId:'a25'});})()",context);
  assert.equal(calls[1].afterEventId,'a20');
  assert.deepEqual(Array.from(calls[1].filters.scopes),['assistant']);
});

class FakeNode {
  constructor(tagName = null, text = '') {
    this.tagName = tagName;
    this.textContent = text;
    this.children = [];
  }
  appendChild(child) { this.children.push(child); return child; }
}

const fakeDocument = {
  createTextNode(text) { return new FakeNode(null, text); },
  createElement(tagName) { return new FakeNode(String(tagName).toUpperCase()); },
};

test('highlight rendering keeps transcript HTML inert and marks only matched text', () => {
  const root = new FakeNode('DIV');
  appendHighlightedText(fakeDocument, root, '<img src=x onerror=alert(1)> Formula', 'img formula');
  assert.equal(root.children.filter(node => node.tagName === 'MARK').length, 2);
  assert.equal(root.children.map(node => node.textContent).join(''), '<img src=x onerror=alert(1)> Formula');
  assert.equal(root.children.some(node => node.tagName === 'IMG'), false);
});

test('query helpers normalize full-width text and user-facing relative time', () => {
  assert.deepEqual(normalizeTerms('  ＡI  Hub '), ['ai', 'hub']);
  assert.equal(formatSearchTime(1_000, 1_000), '刚刚');
  assert.equal(formatSearchTime(1_000, 61_000), '1 分钟前');
});

test('index progress model distinguishes determinate, discovery and completed states', () => {
  assert.deepEqual(indexProgressModel({
    phase: 'indexing', refreshing: true, indexedSources: 1032, totalSources: 2181,
  }), {
    visible: true,
    determinate: true,
    done: 1032,
    total: 2181,
    percent: 47,
    percentText: '47%',
    detail: '正在解析会话 · 1032/2181 个来源 · 可继续使用 AI Hub',
    valueText: '正在解析会话，已完成 1032/2181，47%',
  });
  assert.equal(indexProgressModel({ phase: 'discovering', refreshing: true }).determinate, false);
  assert.equal(indexProgressModel({ phase: 'ready', ready: true, refreshing: false }).visible, false);
});

test('search close captures the focus target before clearing shared state', () => {
  assert.match(SEARCH_SOURCE, /const focusTarget = returnFocusElement;[\s\S]*requestAnimationFrame\(\(\) => focusTarget\.focus\(\)\)/);
});

test('renderer contract exposes A-layout filters, local-index status and keyboard entry', () => {
  const html = fs.readFileSync(path.join(ROOT, 'renderer', 'index.html'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'renderer', 'global-session-search.js'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'renderer', 'styles', 'global-session-search.css'), 'utf8');
  for (const id of [
    'btn-global-search', 'search-query', 'session-search-provider-filters',
    'session-search-scope-tabs', 'session-search-results-pane', 'session-search-preview',
    'session-search-progress', 'session-search-progress-track', 'session-search-progress-fill',
  ]) assert.match(html, new RegExp(`id="${id}"`));
  for (const provider of ['claude', 'codex', 'meeting', 'deepseek']) {
    assert.match(html, new RegExp(`data-provider="${provider}"`));
  }
  for (const scope of ['title', 'user', 'assistant', 'tool']) {
    assert.match(html, new RegExp(`data-scope="${scope}"`));
  }
  assert.match(js, /get-session-search-preview/);
  assert.match(js, /refresh-session-search/);
  assert.match(js, /event\.shiftKey/);
  assert.match(css, /grid-template-columns:\s*43% 57%/);
  assert.match(css, /session-search-chip\[hidden\]\s*\{\s*display:\s*none/);
  assert.match(css, /session-search-progress-track/);
  assert.match(css, /session-search-progress-indeterminate/);
  assert.doesNotMatch(html, /Type to search all past Claude transcripts/);
});
