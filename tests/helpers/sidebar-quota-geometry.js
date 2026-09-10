'use strict';

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
        return { width: r.width, height: r.height, hit: e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)) };
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
    return {quota, providers, overlaps, overflow};
  })()`);
}
module.exports = { measureQuota };
