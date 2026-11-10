#!/usr/bin/env node
// List the composed mapping claims (from analysis/<pkg>/fieldmap.json) that came from one analyst file,
// each with a stable claim id, its file-field sources (value / influence) and the full chain of steps.
// Usage: node tools/claims.mjs <pkg> <mapping-X.json> [--fields]   (--fields: list file fields whose disposition needs checking)
import fs from 'node:fs';
import { claimIds } from './claimid.mjs';
const [, , pkg, file, flag] = process.argv;
const F = JSON.parse(fs.readFileSync(`analysis/${pkg}/fieldmap.json`, 'utf8'));
const tail = (s) => (s || '').split('\\').pop();
// steps are stored as indices into F.stepDict (compact form); decode back to objects
const D = F.stepDict || [];
const dec = (st) => (st || []).map((x) => (typeof x === 'number' ? D[x] : x));
F.targets.forEach((t) => ['valueSources', 'influenceSources', 'openSources', 'nonFile', 'dbSources'].forEach((k) => (t[k] || []).forEach((x) => { x.steps = dec(x.steps); })));
if (flag === '--fields') {
  F.sources.filter((s) => ['writer_input_unmapped', 'logic_only_no_crm', 'crm_influence_only', 'crm_row_filter'].includes(s.disposition)).forEach((s) => console.log(`FIELD ${s.field} #${s.ordinal} ${s.disposition} uses=${JSON.stringify(s.uses)} crm=${JSON.stringify([...new Set(s.crm.map((c) => c.role + ':' + c.entity + '.' + c.attribute))])} rowFilterOf=${JSON.stringify([...new Set((s.rowFilterOf || []).map((r) => r.verb + ' ' + r.entity + ' via ' + tail(r.via)))])}`));
  process.exit(0);
}
const IDS = claimIds(F.targets);
F.targets.forEach((t, i) => { t._id = IDS[i]; });
F.targets.filter((t) => t.analystFile === file).forEach((t) => {
  const id = t._id;
  console.log(`\n### CLAIM ${id}`);
  console.log(`mechanism=${t.mechanism} status=${t.status} fixedValue=${t.fixedValue ?? ''} evidence=${t.evidence || ''}`);
  if (t.expression) console.log(`writer expression: ${t.expression}`);
  if (t.writeCondition) console.log(`write condition (whole writer): ${t.writeCondition}`);
  if (t.attrCondition) console.log(`attribute condition: ${t.attrCondition}`);
  console.log(`VALUE from file: ${[...new Set(t.valueSources.map((s) => s.field))].join(', ') || '—'}`);
  console.log(`INFLUENCE from file: ${[...new Set(t.influenceSources.map((s) => s.field))].join(', ') || '—'}`);
  if ((t.dbSources || []).length) console.log('DB sources: ' + [...new Set(t.dbSources.map((x) => (x.role === 'value' ? 'VALUE ' : 'INFL ') + x.db))].join(', '));
  if (t.nonFile.length) console.log('NON-FILE origin: ' + t.nonFile.map((s) => (s.steps[0] || {}).text).join(' | '));
  const seen = new Set();
  [...t.valueSources.map((s) => ['V', s]), ...t.influenceSources.map((s) => ['I', s]), ...(t.dbSources || []).map((s) => [s.role === 'value' ? 'V-DB' : 'I-DB', { ...s, field: s.db }])].forEach(([r, s]) => {
    const key = r + s.field + s.steps.map((x) => x.text).join('>'); if (seen.has(key)) return; seen.add(key);
    console.log(`  chain[${r}] ${s.field}: ` + s.steps.map((x) => x.text.replace(/\s+/g, ' ').slice(0, 140)).join('  →  '));
  });
});
