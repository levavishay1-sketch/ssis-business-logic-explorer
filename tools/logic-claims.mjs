#!/usr/bin/env node
// Splits a package's business-logic analysis (analysis/<pkg>/logic.json) into verifiable claims with STABLE ids.
// Every text unit shown in the explorer belongs to exactly one claim. Units inside a claim are numbered [n] so a
// verifier can point at the exact sentence that is wrong.
// Usage:
//   node tools/logic-claims.mjs <pkg>                 print all claims
//   node tools/logic-claims.mjs <pkg> --part k/n      print only part k of n (components split evenly by size; package-level claims in part 1)
//   node tools/logic-claims.mjs <pkg> --ids           print only the claim ids (one per line)
//   node tools/logic-claims.mjs <pkg> --open          print only claims that are not verified now (re-check after fixes)
// Each claim carries hash = sha1 of its units; a verdict counts only while the hash still matches (text unchanged since verification).
// Library: import { logicClaims } from './logic-claims.mjs'  → [{ id, section, refId, units: [text], evidence: [..] }]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';
export const claimHash = (units) => crypto.createHash('sha1').update(units.join(String.fromCharCode(10)), 'utf8').digest('hex').slice(0, 12);

const S = (x) => (x == null ? '' : typeof x === 'string' ? x : JSON.stringify(x));
function walkNodes(nodes, depth, out) {
  (nodes || []).forEach((z) => {
    const pad = '  '.repeat(depth);
    out.push(`${pad}(${z.type || 'node'}) ${S(z.text)}${z.tech ? '  ⟨tech: ' + S(z.tech) + '⟩' : ''}`);
    (z.branches || []).forEach((b) => { out.push(`${pad}  ↳ branch "${S(b.label)}":`); walkNodes(b.nodes || b.then || [], depth + 2, out); });
  });
  return out;
}

// Stable key of each component: refId, with " #n" appended only when a refId repeats. Used in claim ids and by the explorer.
export function componentKeys(L) {
  const seen = new Map();
  return (L.components || []).map((c, i) => { const r = S(c.refId) || `component#${i + 1}`; const n = (seen.get(r) || 0) + 1; seen.set(r, n); return n > 1 ? `${r} #${n}` : r; });
}

export function logicClaims(L) {
  const claims = [];
  const add = (id, section, refId, units, evidence) => { if (units.length) claims.push({ id, section, refId, units, evidence: evidence || [], hash: claimHash(units) }); };
  // package level
  add('L|summary', 'summary', null, [
    ...(L.summary_he ? ['summary_he: ' + S(L.summary_he)] : []),
    ...(L.scopeNote_he ? ['scopeNote_he: ' + S(L.scopeNote_he)] : []),
    ...[].concat(L.executionNotes_he || []).map((x) => 'executionNotes_he: ' + S(x)),
    ...[].concat(L.sideOutputs_he || []).map((x) => 'sideOutputs_he: ' + S(x)),
  ]);
  add('L|exec', 'executionOrder', null, (L.executionOrder || []).map((e) => `step ${e.step}: ${S(e.refId)} — "${S(e.title_he)}" — trigger: ${S(e.trigger)}${e.disabled ? ' (disabled)' : ''}`));
  add('L|ignored', 'ignoredAsFramework', null, (L.ignoredAsFramework || []).map(S));
  (L.findings_he || []).forEach((f, k) => add(`L|finding#${k + 1}`, 'finding', null, [`[${S(f.severity)}] ${S(f.text)}`], [].concat(f.evidence || []).map(S)));
  // components
  const keys = componentKeys(L);
  (L.components || []).forEach((c, i) => {
    const r = keys[i];
    const ev = [].concat(c.evidence || []).map(S);
    add(`L|${r}|title`, 'title', r, [
      'title_he: ' + S(c.title_he), ...(c.short_he ? ['short_he: ' + S(c.short_he)] : []),
      ...(c.disabled ? ['disabled: ' + S(c.disabled)] : []),
      ...(c.flow_he || []).map((x, j) => `flow_he[${j + 1}]: ${S(x)}`),
    ], ev);
    add(`L|${r}|short`, 'short', r, walkNodes((c.short || {}).nodes, 0, []), ev);
    add(`L|${r}|detailed`, 'detailed', r, walkNodes((c.detailed || {}).nodes, 0, []), ev);
    add(`L|${r}|detail`, 'detail', r, [
      ...(c.detail_he || []).map((x) => (x && x.h ? `${S(x.h)}: ${S(x.t)}` : S(x))),
      ...(c.sourceFeed ? ['sourceFeed: ' + S(c.sourceFeed)] : []),
      ...(c.sourceTables ? ['sourceTables: ' + S(c.sourceTables)] : []),
    ], ev);
    add(`L|${r}|decisions`, 'decisions', r, (c.decisions || []).map((d) => (typeof d === 'string' ? d : Object.entries(d).map(([k, v]) => `${k}: ${S(v)}`).join(' | '))), ev);
    add(`L|${r}|crm`, 'crmEffects', r, (c.crmEffects || []).map((d) => Object.entries(d).map(([k, v]) => `${k}: ${S(v)}`).join(' | ')), ev);
    add(`L|${r}|open`, 'openQuestions', r, [
      ...(c.openQuestions_he || []).map((x) => 'open question: ' + S(x)),
      ...(c.hypotheses_he || []).map((x) => 'hypothesis (labelled השערה): ' + S(x)),
    ], ev);
  });
  return claims;
}

