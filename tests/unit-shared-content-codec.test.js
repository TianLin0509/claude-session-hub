'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {SharedContentEncoder,SharedContentDecoder}=require('../core/shared-content-codec');
const roundtrip=(decoder,key,message)=>decoder.decode(key,JSON.parse(JSON.stringify(message)));
test('large live content crosses the pipe once, then only appended text and changed metadata',()=>{
  const encoder=new SharedContentEncoder(),decoder=new SharedContentDecoder(),text='长'.repeat(200000);
  const original={transcript:[{id:'a',text}],blocks:[{text}],finalText:text,revision:1};
  assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',original)),original);
  const next={transcript:[{id:'a',text:text+'新增'}],blocks:[{text:text+'新增'}],finalText:text+'新增',revision:2};
  const encoded=encoder.encode('s',next);
  assert(Buffer.byteLength(JSON.stringify(encoded))<1000);
  assert.deepEqual(roundtrip(decoder,'s',encoded),next);
  original.transcript[0].text='mutated old source';
  assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',next)),next);
});
test('replacement, array truncation, empty text and final-only items are preserved exactly',()=>{
  const encoder=new SharedContentEncoder(),decoder=new SharedContentDecoder();
  for(const value of [{cards:[]},{cards:[{text:'partial',id:'1'},{text:'old',id:'2'}]},
    {cards:[{text:'new final',id:'1'}],done:true},{cards:[{text:'',id:'1'}]},
    {cards:[],usage:0},JSON.parse('{"cards":[],"__proto__":{"safe":true},"constructor":"text"}')]){
    assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',value)),value);
  }
  assert.equal({}.safe,undefined);
});
test('a sequence gap is explicit and a fresh snapshot recovers without guessing',()=>{
  const encoder=new SharedContentEncoder(),decoder=new SharedContentDecoder();
  roundtrip(decoder,'s',encoder.encode('s',{text:'a'}));encoder.encode('s',{text:'ab'});
  assert.throws(()=>roundtrip(decoder,'s',encoder.encode('s',{text:'abc'})),/sequence gap/);
  encoder.reset('s');assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',{text:'abcd'})),{text:'abcd'});
});
test('encoder baselines do not retain mutable provider objects',()=>{
  const encoder=new SharedContentEncoder(),decoder=new SharedContentDecoder(),value={items:[{text:'old'}]};
  roundtrip(decoder,'s',encoder.encode('s',value));value.items[0].text='changed';value.items.push({text:'new'});
  assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',value)),value);
});
test('consumer edits cannot change the decoder baseline; invalid deltas fail atomically',()=>{
  const encoder=new SharedContentEncoder(),decoder=new SharedContentDecoder();
  const value={text:'abc',items:[{text:'old'}]};
  const first=roundtrip(decoder,'s',encoder.encode('s',value));
  first.text='local';first.items[0].text='edited';
  assert.throws(()=>decoder.decode('s',{sequence:1,base:1,patches:[{op:'append',path:['text'],value:'b'}]}),/sequence gap/);
  assert.throws(()=>decoder.decode('s',{sequence:2,base:1,patches:[{op:'set',path:[{}],value:1}]}),/path key/);
  assert.throws(()=>decoder.decode('s',{sequence:2,base:1,patches:[{op:'splice',path:['items'],start:0,remove:2,values:[]}]}),/array splice/);
  assert.deepEqual(roundtrip(decoder,'s',encoder.encode('s',{...value,text:'abcd'})),{...value,text:'abcd'});
});
