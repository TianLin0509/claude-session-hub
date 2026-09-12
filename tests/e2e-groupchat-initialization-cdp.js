'use strict';
// Real isolated Hub, creation modal and composer. Provider replies are stdio fixtures.
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), net = require('node:net');
const { launchIsolatedHub, gracefulQuit } = require('./helpers/hub-launcher');
const { connectFirstPage } = require('./helpers/cdp-client');
const { PreparedProjectRegistry } = require('../core/prepared-project-registry');
const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'hub-init-markdown-'));
const DATA = path.join(ROOT, 'data'), WORK = path.join(ROOT, 'work');
const ART = path.resolve('output/playwright/init-markdown-' + Date.now());
for (const dir of [DATA, WORK, ART]) fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(WORK, '.aiwork-root'), '');
const project = path.join(WORK, 'demo');
fs.mkdirSync(path.join(project, '.git'), { recursive: true });
fs.mkdirSync(path.join(project, '.agents'));
fs.writeFileSync(path.join(project, '.agents/project.json'), JSON.stringify({ name: '初始化验收项目', trunk: 'master' }));
new PreparedProjectRegistry({ dataDir: DATA }).register(project);
const freePort = () => new Promise((resolve, reject) => { const s = net.createServer(); s.on('error', reject); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function main() {
  let hub, cdp;
  const evidence = { root: ROOT, artifacts: ART, checks: [], provider: 'controlled native App Server fixture', passed: false };
  const ok = (name, condition) => { assert(condition, name); evidence.checks.push(name); console.log('PASS ' + name); };
  const wait = async (expr, label) => { const end = Date.now() + 30000; while (Date.now() < end) { if (await cdp.eval(expr)) return; await sleep(150); } throw Error('Timeout: ' + label); };
  const invoke = (ch, args) => cdp.eval(`ipcRenderer.invoke(${JSON.stringify(ch)}, ${JSON.stringify(args)})`);
  const shot = async name => { const s = await cdp.send('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(ART, name + '.png'), Buffer.from(s.data, 'base64')); };
  const click = async selector => {
    await wait(`(()=>{const e=document.querySelector(${JSON.stringify(selector)}),r=e?.getBoundingClientRect();return !!r?.width && !!r?.height;})()`, 'visible ' + selector);
    const p = await cdp.eval(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();const x=r.x+r.width/2,y=r.y+r.height/2;if(!r.width||!r.height||!e.contains(document.elementFromPoint(x,y)))throw Error('not clickable '+${JSON.stringify(selector)});return {x,y};})()`);
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...p, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...p, button: 'left', clickCount: 1 });
  };
  const type = async (selector, text, replace = false) => {
    await click(selector);
    if (replace) {
      await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
      await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    }
    await cdp.send('Input.insertText', { text });
  };
  async function checkMarkdown(container, label) {
    const frame = container + ' .conversation-long-frame';
    await wait(`!!document.querySelector(${JSON.stringify(container + ' .conversation-long-message')})`, label + ' answer');
    ok(label + ' collapsed preview renders complete bold/list/table/code/link and sanitizes HTML', await cdp.eval(`(()=>{const f=document.querySelector(${JSON.stringify(frame)}),p=f?.querySelector('.conversation-long-preview');return !!p && !f.querySelector('details').open && p.querySelector('strong')?.textContent.length>240 && !!p.querySelector('ul li') && !!p.querySelector('table') && !!p.querySelector('pre code') && !!p.querySelector('a[href="https://example.com/guide"]') && !p.querySelector('script') && !window.__markdownInjected && p.getBoundingClientRect().height>0 && p.getBoundingClientRect().height<=100;})()`));
    ok(label + ' collapsed copy has exactly one full answer', await cdp.eval(`(()=>{const text=require('./visible-card-text').extractVisibleCardText(document.querySelector(${JSON.stringify(frame)}));return (text.match(/END-OF-MARKDOWN-ANSWER/g)||[]).length===1 && (text.match(/完整正文保留用于展开/g)||[]).length===36 && !text.includes('展开全文') && !text.includes('收起全文');})()`));
    await cdp.eval(`document.querySelector(${JSON.stringify(frame)}).scrollIntoView({block:'center'})`);
    await shot(label + '-collapsed');
    await click(frame + ' > details > summary');
    ok(label + ' expanded preview hidden and full content visible', await cdp.eval(`(()=>{const f=document.querySelector(${JSON.stringify(frame)});return f.querySelector('details').open && getComputedStyle(f.querySelector('.conversation-long-preview')).display==='none' && f.querySelector('.conversation-full-text').innerText.includes('END-OF-MARKDOWN-ANSWER');})()`));
    await shot(label + '-expanded');
    await click(frame + ' > details > summary');
    await cdp.eval(`document.querySelector(${JSON.stringify(frame + ' > details > summary')}).focus()`);
    await cdp.send('Input.dispatchKeyEvent', {type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await cdp.send('Input.dispatchKeyEvent', {type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await wait(`document.querySelector(${JSON.stringify(frame + ' > details')}).open`, label + ' keyboard toggle');
    ok(label + ' keyboard opens disclosure', await cdp.eval(`document.querySelector(${JSON.stringify(frame + ' > details')}).open`));
    await click(frame + ' > details > summary');
  }
  try {
    hub = await launchIsolatedHub({ dataDir: DATA, port: await freePort(), windowMode: 'hidden', label: 'initialization-markdown', extraEnv: { AI_HUB_WORKSPACE_ROOT: WORK, CODEX_HOME: path.join(ROOT, 'codex'), CLAUDE_CONFIG_DIR: path.join(ROOT, 'claude'), CLAUDE_HUB_CODEX_APP_SERVER_FIXTURE: path.join(__dirname, 'fixtures/codex-app-server.js') } });
    cdp = await connectFirstPage(hub); evidence.pid = hub.pid; evidence.port = hub.port;
    await cdp.send('Page.bringToFront');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1500, height: 1000, deviceScaleFactor: 1, mobile: false });
    await wait('!!window.MeetingRoom && !!window.openMeetingCreateModal', 'renderer');
    await cdp.eval("openMeetingCreateModal('group')");
    await click('[data-mcm-workspace-mode="default"]');
    await click('[data-remove-member="1"]');
    await cdp.eval(`(()=>{const s=document.querySelector('.mcm-slot[data-slot="0"] .mcm-ai-select');s.value='codex';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
    await click('#meeting-create-modal .mcm-create');
    // No second selectMeeting call, typing, or manually forced render after creation.
    await wait(`!!document.querySelector('[data-file-independent]') && document.querySelector('#meeting-room-panel').getBoundingClientRect().height>0`, 'automatic first room opening');
    const group = (await invoke('get-meetings')).find(m => m.scene === 'dev'); const gid = JSON.stringify(group.id);
    evidence.group = group.id;
    ok('natural first opening has prep/start/docs and correct placeholder', await cdp.eval(`!!document.querySelector('[data-file-prep]') && !!document.querySelector('[data-file-docs]') && document.querySelector('#mr-input-box').dataset.placeholder.includes('独立开工')`));
    await shot('initial');
    for (const theme of ['frost', 'dark', 'claude', 'codex', 'hub', 'slate']) {
      await cdp.eval(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
      const contrast = await cdp.eval(`(()=>{
        const rgba=s=>s.match(/[\\d.]+/g).map(Number);
        const bg=e=>{if(!e)return [255,255,255];const c=rgba(getComputedStyle(e).backgroundColor),a=c[3]??1,p=a<1?bg(e.parentElement):[0,0,0];return c.slice(0,3).map((v,i)=>v*a+p[i]*(1-a));};
        const lum=c=>{c=c.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return .2126*c[0]+.7152*c[1]+.0722*c[2]};
        return [...document.querySelectorAll('.mr-file-actions button')].map(e=>{const s=getComputedStyle(e),a=lum(rgba(s.color).slice(0,3)),b=lum(bg(e));return {text:e.textContent,ratio:(Math.max(a,b)+.05)/(Math.min(a,b)+.05),fg:s.color,bg:bg(e)};});
      })()`);
      (evidence.contrast ||= {})[theme] = contrast;
      // Composite translucent theme backgrounds over their actual ancestors.
      ok(theme + ' control text contrast >= 4.5', contrast.every(c => c.ratio >= 4.5));
    }
    await cdp.eval("document.documentElement.dataset.theme='frost'");
    for (const width of [1500, 1000, 760]) {
      await cdp.send('Emulation.setDeviceMetricsOverride', { width, height:1000,deviceScaleFactor:1,mobile:false });
      ok(width + ' buttons visible and hit-testable', await cdp.eval(`Array.from(document.querySelectorAll('.mr-file-actions button')).every(e=>{const r=e.getBoundingClientRect();return r.width>0&&r.x>=0&&r.right<=innerWidth&&e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})`));
      await shot('buttons-' + width);
    }
    await type('#mr-input-box', '保留草稿');
    await invoke('update-meeting-sync',{ meetingId:group.id,fields:{serialWorkflow:null} });
    await wait(`!document.querySelector('[data-file-independent]')`, 'workflow removed');
    await invoke('update-meeting-sync',{ meetingId:group.id,fields:{serialWorkflow:group.serialWorkflow} });
    await wait(`!!document.querySelector('[data-file-independent]')`, 'workflow restored');
    ok('configuration-only updates preserve draft', await cdp.eval(`document.querySelector('#mr-input-box').innerText==='保留草稿'`));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width:1500,height:1000,deviceScaleFactor:1,mobile:false });
    const ordinary = await invoke('create-session',{kind:'codex',opts:{cwd:project,model:'gpt-6-astra',effort:'high',mcpProfile:'none'}});
    await wait(`sessions.get(${JSON.stringify(ordinary.id)})?.nativeRuntime?.state==='idle'`, 'ordinary native ready');
    await wait(`!!document.querySelector('[data-session-id="${ordinary.id}"]')`, 'ordinary sidebar');
    await click(`[data-session-id="${ordinary.id}"]`);
    await wait(`!!document.querySelector('.floating-input-box')`, 'ordinary composer');
    await type('.floating-input-box', 'fixture:collapsed-markdown'); await click('.floating-input-send');
    await checkMarkdown('#msg-overlay', 'ordinary');
    await click(`[data-meeting-id="${group.id}"]`);
    await wait(`document.querySelector('#mr-input-box')?.innerText==='保留草稿'`, 'group draft restored');
    await type('#mr-input-box', 'fixture:collapsed-markdown', true); await click('#mr-send-btn');
    await checkMarkdown('.mr-gc-messages', 'group');
    await cdp.send('Page.reload');
    await wait(`typeof meetings!=='undefined' && !!meetings[${gid}]`, 'renderer reload');
    await click(`[data-meeting-id="${group.id}"]`);
    await checkMarkdown('.mr-gc-messages', 'group-reload');
    await click(`[data-session-id="${ordinary.id}"]`);
    await checkMarkdown('#msg-overlay', 'ordinary-reload');
    evidence.passed = true;
  } catch (error) {
    evidence.error = error.stack;
    if (cdp) { await shot('failure'); evidence.ui = await cdp.eval('document.body.innerText.slice(-6000)'); }
    throw error;
  } finally {
    if (hub) fs.writeFileSync(path.join(ART,'hub.log'),hub.log().join('\n'));
    try { if(cdp) await cdp.close(); } finally { if(hub) await gracefulQuit(hub); }
    fs.writeFileSync(path.join(ART,'checks.json'),JSON.stringify(evidence,null,2)); console.log('ARTIFACT_ROOT '+ART);
  }
}
main().catch(e=>{console.error(e);process.exitCode=1;});
