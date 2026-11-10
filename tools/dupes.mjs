#!/usr/bin/env node
// Groups script components / OLE DB commands whose user code or SQL is byte-identical (after
// whitespace normalisation), within the same data flow. Proves "copy N is identical to copy 1"
// so analysts can analyse one representative. Also reports input-column-list equality.
// Usage: node tools/dupes.mjs evidence/<pkg>.json [out.json]
import fs from 'node:fs';
import crypto from 'node:crypto';
const [, , ev, outFile] = process.argv;
const j = JSON.parse(fs.readFileSync(ev, 'utf8'));
const h = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);
const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
const groups = {};
j.dataFlows.forEach((d) => d.components.forEach((c) => {
  let sig = null, kind = null;
  if (/ManagedComponentHost/.test(c.classId)) { kind = 'script'; sig = j.codeFiles.filter((f) => f.owner === c.refId && f.isSource).sort((a, b) => a.name.localeCompare(b.name)).map((f) => f.name + ':' + norm(f.text)).join('|'); }
  else if (/OLEDBCommand/.test(c.classId)) { kind = 'sql'; sig = norm((c.properties.SqlCommand || {}).value); }
  else return;
  const inSig = c.inputs.map((i) => i.inputColumns.map((x) => x.cachedName + ':' + (x.usageType || 'r')).join(',')).join(';');
  const outSig = c.outputs.map((o) => o.name + '(' + o.outputColumns.map((x) => x.name).join(',') + ')').join(';');
  const key = d.task + '|' + kind + '|' + h(sig) + '|' + h(inSig) + '|' + h(outSig);
  (groups[key] = groups[key] || []).push(c.refId);
}));
const res = Object.entries(groups).filter(([, v]) => v.length > 1).map(([k, v]) => ({ dataFlow: k.split('|')[0], kind: k.split('|')[1], codeHash: k.split('|')[2], representative: v[0], identicalCopies: v.slice(1), proof: 'normalised user source / SQL, input column list and output column list are identical' }));
if (outFile) fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
res.forEach((g) => console.log(`${g.kind} ×${g.identicalCopies.length + 1}  ${g.representative.split('\\').slice(-2).join('/')}  ≡ ${g.identicalCopies.map((x) => x.split('\\').pop()).join(', ')}`));
// near-duplicates by name pattern that are NOT identical (must be analysed separately)
const byBase = {}; j.dataFlows.forEach((d) => d.components.forEach((c) => { const b = d.task + '|' + c.name.replace(/\s*\d+$/, ''); (byBase[b] = byBase[b] || []).push(c.refId); }));
const ident = new Set(res.flatMap((g) => [g.representative, ...g.identicalCopies]));
Object.values(byBase).filter((v) => v.length > 1 && v.some((x) => !ident.has(x)) && v.some((x) => /ManagedComponentHost|OLEDBCommand/.test((j.dataFlows.flatMap((d) => d.components).find((c) => c.refId === x) || {}).classId))).forEach((v) => console.log('NOT-IDENTICAL siblings:', v.map((x) => x.split('\\').slice(-2).join('/')).join(' | ')));
