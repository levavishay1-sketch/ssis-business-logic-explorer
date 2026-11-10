#!/usr/bin/env node
// Deterministic preparation for every package in a folder: extract → lineage → dupes → survey,
// then a one-line inventory per package (coverage, file sources, CRM writers) → reports/inventory.json
// Usage: node tools/batch-prep.mjs source/DailyProcess [skip-pkg ...]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
const [, , dir, ...skip] = process.argv;
const run = (args) => execFileSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 1 << 28 });
const inv = [];
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.dtsx')).sort()) {
  const pkg = f.replace(/\.dtsx$/, ''); if (skip.includes(pkg)) continue;
  const row = { pkg };
  try {
    const ex = JSON.parse(run(['tools/dtsx-extract.mjs', path.join(dir, f), `evidence/${pkg}.json`, 'source']));
    row.coverage = ex.coverageAllMatch; row.coverageIssues = ex.checks;
    const lin = JSON.parse(run(['tools/lineage.mjs', `evidence/${pkg}.json`, `lineage/${pkg}.lineage.json`]).replace(/^[^{]*/, ''));
    fs.mkdirSync(`analysis/${pkg}`, { recursive: true });
    run(['tools/dupes.mjs', `evidence/${pkg}.json`, `analysis/${pkg}/dupes.json`]);
    fs.writeFileSync(`reports/survey_${pkg}.txt`, run(['tools/survey.mjs', `evidence/${pkg}.json`]));
    const ev = JSON.parse(fs.readFileSync(`evidence/${pkg}.json`, 'utf8'));
    Object.assign(row, { bytes: ev.source.bytes, executables: ev.executables.length, dataFlows: ev.dataFlows.length, components: ev.dataFlows.reduce((a, d) => a + d.components.length, 0),
      fileFields: lin.fileFields, writeComponents: lin.writeComponents, scriptWrites: lin.scriptWrites, sqlWritesOnCrm: lin.sqlWritesOnCrm, openItems: lin.openItemsOnCrmPaths,
      controlFlowSqlOnCrm: ev.sqlStatements.filter((s) => s.kind === 'ExecuteSQLTask' && /_mscrm/i.test((ev.connectionManagers.find((c) => c.refId === s.connection) || {}).connectionString || '') && /\b(insert|update|delete|merge)\b/i.test(s.text || '')).length });
  } catch (e) { row.error = String(e.message || e).slice(0, 400); }
  inv.push(row); console.log(JSON.stringify(row));
}
fs.writeFileSync('reports/inventory.json', JSON.stringify(inv, null, 1));
