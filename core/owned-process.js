'use strict';
const {execFileSync} = require('child_process');
function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid,0); return true; }
  catch(error) {if(error.code==='ESRCH')return false;if(error.code==='EPERM')return true;throw error;}
}
function startedAt(pid) {
  if (pid === process.pid) return Date.now() - process.uptime()*1000;
  if(process.platform==='win32') {
    const script=`$ErrorActionPreference='Stop'; try { $p=Get-Process -Id ${pid}; [DateTimeOffset]::new($p.StartTime.ToUniversalTime()).ToUnixTimeMilliseconds() } catch { exit 2 }`;
    return Number(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{encoding:'utf8',windowsHide:true,timeout:5000}).trim());
  }
  return Date.parse(execFileSync('ps',['-p',String(pid),'-o','lstart='],{encoding:'utf8',timeout:5000}).trim());
}
// Called only on an ownership conflict/recovery, never on a polling timer.
// A live PID whose process was born after we recorded it is a reused number.
function matches(pid, observedAt, readStartedAt=startedAt) {
  if(!alive(pid))return false;
  if(!observedAt)return true; // Old records lack proof; do not steal their writer.
  let birth;
  try {birth=readStartedAt(pid);} catch(error) {if(!alive(pid))return false;throw Error('无法核对会话占用进程身份：'+error.message);}
  if(!Number.isFinite(birth) || birth<=0)throw Error('无法核对会话占用进程的启动时间');
  return birth<=observedAt;
}
module.exports={alive,startedAt,matches};
