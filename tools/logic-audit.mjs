#!/usr/bin/env node
// Audit of the business-logic descriptions: every claim produced by tools/logic-claims.mjs must carry an independent
// verdict (analysis/<pkg>/verify-L*.json) that is CONFIRMED or FIXED AND whose hash equals the claim's current hash
// (i.e. the text shown is exactly the text that was verified). Later verify files override earlier ones for the same id
// (files are read in name order: verify-L.json, verify-L1.json, verify-L2.json, verify-LR*.json for re-checks).
// Usage: node tools/logic-audit.mjs [out.json] [pkgFilter]
import fs from 'node:fs';
import path from 'node:path';
import { logicClaims, readLogic } from './logic-claims.mjs';

export function logicVerdicts(pkg) {
  const dir = path.join('analysis', pkg); const L = readLogic(pkg); if (!L) return null;
  const claims = logicClaims(L);
  // natural order, so verify-LR10 counts after verify-LR9 (the latest round wins)
  const files = fs.readdirSync(dir).filter((x) => /^verify-L[A-Za-z0-9]*\.json$/.test(x)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  const latest = new Map(); const foreign = [];
  files.forEach((x) => (JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8')).results || []).forEach((r) => { latest.set(r.id, { ...r, _file: x }); }));
  const ids = new Set(claims.map((c) => c.id));
  latest.forEach((r, id) => { if (!ids.has(id)) foreign.push(id); });
  const rows = claims.map((c) => {
    const r = latest.get(c.id);
    const state = !r ? 'not_checked' : r.hash !== c.hash ? 'stale' : ['CONFIRMED', 'FIXED'].includes(r.verdict) ? 'verified' : String(r.verdict || '?').toLowerCase();
    return { id: c.id, section: c.section, refId: c.refId, hash: c.hash, state, verdict: r && r.verdict, detail: r && r.detail, wrongUnits: r && r.wrongUnits, file: r && r._file };
  });
  return { claims: rows, foreign };
}

if (process.argv[1] && path.resolve(process.argv[1]).endsWith('logic-audit.mjs')) {
  const out = process.argv[2], filt = process.argv[3];
  const tot = { packages: 0, claims: 0, verified: 0, not_checked: 0, stale: 0, wrong: 0, incomplete: 0, unverifiable: 0, other: 0, foreignIds: 0 };
  const pk = [];
  for (const d of fs.readdirSync('analysis').sort()) {
    if (!fs.statSync(path.join('analysis', d)).isDirectory() || (filt && !d.startsWith(filt))) continue;
    const v = logicVerdicts(d); if (!v) continue; tot.packages++;
    const c = {}; v.claims.forEach((x) => { c[x.state] = (c[x.state] || 0) + 1; });
    tot.claims += v.claims.length; tot.foreignIds += v.foreign.length;
    Object.entries(c).forEach(([k, n]) => { if (k in tot) tot[k] += n; else tot.other += n; });
    pk.push({ package: d, claims: v.claims.length, ...c, foreign: v.foreign, open: v.claims.filter((x) => x.state !== 'verified').map((x) => ({ id: x.id, state: x.state, detail: x.detail, wrongUnits: x.wrongUnits })) });
    console.log(`${d.padEnd(38)} claims=${String(v.claims.length).padStart(3)} verified=${String(c.verified || 0).padStart(3)}` + Object.entries(c).filter(([k]) => k !== 'verified').map(([k, n]) => ` ${k}=${n}`).join('') + (v.foreign.length ? ` foreignIds=${v.foreign.length}` : ''));
  }
  console.log('TOTAL ' + JSON.stringify(tot));
  if (out) fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), totals: tot, packages: pk }, null, 1));
}
