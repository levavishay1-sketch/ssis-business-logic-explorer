#!/usr/bin/env node
// Compact structural survey of an evidence JSON (control flow, data flows, SQL, write candidates).
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const short = (r) => (r || '').replace(/^Package\\/, '');
const L = (...a) => console.log(...a);
L('# ' + j.source.file + ' · ' + j.source.sha256);
L('\n## Connection managers');
j.connectionManagers.forEach((c) => L('-', c.refId.replace('Package.ConnectionManagers', ''), c.creationName, (c.connectionString || '').replace(/Provider=[^;]*;|Auto Translate=[^;]*;|Application Name=[^;]*;?/g, '').slice(0, 110), c.propertyExpressions.length ? 'EXPR ' + c.propertyExpressions.map((p) => p.property + '=' + p.expression).join(' ') : '', c.flatFile ? `FLAT ${c.flatFile.format} cp${c.flatFile.codePage} cols=${c.flatFile.columns.length}` : ''));
L('\n## Executables (disabled marked !)');
j.executables.forEach((e) => L('-', e.disabled ? '!' : ' ', short(e.refId), '|', e.type, e.foreach ? '| FOREACH ' + e.foreach.enumerator + ' ' + JSON.stringify(e.foreach.variableMappings.map((m) => m.variable + '#' + m.valueIndex)) : '', e.sql ? '| SQL: ' + e.sql.replace(/\s+/g, ' ').slice(0, 160) : ''));
L('\n## Precedence');
j.precedenceConstraints.forEach((p) => L('-', short(p.from), '->', short(p.to), '|', p.value, p.evalOp, p.expression || '', p.logicalAnd ? '' : 'OR', p.disabled ? 'DISABLED' : ''));
j.dataFlows.forEach((d) => {
  L('\n## DataFlow ' + short(d.task));
  d.components.forEach((c) => L('  -', c.name, '|', c.classId.replace('Microsoft.', ''), c.userComponentTypeName ? '(' + c.userComponentTypeName.split(',')[0] + ')' : '', '| conn', c.connections.map((x) => (x.connectionManagerRefId || '').replace('Package.ConnectionManagers', '')).join(','), c.properties.OpenRowset && c.properties.OpenRowset.value ? '| table ' + c.properties.OpenRowset.value : '', '| in', c.inputs.reduce((a, i) => a + i.inputColumns.length, 0), 'out', c.outputs.filter((o) => !o.isErrorOut).reduce((a, o) => a + o.outputColumns.length, 0)));
  d.paths.forEach((p) => L('     path', p.startId.split('\\').pop(), '=>', p.endId.split('\\').pop()));
});
L('\n## SQL statements');
j.sqlStatements.forEach((s) => L('-', short(s.owner), '|', s.kind, '|', (s.connection || '').replace(/Package.ConnectionManagers/g, ''), '\n   ', (s.text || '').replace(/\s+/g, ' ').slice(0, 400)));
L('\n## Code write candidates (per owner)');
const by = {}; j.candidates.code.forEach((c) => { const k = short(c.owner); (by[k] = by[k] || {}); by[k][c.pattern] = (by[k][c.pattern] || 0) + 1; });
Object.entries(by).forEach(([k, v]) => L('-', k, JSON.stringify(v)));
L('\n## External refs (non-framework)', [...new Set(j.externalReferences.filter((r) => !r.framework).map((r) => r.assembly))].join(', '));
