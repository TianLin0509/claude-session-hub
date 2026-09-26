'use strict';
const {splitChunks}=require('./pty-prompt-submit')._private;
// Crossterm reads Win32 key records, not bracketed paste, under ConPTY.
// Shift+Enter inserts a draft newline; a literal LF submits a separate turn.
// Microsoft terminal #4999: CSI Vk;Sc;Uc;Kd;Cs;Rc _.
const NEWLINE='\x1b[13;28;13;1;16;1_\x1b[13;28;13;0;16;1_';
function encodeMarttyPrompt(text,platform=process.platform){
  text=String(text).replace(/\r\n?/g,'\n');
  if(/[\x00-\x09\x0b-\x1f\x7f]/.test(text))
    throw Object.assign(new Error('此 CLI 暂不支持从卡片发送含制表符或控制字符的消息，请在终端处理；原文已保留'),{notSent:true});
  if(platform!=='win32')throw Object.assign(new Error('此终端的卡片输入尚未验证当前平台，请在 CLI 输入'),{notSent:true});
  return {text,payload:text.replace(/\n/g,NEWLINE)};
}
async function writeMarttyPrompt(write,payload){
  const chunks=splitChunks(payload,2048);
  for(let i=0;i<chunks.length;i++){write(chunks[i]);if(i+1<chunks.length)await new Promise(r=>setTimeout(r,15));}
}
module.exports={encodeMarttyPrompt,writeMarttyPrompt};
