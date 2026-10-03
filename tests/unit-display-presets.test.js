'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {loadPresets,STORAGE_KEY}=require('../renderer/display-presets');
test('display migration preserves desktop adjustments and gives phone an independent baseline',()=>{
  const data=new Map(),storage={getItem:key=>data.get(key)};
  const state=loadPresets(storage,{fontSize:21,zoomLevel:2});
  assert.equal(state.desktop.fontSize,21);assert.equal(state.desktop.zoomLevel,2);
  assert.equal(state.desktop.sessionWidth,null,'existing responsive desktop widths stay in charge');
  assert.equal(state.phone.fontSize,18);assert.equal(state.phone.sessionWidth,200);
  assert.equal(state.phone.terminalFontSize,14);assert.equal(state.desktop.terminalFontSize,21);
  state.mode='phone';state.phone.fontSize=20;state.phone.sessionWidth=192;
  data.set(STORAGE_KEY,JSON.stringify(state));
  const reloaded=loadPresets(storage,{fontSize:13,zoomLevel:0});
  assert.equal(reloaded.mode,'phone');assert.equal(reloaded.phone.fontSize,20);
  assert.equal(reloaded.phone.sessionWidth,192);assert.equal(reloaded.desktop.fontSize,21);
});
test('old saved modes preserve desktop CLI size and migrate phone CLI independently',()=>{
  const storage={getItem:()=>JSON.stringify({mode:'phone',desktop:{fontSize:23},phone:{fontSize:20,sessionWidth:192}})};
  const result=loadPresets(storage,{fontSize:16});
  assert.equal(result.desktop.terminalFontSize,23);assert.equal(result.phone.terminalFontSize,14);
  assert.equal(result.phone.fontSize,20);assert.equal(result.phone.sessionWidth,192);
  const manual=loadPresets({getItem:()=>JSON.stringify({...result,phone:{...result.phone,terminalFontSize:15}})});
  assert.equal(manual.phone.terminalFontSize,15);
});
test('damaged saved preferences recover locally without changing the other profile',()=>{
  const storage={getItem:()=>JSON.stringify({mode:'bad',desktop:{fontSize:19},phone:{fontSize:999,sessionWidth:'bad',inputHeight:-1}})};
  const result=loadPresets(storage,{fontSize:16});
  assert.equal(result.mode,'desktop');assert.equal(result.desktop.fontSize,19);
  assert.equal(result.phone.fontSize,28);assert.equal(result.phone.sessionWidth,200);assert.equal(result.phone.inputHeight,40);
  assert.equal(loadPresets({getItem:()=>'{broken'}).phone.fontSize,18);
});


test('single-line migration only widens the former phone default once',()=>{
 const load=state=>loadPresets({getItem:()=>JSON.stringify(state)});
 const old=load({phone:{sessionWidth:176,fontSize:20,terminalFontSize:15}});
 assert.equal(old.phone.sessionWidth,200);assert.equal(old.phone.fontSize,20);assert.equal(old.phone.terminalFontSize,15);
 assert.equal(load({phone:{sessionWidth:220}}).phone.sessionWidth,220);
 assert.equal(load({...old,phone:{...old.phone,sessionWidth:176}}).phone.sessionWidth,176);
});
