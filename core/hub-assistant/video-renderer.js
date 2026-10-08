'use strict';
// Offline, deterministic diagram video. Reuses the installed sharp and FFmpeg;
// no paid video model, public upload, or browser session is involved.
const fs=require('node:fs'), path=require('node:path');
const {execFile}=require('node:child_process');
const voice=require('./podcast/voice');
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c]));
const lines=(s,n=32)=>Array.from(String(s).matchAll(new RegExp(`.{1,${n}}`,'gu')),m=>m[0]);
function svgFrame(lesson,scene,index,count,phase) {
  const nodes=scene.nodes, w=1060/nodes.length, visible=Math.min(nodes.length,1+Math.floor(phase*nodes.length));
  const text=(s,x,y,size=26,color='#32323a')=>lines(s,size>=34?24:36).slice(0,3).map((l,i)=>`<text x="${x}" y="${y+i*(size+12)}" font-size="${size}" fill="${color}">${esc(l)}</text>`).join('');
  return `<svg width="1280" height="720" xmlns="http://www.w3.org/2000/svg"><rect width="1280" height="720" fill="#f7f7fa"/><g font-family="Microsoft YaHei,SimHei,sans-serif"><rect x="54" y="38" width="6" height="34" rx="3" fill="#7c3aed"/>${text('今日一档 · '+lesson.title,78,62,22,'#666674')}${text(`${index+1} / ${count}`,1110,62,22,'#666674')}${text(scene.title,70,142,40,'#18181b')}${text(scene.caption,70,220,24,'#525260')}
  ${nodes.map((n,i)=>{const x=70+i*w,on=i<visible;return `<rect x="${x}" y="320" width="${w-28}" height="142" rx="15" fill="${on?'#ffffff':'#eeeef4'}" stroke="${on?'#7c3aed':'#d9d9e4'}" stroke-width="${on?2:1}"/>${lines(n,Math.max(4,Math.floor((w-60)/24))).slice(0,3).map((l,j)=>`<text x="${x+16}" y="${374+j*34}" font-size="23" fill="${on?'#18181b':'#80808a'}">${esc(l)}</text>`).join('')}${i<nodes.length-1?`<path d="M ${x+w-24} 391 H ${x+w-4} m -7 -6 l 7 6 -7 6" fill="none" stroke="${i<visible-1?'#7c3aed':'#b8b8c4'}" stroke-width="3"/>`:''}`;}).join('')}
  <rect x="70" y="516" width="1135" height="116" rx="16" fill="#efebfb"/>${text(scene.takeaway||scene.caption,94,558,24,'#4a237c')}<rect x="70" y="669" width="1135" height="4" rx="2" fill="#e5e5ee"/><rect x="70" y="669" width="${Math.max(3,1135*(index+phase)/count)}" height="4" rx="2" fill="#7c3aed"/>${text('原理 / 例子 / 工程取舍 · 来源在课程详情中',70,704,17,'#676774')}</g></svg>`;
}
const run=(bin,args)=>new Promise((resolve,reject)=>execFile(bin,args,{windowsHide:true,maxBuffer:4*1024*1024,timeout:30*60000},(err,out,stderr)=>err?reject(Error(String(stderr||err.message).slice(-500))):resolve(out)));
async function renderVideo({lesson,audio,seconds,dir,onProgress=()=>{}}) {
  const sharp=require('sharp'),frames=path.join(dir,'frames');fs.mkdirSync(frames,{recursive:true});
  const scenes=lesson.scenes, weights=scenes.map(s=>s.weight||1), total=weights.reduce((a,b)=>a+b,0), concat=[];
  let frame=0,start=0;const chapters=[];
  for(let i=0;i<scenes.length;i++){
    const duration=seconds*weights[i]/total,steps=Math.max(3,Math.ceil(duration/4));
    chapters.push({title:scenes[i].title,at:Math.round(start)});start+=duration;
    for(let k=0;k<steps;k++){
      const file=path.join(frames,`${String(frame++).padStart(4,'0')}.png`);
      await sharp(Buffer.from(svgFrame(lesson,scenes[i],i,scenes.length,k/(steps-1)))).png().toFile(file);
      concat.push(`file '${file.replace(/\\/g,'/')}'\nduration ${duration/steps}`);
    }
    onProgress(`绘制第 ${i+1}/${scenes.length} 章机制图`,Math.round(10+60*(i+1)/scenes.length));
  }
  // Repeat the final frame so concat honors its specified duration.
  concat.push(concat.at(-1).split('\n')[0]);const list=path.join(dir,'frames.txt');fs.writeFileSync(list,concat.join('\n'),'utf8');
  const output=path.join(dir,'video.part.mp4'),t=voice.tools();onProgress('合成完整视频与声音',80);
  await run(t.ffmpeg,['-y','-loglevel','error','-f','concat','-safe','0','-i',list,'-i',audio,'-vf','fps=12,format=yuv420p','-c:v','libx264','-preset','veryfast','-crf','28','-threads','2','-c:a','aac','-b:a','48k','-movflags','+faststart','-t',String(seconds),output]);
  const actual=Number(String(await run(t.ffprobe,['-v','error','-show_entries','format=duration','-of','csv=p=0',output])).trim());
  if(!Number.isFinite(actual)||Math.abs(actual-seconds)>3)throw Error('视频时长与完整音频不符，未交付');
  fs.renameSync(output,path.join(dir,'video.mp4'));
  await sharp(Buffer.from(svgFrame(lesson,scenes[0],0,scenes.length,0.8))).resize(640,360).jpeg({quality:82}).toFile(path.join(dir,'cover.jpg'));
  return {seconds:Math.round(actual),bytes:fs.statSync(path.join(dir,'video.mp4')).size,chapters};
}
module.exports={svgFrame,renderVideo};
