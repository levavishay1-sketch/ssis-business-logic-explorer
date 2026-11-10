#!/usr/bin/env node
// Print the backward origin tree of each input of a write component (from lineage JSON).
// Usage: node tools/origins.mjs lineage/<pkg>.lineage.json "<component name suffix>" [maxDepth]
import fs from 'node:fs';
const [, , file, suffix, md] = process.argv;
const L = JSON.parse(fs.readFileSync(file, 'utf8'));
const maxDepth = Number(md || 12);
const tail = (s) => (s || '').split('\\').slice(-2).join('/');
function show(n, d, pre) {
  if (!n || d > maxDepth) return;
  if (Array.isArray(n)) { n.forEach((x) => show(x, d, pre)); return; }
  const extra = n.kind === 'file-field' ? `FILE[${n.fileColumn} #${n.ordinal} ${n.start}-${n.end}]`
    : n.kind === 'db-column' ? `DB[${n.table}.${n.column}${n.alias && n.alias !== n.column ? ' AS ' + n.alias : ''}]`
    : n.kind === 'derived' || n.kind === 'computed' ? `${n.kind.toUpperCase()}{${(n.expression || '').slice(0, 160)}}`
    : n.kind === 'lookup-return' ? `LOOKUP-RETURN ${n.referenceColumn} via ${tail(n.component)}`
    : n.kind === 'script-output' ? `OPEN script-output ${tail(n.component)}.${n.output}.${n.column}`
    : n.kind === 'union' ? `UNION ${tail(n.component)}` : n.kind;
  const inp = n.inPlace ? ' inPlace:' + n.inPlace.map((m) => tail(m.component) + '(' + m.use + (m.expression ? ': ' + String(m.expression).slice(0, 80) : '') + ')').join(', ') : '';
  console.log(pre + (n.name || '') + ' <- ' + extra + inp);
  if (n.writers) n.writers.forEach((w) => { console.log(pre + '  [bridge writer ' + tail(w.comp) + (w.serverMatch ? '' : ' SERVER MISMATCH ' + w.writerServer + '≠' + w.readerServer) + ']'); show(w.origin, d + 1, pre + '    '); });
  if (n.origin) show(n.origin, d + 1, pre + '  ');
  if (n.keyOrigins) n.keyOrigins.forEach((k) => { console.log(pre + '  [lookup key → ' + k.joinTo + ']'); show(k.origin, d + 1, pre + '    '); });
}
L.writeComponents.filter((w) => w.component.endsWith(suffix)).forEach((w) => {
  console.log(`\n### ${w.component} (${w.kind}${w.crmConnection ? ', CRM conn' : ''})`);
  if (w.sql) console.log('SQL: ' + w.sql.replace(/\s+/g, ' ').slice(0, 3000));
  w.inputs.forEach((i) => { console.log(`\n* input ${i.column}${i.rowProperty ? ' (Row.' + i.rowProperty + ')' : ''}${i.param ? ' [' + i.param + ']' : ''} usage=${i.usageType} files=${JSON.stringify(i.fileFields)}`); show(i.origin, 0, '    '); });
});
