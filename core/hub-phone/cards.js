'use strict';
const esc=t=>String(t).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function renderCards({BrowserWindow},text,{title='AI Hub 助理',source='',timestamp=Date.now()}={}){
  const chars=Array.from(text),pages=[];
  for(let at=0;at<chars.length;at+=1600)pages.push(chars.slice(at,at+1600).join(''));
  const win=new BrowserWindow({show:false,frame:false,useContentSize:true,width:720,height:1900,skipTaskbar:true,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});
  const images=[];
  try{for(let n=0;n<pages.length;n++){
    const html=`<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>*{box-sizing:border-box}html{overflow:hidden}body{margin:0;width:720px;padding:34px;background:#f7f9fc;font:23px/1.7 'Microsoft YaHei',sans-serif;color:#1b2942}article{padding:30px;border-radius:20px;background:white;border:1px solid #dfe6f1}h1{font-size:28px;margin:0 0 20px}p{margin:0;white-space:pre-wrap;overflow-wrap:anywhere}footer{font-size:16px;color:#63728a;margin-top:24px}</style><article><h1>${esc(title)}</h1><p>${esc(pages[n])}</p><footer>${esc(new Date(timestamp).toLocaleString('zh-CN'))} · ${n+1}/${pages.length}<br>${esc(source)}</footer></article>`;
    await win.loadURL('data:text/html;charset=utf-8,'+encodeURIComponent(html));
    const height=await win.webContents.executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)');
    win.setContentSize(720,Math.min(1900,Math.ceil(height)));
    // Capture full layout. 1600 codepoints normally fit; paginate measured overflow.
    if(height>1900){for(let top=0;top<height;top+=1800){await win.webContents.executeJavaScript('scrollTo(0,'+top+')');images.push((await win.webContents.capturePage()).toPNG());}}
    else images.push((await win.webContents.capturePage({x:0,y:0,width:720,height:Math.ceil(height)})).toPNG());
  }}finally{win.destroy();}
  return images;
}
module.exports={renderCards};