export function readLogic(pkg) {
  const f = path.join('analysis', pkg, 'logic.json');
  return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null;
}

function splitParts(claims, n) {
  // package-level claims → part 1; components distributed greedily by text size, keeping a component's claims together
  const pkgLevel = claims.filter((c) => !c.refId), byComp = new Map();
  claims.filter((c) => c.refId).forEach((c) => { const a = byComp.get(c.refId) || []; a.push(c); byComp.set(c.refId, a); });
  const size = (a) => a.reduce((s, c) => s + c.units.join('\n').length, 0);
  const parts = Array.from({ length: n }, () => ({ claims: [], size: 0 }));
  parts[0].claims.push(...pkgLevel); parts[0].size += size(pkgLevel);
  [...byComp.values()].sort((a, b) => size(b) - size(a)).forEach((a) => { const p = parts.reduce((m, x) => (x.size < m.size ? x : m)); p.claims.push(...a); p.size += size(a); });
  return parts.map((p) => p.claims);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const pkg = process.argv[2]; if (!pkg) { console.error('usage: logic-claims.mjs <pkg> [--part k/n] [--ids]'); process.exit(2); }
  const L = readLogic(pkg); if (!L) { console.error('no logic.json for ' + pkg); process.exit(1); }
  let claims = logicClaims(L);
  const pi = process.argv.indexOf('--part');
  if (pi > 0) { const [k, n] = process.argv[pi + 1].split('/').map(Number); claims = splitParts(claims, n)[k - 1]; }
  // --open: only claims that are not verified now (not checked / stale / wrong / incomplete / unverifiable) — for re-checks after fixes
  if (process.argv.includes('--open')) {
    // same rule as tools/logic-audit.mjs (kept inline: importing it here would be circular)
    const dir = path.join('analysis', pkg), latest = new Map();
    fs.readdirSync(dir).filter((x) => /^verify-L[A-Za-z0-9]*\.json$/.test(x)).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
      .forEach((x) => (JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8')).results || []).forEach((r) => latest.set(r.id, r)));
    claims = claims.filter((c) => { const r = latest.get(c.id); return !(r && r.hash === c.hash && ['CONFIRMED', 'FIXED'].includes(r.verdict)); });
  }
  if (process.argv.includes('--ids')) { claims.forEach((c) => console.log(c.id)); process.exit(0); }
  console.log(`# Logic claims for ${pkg}  (source: ${L.source && L.source.file}  sha256 ${L.source && L.source.sha256})`);
  console.log(`# ${claims.length} claims. Write exactly one result per claim: id copied verbatim from the "### CLAIM" line, hash copied from the "hash:" line.\n`);
  claims.forEach((c) => {
    console.log(`### CLAIM ${c.id}`);
    console.log(`hash: ${c.hash}`);
    c.units.forEach((u, j) => console.log(`[${j + 1}] ${u}`));
    if (c.evidence.length) console.log(`analyst evidence pointers (do not trust, re-derive): ${c.evidence.join(' ; ')}`);
    console.log('');
  });
}
