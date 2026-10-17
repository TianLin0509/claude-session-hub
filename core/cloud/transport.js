'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const tls = require('tls');
const { execFile } = require('child_process');
const catalog = require('./catalog.json');

function buildPayload(request) {
  const source = fs.readFileSync(path.join(__dirname, 'remote.ps1'), 'utf8');
  const body = Buffer.from(JSON.stringify(request), 'utf8').toString('base64');
  const script = `[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$ProgressPreference='SilentlyContinue';& {${source}\n} '${body}'`;
  return zlib.gzipSync(Buffer.from(script, 'utf8')).toString('base64');
}
function bootstrap(input) {
  const wrapper = `$s=[IO.MemoryStream]::new([Convert]::FromBase64String(${input}));$g=[IO.Compression.GzipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);& ([scriptblock]::Create($r.ReadToEnd()))`;
  return Buffer.from(wrapper, 'utf16le').toString('base64');
}
// Remote Windows OpenSSH uses cmd.exe: keep the command below its length limit.
// The fixed script and request travel over SSH stdin, never a shell interpolation.
function buildCommand(request) { return bootstrap(`'${buildPayload(request)}'`); }
function createTransport({ home = process.env.CLAUDE_HUB_HOME_DIR || os.homedir(), run = execFile } = {}) {
  return (operation, payload = {}) => new Promise((resolve, reject) => {
    const key = path.join(home, '.ssh', catalog.machine.keyName);
    if (!fs.existsSync(key)) return reject(new Error('ssh_key_missing'));
    const request = { ...payload, operation, definitions: catalog.services.filter(s=>s.backend).map(s=>({id:s.id,port:s.port})), policy: catalog.maintenance };
    const args = ['-i',key,'-o','BatchMode=yes','-o','IdentitiesOnly=yes','-o','StrictHostKeyChecking=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=10','-o','ServerAliveCountMax=2',`${catalog.machine.user}@${catalog.machine.host}`,'powershell','-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',bootstrap('[Console]::In.ReadToEnd()')];
    const child=run('ssh',args,{windowsHide:true,timeout:operation==='execute'?90000:65000,maxBuffer:1024*1024,encoding:'utf8'},(error,stdout,stderr)=>{
      if(error) {const code=error.killed?'cloud_timeout':/Host key verification failed/i.test(stderr||'')?'ssh_host_untrusted':/Permission denied/i.test(stderr||'')?'ssh_auth_failed':'ssh_failed';reject(new Error(code));return;}
      try {const result=JSON.parse(String(stdout).replace(/^\uFEFF/,'').trim());if(!result||result.error)throw new Error('cloud_remote_failed');resolve(result);}catch(error){reject(new Error(error.message==='cloud_remote_failed'?error.message:'cloud_invalid_response'));}
    });
    child.stdin.on('error',()=>reject(new Error('ssh_failed')));
    child.stdin.end(buildPayload(request));
  });
}
function readCertificates() {
  return Promise.all(catalog.machine.domains.map(host=>new Promise(resolve=>{
    let done=false;
    const socket=tls.connect({host,port:443,servername:host,rejectUnauthorized:true});
    const finish=result=>{if(done)return;done=true;socket.destroy();resolve({host,...result});};
    socket.setTimeout(5000,()=>finish({error:'timeout'}));
    socket.on('error',()=>finish({error:'unavailable'}));
    socket.once('secureConnect',()=>{const until=Date.parse(socket.getPeerCertificate().valid_to);finish(Number.isFinite(until)?{expiresAt:new Date(until).toISOString()}:{error:'unknown'});});
  })));
}
module.exports = { createTransport, buildCommand, buildPayload, bootstrap, readCertificates };
