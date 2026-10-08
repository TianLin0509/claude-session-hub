'use strict';
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {renderVideo}=require('./video-renderer');
const CHUNK=192*1024,ID=/^[A-Za-z0-9-]{8,64}$/;
function validateScenes(scenes){
  if(!Array.isArray(scenes)||scenes.length<4||scenes.length>16)throw Error('视频需要 4–16 个有机制图的章节');
  return scenes.map(s=>{
    for(const [key,max] of [['title',70],['caption',120],['takeaway',120]])if(typeof s[key]!=='string'||!s[key].trim()||s[key].length>max)throw Error('视频章节文字无效：'+key);
    if(!Array.isArray(s.nodes)||s.nodes.length<2||s.nodes.length>5||s.nodes.some(n=>typeof n!=='string'||!n.trim()||n.length>24))throw Error('机制图需要 2–5 个短标签节点');
    return {title:s.title,caption:s.caption,takeaway:s.takeaway,nodes:s.nodes,weight:Math.max(1,Math.min(10,Number(s.weight)||1))};
  });
}
class VideoStudio{
  constructor({assistant,renderer=renderVideo}){
    this.a=assistant;this.root=path.join(assistant.deps.dataDir,'assistant','videos');this.renderer=renderer;this.running=new Map();this.queue=Promise.resolve();fs.mkdirSync(this.root,{recursive:true});
    for(const m of this.list())if(m.status==='working')this.save({...m,status:'interrupted',phase:'上次制作被中断，可以让助理继续制作'});
  }
  dir(id){if(!ID.test(id))throw Error('视频编号无效');return path.join(this.root,id);}
  read(id){return JSON.parse(fs.readFileSync(path.join(this.dir(id),'manifest.json'),'utf8'));}
  save(m){const dir=this.dir(m.id);fs.mkdirSync(dir,{recursive:true});const f=path.join(dir,'manifest.json');fs.writeFileSync(f+'.tmp',JSON.stringify(m));fs.renameSync(f+'.tmp',f);this.a.workbench?.changed();return m;}
  list(){const out=[];for(const id of fs.readdirSync(this.root)){if(!ID.test(id))continue;try{out.push(this.read(id));}catch(e){console.warn('[assistant] video manifest',id,e.message);}}return out.sort((a,b)=>b.createdAt-a.createdAt).slice(0,30);}
  summary(){return this.list().map(({scenes,...m})=>m);}
  start(lesson,podcastId){
    const scenes=validateScenes(lesson.scenes),id='video-'+crypto.createHash('sha256').update(JSON.stringify([podcastId,scenes])).digest('hex').slice(0,20);
    if(fs.existsSync(path.join(this.dir(id),'manifest.json'))&&(['done','working'].includes(this.read(id).status)||this.running.has(id)))return{id,duplicate:true};
    const m=this.save({id,podcastId,title:lesson.title,scenes,why:lesson.why||'',evidenceRefs:lesson.evidenceRefs||[],sources:lesson.sources,oneMinute:lesson.oneMinute,questions:lesson.questions,createdAt:Date.now(),status:'working',phase:'等待课程声音完成',progress:0,seconds:0,bytes:0});
    // Capture the dependency now: no polling and no second TTS call.
    const audioJob=this.a.podcasts.running.get(podcastId);
    const job=this.queue.then(async()=>{
      if(audioJob)await audioJob;
      const pod=this.a.podcasts.read(podcastId);if(pod.status!=='done')throw Error(pod.error||'声音未完成，视频等待重做');
      const r=await this.renderer({lesson:m,audio:this.a.podcasts.file(podcastId,1,'audio'),seconds:pod.episodes[0].seconds,dir:this.dir(id),onProgress:(phase,progress)=>this.save({...this.read(id),phase,progress})});
      this.save({...this.read(id),...r,status:'done',phase:'视频已完成，可以下载观看',progress:100,sha256:crypto.createHash('sha256').update(fs.readFileSync(path.join(this.dir(id),'video.mp4'))).digest('hex'),finishedAt:Date.now()});
    }).catch(e=>{console.warn('[assistant] video',e.message);this.save({...this.read(id),status:'failed',phase:'制作失败：'+e.message,error:e.message});}).finally(()=>this.running.delete(id));
    this.queue=job;this.running.set(id,job);return{id};
  }
  chunk(id,index){const m=this.read(id);if(m.status!=='done')throw Error('视频还没完成');if(!Number.isInteger(index)||index<0||index>=Math.ceil(m.bytes/CHUNK))throw Error('视频分段编号无效');const f=path.join(this.dir(id),'video.mp4'),fd=fs.openSync(f,'r');try{const b=Buffer.alloc(Math.min(CHUNK,m.bytes-index*CHUNK)),n=fs.readSync(fd,b,0,b.length,index*CHUNK);if(n!==b.length)throw Error('视频文件被改变，请刷新');return{id,index,total:Math.ceil(m.bytes/CHUNK),bytes:m.bytes,sha256:m.sha256,data:b.toString('base64')};}finally{fs.closeSync(fd);}}
  cover(id){return fs.readFileSync(path.join(this.dir(id),'cover.jpg')).toString('base64');}
}
module.exports={VideoStudio,CHUNK,validateScenes};
