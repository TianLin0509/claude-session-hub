'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {attachCodexTranscriptTouch}=require('../renderer/codex-transcript-touch');
function setup(){const handlers={},wheels=[];let owns=true;const container={addEventListener:(t,f)=>handlers[t]=f,removeEventListener:t=>delete handlers[t]};
 const detach=attachCodexTranscriptTouch({container,terminal:{element:{querySelector:()=>({dispatchEvent:e=>wheels.push(e)})}},ownsTranscript:()=>owns,
 WheelEvent:class{constructor(type,init){Object.assign(this,{type},init)}}});
 const event=(x,y,extra=[])=>({touches:[{identifier:1,clientX:x,clientY:y},...extra],preventDefault(){this.prevented=true},stopPropagation(){this.stopped=true}});
 return{handlers,wheels,event,detach,disable:()=>owns=false};}
test('vertical touch drag routes both directions through wheel without duplicate native touch scrolling',()=>{const h=setup();h.handlers.touchstart(h.event(50,100));const down=h.event(51,130);h.handlers.touchmove(down);assert.equal(h.wheels[0].deltaY,-30);assert(down.prevented&&down.stopped);h.handlers.touchmove(h.event(51,110));assert.equal(h.wheels[1].deltaY,20);h.handlers.touchend();h.handlers.touchmove(h.event(51,70));assert.equal(h.wheels.length,2);});
test('taps, horizontal gestures, pinch and non-Codex terminals remain native',()=>{for(const mode of ['tap','horizontal','pinch','disabled']){const h=setup();if(mode==='disabled')h.disable();h.handlers.touchstart(h.event(50,100));const e=mode==='horizontal'?h.event(80,102):mode==='pinch'?h.event(50,140,[{identifier:2}]):mode==='tap'?h.event(51,102):h.event(50,140);h.handlers.touchmove(e);assert.equal(h.wheels.length,0,mode);assert(!e.prevented,mode);h.detach();assert.equal(Object.keys(h.handlers).length,0);}});
