#!/usr/bin/env node
// For every non-CONFIRMED verifier result, show what the CURRENT composed fieldmap says,
// so tool fixes can be separated from analyst fixes. Usage: node tools/recheck.mjs <pkg>
import fs from 'node:fs';
const pkg = process.argv[2];
const F = JSON.parse(fs.readFileSync(`analysis/${pkg}/fieldmap.json`, 'utf8'));
const tail = (s) => (s || '').split('\\').pop();
const byId = {};
F.targets.forEach((t) => { const id = `${tail(t.component)}|${t.entity}|${t.verb}|${t.attribute}`; (byId[id] = byId[id] || []).push(t); });
fs.readdirSync(`analysis/${pkg}`).filter((f) => /^verify-.*\.json$/.test(f)).forEach((vf) => {
  const v = JSON.parse(fs.readFileSync(`analysis/${pkg}/${vf}`, 'utf8'));
  console.log(`\n=== ${vf}: ${(v.results || []).length} results`);
  (v.results || []).filter((r) => r.verdict !== 'CONFIRMED').forEach((r) => {
    const ts = byId[r.id] || [];
    const now = ts.map((t) => `VALUE[${[...new Set(t.valueSources.map((s) => s.field))].join(',')}] INFL[${[...new Set(t.influenceSources.map((s) => s.field))].join(',')}] ROWFILTER[${[...new Set((t.rowFilters || []).flatMap((x) => x.fileFields))].join(',')}]`).join(' || ');
    console.log(`- ${r.verdict} ${r.id}\n    verifier: ${String(r.detail).replace(/\s+/g, ' ').slice(0, 260)}\n    now: ${now || '(id not found — field/logic item)'}`);
  });
});
