'use strict';
// Real isolated Chrome and a local HTTP origin. Ordinary account visits and handoffs
// preserve the profile, expose no debugging port, and leave unrelated tasks alone.
const fs=require('fs'),path=require('path'),http=require('http'),assert=require('node:assert/strict');
const {spawn,execFileSync}=require('child_process');
const {HubChrome}=require('../core/hub-chrome');
const {BrowserTool}=require('../core/hub-browser-tool');
const guard=require('../core/web-risk-guard');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
(async()=>{
 const out=path.resolve('artifacts/20261001-human-mode-codex1');fs.mkdirSync(out,{recursive:true});
 const root=fs.mkdtempSync(path.join(out,'profile-'));const env={...process.env,HUB_CHROME_ROOT:root};
 const requests=[];const origin=http.createServer((req,res)=>{requests.push({cookie:req.headers.cookie||'',url:req.url});res.setHeader('content-type','text/html');res.end('<title>Hub local account fixture</title><textarea></textarea>');});
 await new Promise(r=>origin.listen(0,'127.0.0.1',r));const url='http://127.0.0.1:'+origin.address().port+'/account';
 // Park this owned test window off screen so it never interrupts typing.
 const hub=new HubChrome({root,env,proxy:'',spawnImpl:(exe,args,opts)=>spawn(exe,[...args.filter(a=>a!=='--start-maximized'&&!a.startsWith('--window-position=')),'--window-position=-32000,-32000'],{...opts,windowsHide:true})});
 const playwright=process.env.HUB_E2E_PLAYWRIGHT||'C:/DevTools/playwright-cli-0.1.19/node_modules/playwright/index.js';
 const tool=new BrowserTool({id:'images-human-mode-e2e',tool:'images',identity:'main',root,playwright},{env,hub});
 const evidence={boundary:'real Chrome, isolated profile, local HTTP origin; test window off screen',passed:false};let ordinaryPid=null;
 const verifyAndClose=()=>{
  assert(ordinaryPid>0);const escaped=root.replace(/'/g,"''");
  const ps=`$p=Get-Process -Id ${ordinaryPid} -ErrorAction Stop; $c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${ordinaryPid}'; if($p.ProcessName -ne 'chrome' -or $c.CommandLine -notmatch [Regex]::Escape('${escaped}') -or $c.CommandLine -match 'remote-debugging-port'){throw 'Unexpected ordinary browser identity or debugging port'};
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class OwnedChromeCloser { public delegate bool Callback(IntPtr h,IntPtr l); [DllImport("user32.dll")]public static extern bool EnumWindows(Callback c,IntPtr l); [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")]public static extern int GetClassName(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")]public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l); }
'@
[OwnedChromeCloser]::EnumWindows({param($h,$l) $taskPid=0; [OwnedChromeCloser]::GetWindowThreadProcessId($h,[ref]$taskPid)|Out-Null; $taskClass=New-Object Text.StringBuilder 100;[OwnedChromeCloser]::GetClassName($h,$taskClass,100)|Out-Null;if($taskPid -eq ${ordinaryPid} -and $taskClass.ToString() -eq 'Chrome_WidgetWin_1'){[OwnedChromeCloser]::PostMessage($h,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)|Out-Null};$true},[IntPtr]::Zero)|Out-Null; if(-not $p.WaitForExit(15000)){throw 'Owned Chrome did not exit'}; 'ordinary-process-verified-and-closed'`;
  const proof=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,encoding:'utf8',timeout:20000}).trim();ordinaryPid=null;return proof;
 };
 const waitRequest=async(from,expected='/account',cookie='login_fixture=main-login')=>{for(let i=0;i<100;i++){const row=requests.slice(from).find(r=>r.url===expected&&(!cookie||r.cookie.includes(cookie)));if(row)return row;await sleep(100);}throw Error('Ordinary browser did not send the expected account request');};
 const windows=()=>{
  const escaped=root.replace(/'/g,"''");
  const ps=`$c=Get-CimInstance Win32_Process -Filter 'ProcessId = ${ordinaryPid}';if($c.Name -ne 'chrome.exe' -or -not $c.CommandLine.Contains('${escaped}') -or $c.CommandLine -match 'remote-debugging-port'){throw 'Unexpected browser identity'};
Add-Type -AssemblyName UIAutomationClient
Add-Type @'
using System;using System.Text;using System.Runtime.InteropServices;
public class OwnedWindowReader { public delegate bool Callback(IntPtr h,IntPtr l); [DllImport("user32.dll")]public static extern bool EnumWindows(Callback c,IntPtr l); [DllImport("user32.dll")]public static extern uint GetWindowThreadProcessId(IntPtr h,out uint p); [DllImport("user32.dll")]public static extern int GetClassName(IntPtr h,StringBuilder s,int n); [DllImport("user32.dll")]public static extern bool IsWindowVisible(IntPtr h); }
'@
$rows=New-Object Collections.Generic.List[object];[OwnedWindowReader]::EnumWindows({param($h,$l) $owner=0;[OwnedWindowReader]::GetWindowThreadProcessId($h,[ref]$owner)|Out-Null;$cls=New-Object Text.StringBuilder 100;[OwnedWindowReader]::GetClassName($h,$cls,100)|Out-Null;if($owner -eq ${ordinaryPid} -and $cls.ToString() -eq 'Chrome_WidgetWin_1' -and [OwnedWindowReader]::IsWindowVisible($h)){$w=[Windows.Automation.AutomationElement]::FromHandle($h);$cond=New-Object Windows.Automation.PropertyCondition([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::TabItem);$tabs=$w.FindAll([Windows.Automation.TreeScope]::Descendants,$cond);$rows.Add([pscustomobject]@{tabs=$tabs.Count})};$true},[IntPtr]::Zero)|Out-Null;ConvertTo-Json -InputObject @($rows.ToArray()) -Compress`;
  return JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',ps],{windowsHide:true,encoding:'utf8',timeout:20000}).trim());
 };
 try{
  await hub.ensure();const {cdp}=await hub.browser();const mark=await hub.marker('main',cdp);cdp.close();
  const p=await hub.page(mark.targetId);try{assert.equal((await p.call('Network.setCookie',{name:'login_fixture',value:'main-login',url,httpOnly:true,expires:Date.now()/1000+3600})).success,true);}finally{p.close();}
  hub.site=()=>({name:'Local account fixture',url});
  const visit=await hub.openWebsite('main','claude');ordinaryPid=hub.lastLaunchPid;assert.equal(visit.mode,'ordinary');await waitRequest(0);
  assert.equal(await hub.endpoint(),null);assert.equal(hub.profileHeld(),true);evidence.accountVisitNoCDP=true;evidence.loginCookieSentByOrdinaryChrome=true;
  let from=requests.length;hub.site=()=>({name:'Local account fixture',url:url+'/second'});
  const second=await hub.openWebsite('main','chatgpt');await waitRequest(from,'/account/second');assert.equal(second.pid,ordinaryPid,'Keep tracking the persistent browser, not the short-lived tab launcher');
  let rows=windows();assert.equal(rows.length,1);assert.equal(rows[0].tabs,2);evidence.sameAccountOneWindowTwoTabs=true;
  from=requests.length;hub.site=()=>({name:'Local account fixture',url:url+'/alt'});await hub.openWebsite('alt','chatgpt');
  const alt=await waitRequest(from,'/account/alt',null);assert.ok(!alt.cookie.includes('login_fixture=main-login'),'Another identity must not inherit the main login');
  rows=windows();assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.tabs).sort(),[1,2]);evidence.identitiesKeepSeparateWindows=true;evidence.mainCookieNotSentByAlt=true;
  hub.site=()=>({name:'Local account fixture',url});evidence.accountProcessProof=verifyAndClose();
  await tool.open('about:blank');await tool.execute(['goto',url]);
  await assert.rejects(tool.execute(['human-open',url]),{code:'HUB_BROWSER_BUSY'});assert.ok(await tool.target());assert.equal(guard.handoff(root),null);evidence.busyPagePreserved=true;
  await tool.execute(['goto','about:blank']);
  const before=requests.length;const handoff=await tool.execute(['human-open',url]);ordinaryPid=hub.lastLaunchPid;
  assert.equal(handoff.handoff,true);assert.equal(guard.handoff(root).mode,'ordinary');assert.equal(await hub.endpoint(),null);
  await waitRequest(before);await assert.rejects(tool.execute(['goto',url]),/Human handoff/);evidence.ordinaryHandoffNoCDP=true;evidence.automationRefused=true;
  evidence.handoffProcessProof=verifyAndClose();assert.equal(await guard.settleHandoff(hub),null);assert.equal(guard.handoff(root),null);
  await tool.open('about:blank');const after=await tool.execute(['goto',url]);assert.equal(after.url,url);evidence.automationResumed=true;
  const owned=await tool.target();const page=await hub.page(owned.targetId);try{const c=await page.call('Network.getCookies',{urls:[url]});assert.equal(c.cookies.find(x=>x.name==='login_fixture').value,'main-login');}finally{page.close();}
  evidence.loginCookieRetainedAfterModeChanges=true;evidence.passed=true;
 }catch(e){evidence.error=e.message;process.exitCode=1;}
 finally{if(!ordinaryPid&&hub.profileHeld()&&!await hub.endpoint())ordinaryPid=hub.lastLaunchPid;if(ordinaryPid)try{verifyAndClose();}catch(e){evidence.cleanupError=e.message;}await hub.close().catch(()=>{});origin.closeAllConnections();await new Promise(r=>origin.close(r));fs.writeFileSync(path.join(out,'20261001-evidence-codex1.json'),JSON.stringify(evidence,null,2));}
 console.log(JSON.stringify(evidence,null,2));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
