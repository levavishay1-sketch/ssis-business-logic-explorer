#!/usr/bin/env node
// Build the standalone explorer HTML from evidence + analysis (no network, data embedded).
// Usage: node tools/build-html.mjs <out.html> <pkg> [<pkg> ...]
import { matchVerdicts } from './claimid.mjs';
import { logicVerdicts } from './logic-audit.mjs';
import { componentKeys } from './logic-claims.mjs';
import fs from 'node:fs';
import path from 'node:path';
const [, , outFile, ...pkgs] = process.argv;
const readJ = (f) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null);
const packages = pkgs.map((pkg) => {
  const ev = readJ(`evidence/${pkg}.json`); const logic = readJ(`analysis/${pkg}/logic.json`); const fm = readJ(`analysis/${pkg}/fieldmap.json`); const verFiles = fs.existsSync('analysis/' + pkg) ? fs.readdirSync('analysis/' + pkg).filter((x) => /^verify-.*\.json$/.test(x)) : [];
  const verdicts = {}; const vstats = { CONFIRMED: 0, WRONG: 0, INCOMPLETE: 0, UNVERIFIABLE: 0, FIXED: 0 };
  verFiles.forEach((vf) => { const v = readJ('analysis/' + pkg + '/' + vf); (v.results || []).forEach((r) => { verdicts[r.id] = r; if (r.verdict in vstats) vstats[r.verdict]++; }); });
  let unmatchedVerdicts = [];
  if (fm) { const allRes = verFiles.flatMap((vf) => readJ('analysis/' + pkg + '/' + vf).results || []); const m = matchVerdicts(fm.targets, allRes); unmatchedVerdicts = m.unmatched.filter((u) => u.why !== 'not an attribute claim id'); fm.targets.forEach((t, i) => { t.claimId = m.ids[i]; const a = m.attached[i]; t.verify = a ? { verdict: a.r.verdict, detail: a.r.detail || '', evidence: a.r.evidence || '', matchedBy: a.how } : null; }); if (unmatchedVerdicts.length) console.error(pkg + ': ' + unmatchedVerdicts.length + ' verifier results not tied to a single target (left unattached)'); }
  // business-logic claims: state per claim id (verified only when CONFIRMED/FIXED and the hash equals the current text)
  let logicVer = null;
  if (logic) {
    componentKeys(logic).forEach((k, i) => { logic.components[i].lkey = k; });
    logicVer = {}; logicVerdicts(pkg).claims.forEach((c) => { logicVer[c.id] = c.state === 'verified' ? 1 : { s: c.state, d: c.detail || '' }; });
  }
  let ver = null;
  if (verFiles.length) {
    const fs2 = {}; let none = 0; (fm ? fm.targets : []).forEach((t) => { if (t.verify) fs2[t.verify.verdict] = (fs2[t.verify.verdict] || 0) + 1; else none++; });
    const other = {}; verFiles.forEach((vf) => (readJ('analysis/' + pkg + '/' + vf).results || []).forEach((r) => { if (String(r.id || '').split('|').length !== 4) other[r.verdict] = (other[r.verdict] || 0) + 1; }));
    const fmt = (o) => Object.entries(o).filter(([, n]) => n).map(([k, n]) => k + ' ' + n).join(' · ');
    ver = { summary_he: 'בדיקה עצמאית בוצעה (' + verFiles.join(', ') + '). שדות CRM: ' + (fmt(fs2) || '—') + (none ? ' · טרם נבדק ' + none : '') + (Object.keys(other).length ? ' | בדיקות נוספות (שדות קובץ / כותבים חסרים): ' + fmt(other) : ''), fields: fs2, unchecked: none };
  }
  const flatUsed = new Set(ev.dataFlows.flatMap((d) => d.components.filter((c) => /FlatFileSource/.test(c.classId)).map((c) => (c.connections[0] || {}).connectionManagerRefId)));
  const inputs = ev.connectionManagers.filter((c) => c.flatFile && flatUsed.has(c.refId)).map((c) => ({ type: 'Flat File (' + c.flatFile.format + ')', connection: c.name, format: c.flatFile.format + ' · CodePage ' + c.flatFile.codePage, fields: c.flatFile.columns.length }));
  const externals = [...new Set(ev.externalReferences.filter((r) => !r.framework).map((r) => r.assembly))].concat(ev.configurations.map((c) => c.configurationString)).filter(Boolean);
  // keep the payload lean: chains are needed, raw code is not
  return {
    id: pkg.toLowerCase().replace(/\s+/g, '-'), name: ev.package.objectName, file: ev.source.file, relativePath: 'DailyProcess/' + ev.source.file, folder: 'DailyProcess', domain: null,
    sha256: ev.source.sha256, bytes: ev.source.bytes, scope: 'חבילה זו בלבד. לא סופקו: ' + externals.join(', ') + ', Metadata של CRM, הגדרות Views/Procedures.',
    method: 'חילוץ דטרמיניסטי (tools/dtsx-extract.mjs, coverage ' + (ev.coverage.allMatch ? 'מלא' : 'חלקי!') + ') → גרף שושלת (tools/lineage.mjs) → סוכני מומחה (לוגיקה, מיפוי שדות) → הרכבה (tools/compose.mjs)' + (ver ? ' → בדיקה עצמאית' : ''),
    summary: (logic && logic.summary_he) || '', logic, logicVer, fieldmap: fm, inputs, externals,
    verification: ver ? ver.summary_he : 'טרם בוצעה בדיקה עצמאית למיפוי',
    reviewStatus: 'אימות טכני בלבד — כל הממצאים והמיפויים ממתינים לאישור המשתמש.',
  };
});
// Two packages can carry the same internal DTS:ObjectName (e.g. 0030 "...Test" file is named PoaAccountUpdateDaily inside).
// Only for such collisions, append the file name so the sidebar and search can tell them apart; nothing else changes.
{ const cnt = {}; packages.forEach((p) => { cnt[p.name] = (cnt[p.name] || 0) + 1; });
  packages.forEach((p) => { if (cnt[p.name] > 1) { p.internalName = p.name; p.name = p.name + ' (' + p.file.replace(/\.dtsx$/i, '') + ')'; } }); }
const DATA = { version:'SSIGOLD · DailyProcess · build ' + new Date().toISOString().slice(0, 10), generatedAt: new Date().toISOString().replace('T', ' ').slice(0, 16), packages };
const tpl = fs.readFileSync('tools/template.html', 'utf8');
const json = JSON.stringify(DATA).replace(/</g, '\\u003c');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
const theme = fs.readFileSync('tools/theme.css', 'utf8');
fs.writeFileSync(outFile, tpl.replace('__THEME__', () => theme).replace('__DATA__', () => json));
console.log('wrote', outFile, (fs.statSync(outFile).size / 1024 / 1024).toFixed(2) + ' MB', packages.map((p) => p.name + ': logic=' + !!p.logic + ' fieldmap=' + !!p.fieldmap).join(' | '));
