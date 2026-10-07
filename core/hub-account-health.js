'use strict';
// One answer per web account: is it fine, does it need the person, or nobody knows yet.
//
// Proof that the login works: a background check that saw the account signed in, or a tool
// (生图 / 圆桌 / 中转) that finished a job on it. Proof of trouble: a check that saw it signed
// out, a tool that hit a login wall or a human-verification wall, or a site the web tools
// paused after a challenge. Whichever is newer wins. Opening the page is shown as use and
// moves "上次同步", but it proves nothing about the login, so it never clears trouble.
// A site that was never seen signed in and only a check found it signed out is just "not
// signed in" — the person may simply not use it; that is no reason to raise the badge.
const TOOL_LABEL = { images: '生图', roundtable: '网页圆桌', bridge: '中转' };

function accountHealth({ site = {}, activity, paused, now = Date.now() } = {}) {
  const proofs = [], problems = [];
  if (site.checkedAt && site.verified !== false && site.reason !== 'headless_challenge') {
    if (site.state === 'signed_in') proofs.push({ at: site.checkedAt, by: 'check' });
    else if (site.state === 'signed_out') problems.push({ at: site.checkedAt, by: 'check', kind: 'signed_out' });
  }
  // An earlier check that saw it signed in: kept when a later check overwrote the result.
  if (site.lastSignedInAt && site.lastSignedInAt !== site.checkedAt) proofs.push({ at: site.lastSignedInAt, by: 'check' });
  for (const [source, step] of Object.entries(activity?.sources || {})) {
    if (!TOOL_LABEL[source]) continue;
    if (step.lastSuccessAt) proofs.push({ at: step.lastSuccessAt, by: source });
    if (step.outcome === 'login_required') problems.push({ at: step.at, by: source, kind: 'signed_out' });
    else if (step.outcome === 'verification_required') problems.push({ at: step.at, by: source, kind: 'verification' });
  }
  if (paused && paused.until > now) problems.push({ at: paused.at || paused.since || now, by: 'paused', kind: 'verification', until: paused.until });
  const latest = list => list.reduce((a, b) => (b.at > (a?.at || 0) ? b : a), null);
  const proof = latest(proofs), problem = latest(problems);
  const openedAt = activity?.openedAt || 0;
  const synced = [proof, openedAt ? { at: openedAt, by: 'opened' } : null].reduce((a, b) => (b && b.at > (a?.at || 0) ? b : a), null);
  const base = { syncedAt: synced?.at || 0, syncedBy: synced?.by || '', proofAt: proof?.at || 0, proofBy: proof?.by || '' };
  if (problem && problem.at > (proof?.at || 0)) {
    if (!proof && problem.by === 'check') return { ...base, state: 'off', problem };
    return { ...base, state: 'attention', problem };
  }
  return { ...base, state: proof ? 'ok' : 'unknown' };
}
module.exports = { accountHealth, TOOL_LABEL };
