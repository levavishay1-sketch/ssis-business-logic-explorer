#!/usr/bin/env node
// Prints a compact text summary of an evidence JSON (for review; no interpretation).
import fs from 'node:fs';
const j = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const L = (...a) => console.log(...a);
L('PKG', JSON.stringify(j.package)); L('SRC', JSON.stringify(j.source));
L('\nCONNECTION MANAGERS'); j.connectionManagers.forEach((c) => L(' ', c.line, '|', c.refId, '|', c.creationName, '|', c.connectionString, '| expr:', JSON.stringify(c.propertyExpressions.map((p) => p.property + '=' + p.expression))));
L('\nCONFIGURATIONS', JSON.stringify(j.configurations));
L('\nVARIABLES'); j.variables.forEach((v) => L(' ', v.line, '|', v.scope, '|', v.namespace + '::' + v.name, '=', JSON.stringify(v.value).slice(0, 80), v.evaluateAsExpression ? 'EXPR ' + v.expression : ''));
L('\nEXECUTABLES'); j.executables.forEach((e) => L(' ', e.line, '|', e.refId, '|', e.type, '| parent', e.parent, '| ctx', e.context, '| disabled', e.disabled, '| pe', JSON.stringify((e.propertyExpressions || []).map((p) => p.property + '=' + p.expression)), e.script ? JSON.stringify({ ...e.script, binaryItems: e.script.binaryItems.length }) : ''));
L('\nPRECEDENCE'); j.precedenceConstraints.forEach((p) => L(' ', p.line, '|', p.container, '|', p.from, '->', p.to, '|', p.value, p.evalOp, p.expression || '', 'AND=' + p.logicalAnd, p.disabled ? 'DISABLED' : ''));
j.dataFlows.forEach((d) => {
  L('\nDATAFLOW', d.task);
  d.components.forEach((c) => {
    L('  C', c.line, '|', c.name, '|', c.classId, '|', c.userComponentTypeName || '', '| conn', c.connections.map((x) => x.connectionManagerRefId).join(','));
    c.inputs.forEach((i) => L('     IN ', i.name, '::', i.inputColumns.map((x) => x.cachedName + ':' + x.usageType).join(', ')));
    c.outputs.forEach((o) => L('     OUT', o.name + (o.isErrorOut ? ' [ERR]' : '') + (o.exclusionGroup && o.exclusionGroup !== '0' ? ' excl=' + o.exclusionGroup : ''), '::', o.outputColumns.map((x) => x.name + (x.properties.FriendlyExpression ? ' = ' + x.properties.FriendlyExpression.value : '')).join(', ')));
    const interesting = ['AccessMode', 'OpenRowset', 'OpenRowsetVariable', 'SqlCommandVariable', 'NoMatchBehavior', 'CacheType', 'ParameterMap', 'ReadOnlyVariables', 'ReadWriteVariables', 'ReferenceMetadataXml'];
    interesting.forEach((k) => { if (c.properties[k] && c.properties[k].value) L('     P', k, '=', String(c.properties[k].value).slice(0, 400)); });
  });
  d.paths.forEach((p) => L('  PATH', p.startId.split('\\').pop(), '=>', p.endId.split('\\').pop()));
});
L('\nSQL'); j.sqlStatements.forEach((s) => L(' ---', s.owner, '|', s.kind, '|', s.connection, '| line', s.line, '\n', s.text));
L('\nCODE FILES'); j.codeFiles.forEach((f) => L(' ', f.owner, '|', f.kind, '|', f.name, '| lines', f.lines, '| source', f.isSource));
L('\nCANDIDATES (code)'); j.candidates.code.forEach((c) => L(' ', c.owner.split('\\').pop(), '|', c.file, ':' + c.line, '|', c.pattern, '|', c.text));
L('\nCANDIDATES (sql)'); j.candidates.sql.forEach((c) => L(' ', c.owner.split('\\').pop(), '|', c.verb, c.object));
L('\nCOVERAGE', JSON.stringify(j.coverage));
