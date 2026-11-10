#!/usr/bin/env node
// Audit of the single file→CRM relation ("the file field's value enters this CRM field") for every package.
// Checks, per package that reads a file:
//  1. both directions agree: pairs seen from the file side (sources[].crm, role value) == pairs seen from the CRM side (targets[].valueSources)
//  2. every pair is carried only by CRM-field claims that the independent verifier CONFIRMED or FIXED (matched exactly, tools/claimid.mjs)
//  3. disposition consistency: "crm_value" ⇔ at least one pair
//  4. nothing left open: no target with unresolved sources, no verifier "missingWrites" left
// Usage: node tools/mapping-audit.mjs [out.json]
import fs from 'node:fs';
import path from 'node:path';
import { matchVerdicts } from './claimid.mjs';
const OK = new Set(['CONFIRMED', 'FIXED']);
const rows = []; const tot = { packages: 0, filePackages: 0, fields: 0, enteringFields: 0, pairs: 0, pairsVerified: 0, problems: 0 };
for (const d of fs.readdirSync('analysis').sort()) {
  const dir = path.join('analysis', d); if (!fs.statSync(dir).isDirectory()) continue;
  const fmF = path.join(dir, 'fieldmap.json'); if (!fs.existsSync(fmF)) continue;
  tot.packages++;
  const fm = JSON.parse(fs.readFileSync(fmF, 'utf8'));
  const vfiles = fs.readdirSync(dir).filter((x) => /^verify-.*\.json$/.test(x));
  const vdocs = vfiles.map((x) => JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8')));
  const res = vdocs.flatMap((v) => v.results || []);
  const m = matchVerdicts(fm.targets, res);
  const problems = [];
  // CRM side
  const fromT = new Map(); // pairKey -> [target indexes]
  fm.targets.forEach((t, i) => {
    if ((t.openSources || []).length) problems.push(`open source in ${t.entity}.${t.attribute} (${t.component})`);
    t.valueSources.forEach((s) => { const k = (s.conn || '?') + '::' + s.field + ' → ' + t.entity + '.' + t.attribute; const a = fromT.get(k) || []; if (!a.includes(i)) a.push(i); fromT.set(k, a); });
  });
  // file side
  const fromS = new Set(); let entering = 0;
  fm.sources.forEach((s) => {
    const v = (s.crm || []).filter((c) => c.role === 'value'); if (v.length) entering++;
    if ((s.disposition === 'crm_value') !== (v.length > 0)) problems.push(`disposition ${s.disposition} but ${v.length} value links: ${s.field}`);
    v.forEach((c) => fromS.add((s.connection || '?') + '::' + s.field + ' → ' + c.entity + '.' + c.attribute));
  });
  const onlyT = [...fromT.keys()].filter((k) => !fromS.has(k)), onlyS = [...fromS].filter((k) => !fromT.has(k));
  onlyT.forEach((k) => problems.push('pair only on CRM side: ' + k)); onlyS.forEach((k) => problems.push('pair only on file side: ' + k));
  // verification of each pair
  let ver = 0; const unver = [];
  fromT.forEach((idx, k) => { const bad = idx.filter((i) => !m.attached[i] || !OK.has(m.attached[i].r.verdict)); if (bad.length) unver.push(k + ' [' + bad.map((i) => m.attached[i] ? m.attached[i].r.verdict : 'not verified').join(',') + ']'); else ver++; });
  unver.forEach((k) => problems.push('pair not verified: ' + k));
  const missing = vdocs.flatMap((v) => v.missingWrites || []);
  // a missingWrite was reported by a verifier; it is closed only if the attribute is now a target of that component
  missing.forEach((w) => { const hit = fm.targets.some((t) => String(t.attribute).toLowerCase() === String(w.attribute || '').toLowerCase() && (!w.component || String(t.component).endsWith(String(w.component).split('\\').pop()))); if (!hit) problems.push(`verifier missingWrite not in mapping: ${w.component} ${w.entity}.${w.attribute}`); });
  const isFile = fm.sources.length > 0; if (isFile) tot.filePackages++;
  tot.fields += fm.sources.length; tot.enteringFields += entering; tot.pairs += fromT.size; tot.pairsVerified += ver; tot.problems += problems.length;
  rows.push({ package: d, readsFile: isFile, fields: fm.sources.length, enteringFields: entering, pairs: fromT.size, pairsVerified: ver, crmFields: new Set(fm.targets.map((t) => t.entity + '.' + t.attribute)).size, crmFieldsFromFile: new Set(fm.targets.filter((t) => t.valueSources.length).map((t) => t.entity + '.' + t.attribute)).size, problems });
}
rows.forEach((r) => console.log(`${r.package.padEnd(36)} file=${r.readsFile ? 'yes' : 'no '} fields=${String(r.fields).padStart(3)} entering=${String(r.enteringFields).padStart(3)} pairs=${String(r.pairs).padStart(3)} verified=${String(r.pairsVerified).padStart(3)} crmFields=${String(r.crmFields).padStart(3)} fromFile=${String(r.crmFieldsFromFile).padStart(3)} problems=${r.problems.length}` + (r.problems.length ? '\n   - ' + r.problems.slice(0, 15).join('\n   - ') + (r.problems.length > 15 ? `\n   … +${r.problems.length - 15}` : '') : '')));
console.log('TOTAL ' + JSON.stringify(tot));
if (process.argv[2]) fs.writeFileSync(process.argv[2], JSON.stringify({ generatedAt: new Date().toISOString(), totals: tot, packages: rows }, null, 1));
