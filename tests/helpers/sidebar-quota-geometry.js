'use strict';
const assert = require('assert');
const { _waitMs } = require('./hub-launcher');
const { click } = require('./usage-refresh-fixture');

// Read actual rendered leaf rectangles, including period labels. Checking only
// provider containment misses siblings that overlap inside the same provider.
async function measureQuota(cdp) {
  return cdp.eval(`(() => {
    const rect = e => { const r = e.getBoundingClientRect(); return {
      text: e.textContent, x: r.x, right: r.right, y: r.y, bottom: r.bottom, width: r.width
    }; };
    const providers = [...document.querySelectorAll('.sidebar-quota-provider')].map(p => ({
      provider: p.dataset.provider, box: rect(p),
      items: [...p.querySelectorAll('.sidebar-quota-name,.sidebar-quota-period,.sidebar-quota-value,.sidebar-quota-refresh')]
        .filter(e => e.textContent).map(rect),
      buttons: [...p.querySelectorAll('button')].map(e => {
        const r = e.getBoundingClientRect();
        return { x:r.x, y:r.y, width: r.width, height: r.height, hit: e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) };
      })
    }));
    const quota = rect(document.querySelector('.sidebar-quota'));
    const overlaps = [], overflow = [];
    for (const p of providers) {
      if (p.box.x < quota.x-.5 || p.box.right > quota.right+.5) overflow.push({provider:p.provider, box:p.box, quota});
      for (const a of p.items) if (a.x < p.box.x-.5 || a.right > p.box.right+.5) overflow.push({provider:p.provider, item:a});
      for (let i=0;i<p.items.length;i++) for (let j=i+1;j<p.items.length;j++) {
        const a=p.items[i], b=p.items[j];
        if (Math.min(a.right,b.right)-Math.max(a.x,b.x)>.5 && Math.min(a.bottom,b.bottom)-Math.max(a.y,b.y)>.5)
          overlaps.push({provider:p.provider,a,b});
      }
    }
    const sidebar=document.querySelector('#session-sidebar'), computed=getComputedStyle(sidebar);
    return {quota, providers, overlaps, overflow, layout:{
      sidebar:{...rect(sidebar),text:undefined}, computedWidth:computed.width, styleWidth:sidebar.style.width,
      minWidth:computed.minWidth, transition:computed.transition,
      zoom:require('electron').webFrame.getZoomFactor(),
      animations:sidebar.getAnimations().map(a=>({state:a.playState,currentTime:a.currentTime,property:a.transitionProperty}))
    }};
  })()`);
}
function assertSidebarLayout(geometry, width, zoom) {
  assert.ok(Math.abs(geometry.layout.sidebar.width-width)<=.5,
    `sidebar target ${width}, actual ${geometry.layout.sidebar.width}: ${JSON.stringify(geometry.layout)}`);
  assert.ok(Math.abs(geometry.layout.zoom-zoom)<.001, `zoom target ${zoom}, actual ${geometry.layout.zoom}`);
  assert.ok(!geometry.layout.animations.some(a=>a.state==='running'||a.state==='pending'), 'sidebar animations must finish before sampling');
}

// Static layout coverage deliberately excludes transition timing. Only the test
// page's sidebar transition is disabled; product styles and data are unchanged.
async function setStaticSidebarLayout(cdp, width, zoom) {
  await cdp.eval(`(() => {
    if(!document.querySelector('#quota-test-static-layout')) {
      const style=document.createElement('style'); style.id='quota-test-static-layout';
      style.textContent='#session-sidebar { transition: none !important; }'; document.head.append(style);
    }
    require('electron').webFrame.setZoomFactor(${zoom});
    const sidebar=document.querySelector('#session-sidebar');
    sidebar.style.width='${width}px'; sidebar.style.minWidth='${width}px';
  })()`);
  return waitForSidebarLayout(cdp,width,zoom);
}

async function waitForSidebarLayout(cdp,width,zoom) {
  const deadline=Date.now()+8000, samples=[];
  let last, previous, stable=0;
  while(Date.now()<deadline) {
    last=await measureQuota(cdp);
    const buttons=last.providers.flatMap(p=>p.buttons).map(b=>[b.x,b.y,b.width,b.height]);
    const positions=JSON.stringify(buttons);
    const atTarget=Math.abs(last.layout.sidebar.width-width)<=.5 && Math.abs(last.layout.zoom-zoom)<.001
      && !last.layout.animations.some(a=>a.state==='running'||a.state==='pending');
    stable=atTarget && positions===previous ? stable+1 : atTarget ? 1 : 0;
    samples.push({width:last.layout.sidebar.width,zoom:last.layout.zoom,animations:last.layout.animations,buttons});
    if(stable===3) {
      assertSidebarLayout(last,width,zoom);
      return {...last,stability:{consecutive:stable,samples}};
    }
    previous=positions;
    await _waitMs(80);
  }
  const error=new Error(`Sidebar did not settle at ${width}/${zoom}: ${JSON.stringify(last?.layout)}`);
  error.layoutEvidence={last,samples};
  throw error;
}

async function clickQuotaOnce(cdp,provider,width,zoom) {
  const before=await waitForSidebarLayout(cdp,width,zoom);
  await cdp.eval(`(() => {
    window.quotaPointerEvidence={events:[],before:accountUsageController.getSnapshot().refresh};
    if(window.quotaPointerObserverInstalled) return;
    window.quotaPointerObserverInstalled=true;
    for(const type of ['pointerdown','pointerup','click']) document.addEventListener(type,e=>{
      const button=e.target.closest?.('.sidebar-quota-refresh');
      window.quotaPointerEvidence.events.push({type,x:e.clientX,y:e.clientY,trusted:e.isTrusted,
        provider:button?.closest('[data-provider]')?.dataset.provider || null,
        target:e.target.tagName,width:document.querySelector('#session-sidebar').getBoundingClientRect().width,
        zoom:require('electron').webFrame.getZoomFactor()});
    },true);
  })()`);
  // Exactly one real mouse down/up pair; no synthetic DOM click or retry.
  await click(cdp,`.sidebar-quota-provider[data-provider="${provider}"] button`);
  return before;
}

async function readQuotaPointerEvidence(cdp) {
  return cdp.eval(`({...(window.quotaPointerEvidence || {}),after:accountUsageController.getSnapshot().refresh})`);
}
function assertQuotaPointerEvidence(trace,provider,width,zoom) {
  assert.ok(!trace.before.providers[provider].inFlight && !trace.before.providers[provider].result
    && !trace.before.providers[provider].error, 'refresh starts from an untouched provider state');
  assert.deepStrictEqual(trace.events.map(e=>e.type),['pointerdown','pointerup','click']);
  assert.ok(trace.events.every(e=>e.trusted && e.provider===provider && Math.abs(e.width-width)<=.5 && Math.abs(e.zoom-zoom)<.001));
  assert.ok(trace.after.providers[provider].result || trace.after.providers[provider].error, 'controller received the refresh');
}
module.exports = { measureQuota, assertSidebarLayout, setStaticSidebarLayout, waitForSidebarLayout,
  clickQuotaOnce, readQuotaPointerEvidence, assertQuotaPointerEvidence };
