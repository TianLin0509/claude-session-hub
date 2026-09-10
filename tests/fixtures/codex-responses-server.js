'use strict';
// Deterministic model-service fixture for performance only. Both real Codex
// TUI and real App Server use the same Responses stream, model name and effort.
const http=require('http'),{randomUUID}=require('crypto');
async function startResponsesFixture({chunks=200,delayMs=100}={}){
  const requests=[],sockets=new Set();
  const server=http.createServer((req,res)=>{
    if(req.method!=='POST' || !req.url.endsWith('/responses')){res.writeHead(404);res.end('{}');return;}
    req.setEncoding('utf8');
    let raw='';req.on('data',b=>raw+=b);req.on('end',()=>{
      let body;try{body=JSON.parse(raw);}catch{res.writeHead(400);res.end('{}');return;}
      const record={model:body.model,effort:body.reasoning?.effort,serviceTier:body.service_tier,at:Date.now(),chunks:0,completed:false,
        keys:Object.keys(body),generate:body.generate,inputCount:body.input?.length,
        lastUser:body.input?.filter(i=>i.role==='user').at(-1)?.content?.filter(i=>i.type==='input_text').map(i=>i.text).join('\n').slice(0,300)};requests.push(record);
      record.purpose=record.lastUser?.startsWith('Generate a concise, single-line task title')?'title':'workload';
      res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache','Connection':'keep-alive'});
      const id='resp_'+randomUUID(),itemId='msg_'+randomUUID();let sequence=0,text='';
      const send=(type,fields)=>res.write('event: '+type+'\ndata: '+JSON.stringify({type,sequence_number:sequence++,...fields})+'\n\n');
      const message=()=>({id:itemId,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text,annotations:[]}]});
      send('response.created',{response:{id,object:'response',status:'in_progress',model:body.model,output:[]}});
      send('response.output_item.added',{output_index:0,item:{id:itemId,type:'message',role:'assistant',status:'in_progress',content:[]}});
      send('response.content_part.added',{item_id:itemId,output_index:0,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
      const timer=setInterval(()=>{
        if(res.destroyed){clearInterval(timer);return;}
        record.chunks++;
        const delta=record.purpose==='title'?'Performance verification':'HUB_PERF_SAMPLE_'+String(record.chunks).padStart(3,'0')+' 固定输出 abcdefghijklmnopqrstuvwxyz\n';text+=delta;
        send('response.output_text.delta',{item_id:itemId,output_index:0,content_index:0,delta});
        if(record.chunks<(record.purpose==='title'?1:chunks))return;
        clearInterval(timer);if(record.purpose!=='title'){text+='HUB_PERF_DONE';send('response.output_text.delta',{item_id:itemId,output_index:0,content_index:0,delta:'HUB_PERF_DONE'});}
        send('response.output_text.done',{item_id:itemId,output_index:0,content_index:0,text});
        send('response.content_part.done',{item_id:itemId,output_index:0,content_index:0,part:message().content[0]});
        send('response.output_item.done',{output_index:0,item:message()});
        send('response.completed',{response:{id,object:'response',status:'completed',created_at:Math.floor(Date.now()/1000),model:body.model,output:[message()],usage:{input_tokens:100,output_tokens:1000,total_tokens:1100,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}});
        record.completed=true;record.endedAt=Date.now();res.end();
      },delayMs);
      res.on('close',()=>clearInterval(timer));
    });
  });
  server.on('connection',socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {port:server.address().port,requests,close:()=>new Promise(resolve=>{for(const s of sockets)s.destroy();server.close(resolve);})};
}
module.exports={startResponsesFixture};
