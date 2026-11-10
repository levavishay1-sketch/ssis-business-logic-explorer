#!/usr/bin/env node
// Print everything an analyst needs about ONE component: class, connections, key properties,
// inputs (with Row.<prop> names), outputs (with buffer prop names), expressions, SQL, and user
// C# source with line numbers (template help regions removed; line numbers are the file's own).
// Usage: node tools/component.mjs evidence/<pkg>.json lineage/<pkg>.lineage.json "<refId suffix>"
//        node tools/component.mjs evidence/<pkg>.json lineage/<pkg>.lineage.json --list "<dataflow suffix>"
import fs from 'node:fs';
const [, , ev, lin, a, b] = process.argv;
const j = JSON.parse(fs.readFileSync(ev, 'utf8'));
const L = JSON.parse(fs.readFileSync(lin, 'utf8'));
const all = j.dataFlows.flatMap((d) => d.components.map((c) => ({ d, c })));
if (a === '--list') {
  const d = j.dataFlows.find((x) => x.task.endsWith(b)); if (!d) { console.log('no such data flow'); process.exit(1); }
  console.log('DATAFLOW ' + d.task);
  d.components.forEach((c) => console.log('  ' + c.name + ' | ' + c.classId.replace('Microsoft.', '') + ' | in ' + c.inputs.reduce((x, i) => x + i.inputColumns.length, 0) + ' | out ' + c.outputs.map((o) => o.name + (o.isErrorOut ? '[err]' : '') + ':' + o.outputColumns.length).join(',')));
  d.paths.forEach((p) => console.log('  PATH ' + p.startId.split('\\').pop() + ' => ' + p.endId.split('\\').pop()));
  process.exit(0);
}
const hit = all.filter(({ c }) => c.refId.endsWith(a));
if (hit.length !== 1) { console.log(hit.length ? 'ambiguous: ' + hit.map((x) => x.c.refId).join(' | ') : 'not found'); process.exit(1); }
const { d, c } = hit[0]; const sp = L.scriptProps[c.refId] || {};
console.log('COMPONENT ' + c.refId + '\nCLASS ' + c.classId + '  (DTSX line ' + c.line + ')  DATAFLOW ' + d.task);
c.connections.forEach((x) => console.log('CONNECTION ' + x.connectionManagerRefId + ' → ' + JSON.stringify(L.connections[x.connectionManagerRefId] ? { server: L.connections[x.connectionManagerRefId].server, catalog: L.connections[x.connectionManagerRefId].catalog } : null)));
['SqlCommand', 'SqlCommandParam', 'OpenRowset', 'AccessMode', 'ParameterMap', 'ParameterMapping', 'NoMatchBehavior', 'CacheType', 'ReadOnlyVariables', 'ReadWriteVariables', 'Keys'].forEach((k) => { const p = c.properties[k]; if (p && p.value !== '' && p.value != null) console.log('PROP ' + k + ' (line ' + p.line + '): ' + p.value); });
c.inputs.forEach((i) => {
  console.log('\nINPUT ' + i.name);
  i.inputColumns.forEach((ic, n) => { const prop = Object.keys(sp.in || {}).find((p) => sp.in[p].lineageId === ic.lineageId && sp.in[p].column === ic.cachedName);
    const ext = ic.externalMetadataColumnId ? (c.inputs.concat(c.outputs).flatMap((x) => x.externalMetadataColumns).find((m) => m.refId === ic.externalMetadataColumnId) || {}).name : null;
    const ex = Object.entries(ic.properties).map(([k, v]) => k + '=' + v.value).join('; ');
    console.log(`  [${n}] ${ic.cachedName}${prop ? '  Row.' + prop : ''}${ic.usageType ? ' (' + ic.usageType + ')' : ''}${ext ? '  → ext:' + ext : ''}${ex ? '  {' + ex.slice(0, 300) + '}' : ''}`); });
});
c.outputs.forEach((o) => {
  console.log('\nOUTPUT ' + o.name + (o.isErrorOut ? ' [ERROR]' : '') + (o.synchronousInputId ? ' [sync]' : ' [async]') + (o.exclusionGroup && o.exclusionGroup !== '0' ? ' excl=' + o.exclusionGroup : ''));
  if (o.properties.FriendlyExpression || o.properties.Expression) console.log('  CONDITION: ' + (o.properties.FriendlyExpression || o.properties.Expression).value);
  o.outputColumns.forEach((oc) => { const prop = Object.entries(sp.syncOut || {}).find(([, v]) => v.lineageId === oc.lineageId) || Object.entries((sp.out || {})[o.name] || {}).find(([, v]) => v.lineageId === oc.lineageId);
    const ex = oc.properties.FriendlyExpression ? '  = ' + oc.properties.FriendlyExpression.value : oc.properties.CopyFromReferenceColumn ? '  ← ref.' + oc.properties.CopyFromReferenceColumn.value : '';
    console.log(`  ${oc.name}${prop ? '  ' + (sp.syncOut && sp.syncOut[prop[0]] ? 'Row.' : o.name.replace(/\s/g, '') + 'Buffer.') + prop[0] : ''} ${oc.dataType || ''}${oc.length && oc.length !== '0' ? '(' + oc.length + ')' : ''}${ex}`); });
});
j.codeFiles.filter((f) => f.owner === c.refId && f.isSource).forEach((f) => {
  console.log('\n===== ' + f.name + ' (sha ' + f.sha256.slice(0, 12) + ') =====');
  let skip = false; f.text.split(/\r?\n/).forEach((l, i) => { if (/#region Help/.test(l)) skip = true; if (!skip && l.trim() && !/^\s*(\/\/\/|\/\*|\*)/.test(l)) console.log(String(i + 1).padStart(4) + ' ' + l); if (skip && /#endregion/.test(l)) skip = false; });
});
