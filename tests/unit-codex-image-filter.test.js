'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonImageFilter, OMITTED_IMAGE } = require('../core/json-image-filter');
const { CodexAppServerClient } = require('../main/codex-app-server-client');

function filter(value, chunkSize = 7) {
  const f = new JsonImageFilter(), input = JSON.stringify(value);
  let result = '';
  for (let i = 0; i < input.length; i += chunkSize) result += f.feed(input.slice(i, i + chunkSize));
  return JSON.parse(result);
}
test('filters native generated images, MCP image blocks and nested data URIs, preserving text/paths/identity', () => {
  const b64 = 'iVBORw0KGgo' + 'A'.repeat(300);
  const original = {id:23, result:{thread:{id:'same-thread',turns:[{id:'same-turn',items:[
    {type:'imageGeneration',result:b64,path:'C:\\images\\saved.png'},
    {type:'mcpToolCall',result:{content:[{type:'image',data:b64,mimeType:'image/png'}, {type:'text',text:'前缀 ![图片](data:image/png;base64,'+b64+') 后缀'}]}},
    {type:'agentMessage',text:'正文 😀 中文，反斜杠 \\ 和 "引号"\n保留',url:'https://example.com/image.png'},
    {result:b64,type:'imageGeneration'},
    {type:'commandExecution',aggregatedOutput:'完整文本'.repeat(1000)},
  ]}]}}};
  for (const size of [1, 2, 7, 191, 4096]) {
    const r=filter(original,size); const items=r.result.thread.turns[0].items;
    assert.equal(r.id,23); assert.equal(r.result.thread.id,'same-thread');
    assert.equal(items[0].result,OMITTED_IMAGE);assert.equal(items[0].path,original.result.thread.turns[0].items[0].path);
    assert.equal(items[1].result.content[0].data,OMITTED_IMAGE);
    assert.equal(items[1].result.content[1].text,'前缀 ![图片]('+OMITTED_IMAGE+') 后缀');
    assert.deepEqual(items[2],original.result.thread.turns[0].items[2]);
    assert.equal(items[3].result,OMITTED_IMAGE);
    assert.deepEqual(items[4],original.result.thread.turns[0].items[4]);
  }
});
test('escaped JSON image URLs and escaped slashes are stripped without losing surrounding output', () => {
  const value={text:JSON.stringify({image_url:'data:image/png;base64,'+'A'.repeat(1000),path:'saved.png'})};
  const r=filter(value,1);
  assert.deepEqual(JSON.parse(r.text),{image_url:OMITTED_IMAGE,path:'saved.png'});
  const f=new JsonImageFilter();
  assert.equal(JSON.parse(f.feed('"data:image\\/jpeg;base64,\\/9j\\/'+'A'.repeat(500)+'"')),OMITTED_IMAGE);
});
test('40 MiB image resume succeeds before the unchanged 32 MiB non-image limit; subsequent message still parses', () => {
  for (const chunkSize of [65536, Infinity]) {
    const client=new CodexAppServerClient(); let received, notification;
    client.pending.set(1,{resolve:value=>received=value,reject:error=>{throw error;}});
    client.on('notification',msg=>notification=msg);
    const bytes=Buffer.from(JSON.stringify({id:1,result:{thread:{id:'original',items:[{type:'imageGeneration',result:'A'.repeat(40*1024*1024)}]}}})+'\n'+JSON.stringify({method:'turn/completed',params:{turnId:'next'}})+'\n');
    for(let i=0;i<bytes.length;i+=chunkSize)client.feed(bytes.subarray(i,i+chunkSize));
    assert.equal(client.closed,false);assert.equal(received.thread.id,'original');
    assert.equal(received.thread.items[0].result,OMITTED_IMAGE);
    assert.equal(notification.params.turnId,'next');assert.equal(client.buffer,'');
  }
  const client=new CodexAppServerClient();let disconnect;
  client.on('disconnect',e=>disconnect=e);
  client.feed(Buffer.from(JSON.stringify({method:'text',params:{text:'x'.repeat(33*1024*1024)}})+'\n'));
  assert.equal(client.closed,true);assert.match(disconnect.message,/32 MiB/);
});
test('malformed image JSON still fails closed', () => {
  const client=new CodexAppServerClient();let disconnect;
  client.on('disconnect',e=>disconnect=e);
  client.feed(Buffer.from('{"method":"test","params":{"type":"image","data":"bad\\q"}}\n'));
  assert.equal(client.closed,true);assert.match(disconnect.message,/JSON/);
});
test('native user echoes preserve intentional image/text input for exact submission reconciliation', () => {
  const item={type:'userMessage',id:'user',content:[{type:'text',text:'参考 data:image/png;base64,ABC='},
    {type:'image',url:'data:image/png;base64,'+'A'.repeat(1000)}]};
  for(const size of [1,7,4096])assert.deepEqual(filter(item,size),item);
  assert.deepEqual(filter({base64:'ordinary metadata',text:'example iVBORw0KGgo'}),{base64:'ordinary metadata',text:'example iVBORw0KGgo'});
});
