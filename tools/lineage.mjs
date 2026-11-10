#!/usr/bin/env node
// Deterministic column-lineage graph over an evidence JSON.
// Usage: node tools/lineage.mjs evidence/<pkg>.json lineage/<pkg>.lineage.json
// Every edge carries {kind, component, evidence}. Edges the tool cannot prove are emitted as
// "open" items for an analyst (script code, complex SQL) — never guessed.
import fs from 'node:fs';
import path from 'node:path';

const [, , inFile, outFile, resFile] = process.argv;
const j = JSON.parse(fs.readFileSync(inFile, 'utf8'));
// Analyst resolutions (evidence-backed) for hops the tool cannot prove: script output columns.
const RES = { scriptOutputs: [], readWrite: [] };
if (resFile && fs.existsSync(resFile)) { const r = JSON.parse(fs.readFileSync(resFile, 'utf8')); RES.scriptOutputs = r.scriptOutputs || []; RES.readWrite = r.readWrite || []; }
const short = (r) => (r || '').replace(/^Package\\(Foreach Loop Container( \d+)?\\)?/, '');
const tail = (x) => (x || '').split('\\').pop();
const LREF = /#\{([^}]+)\}/g;
const pv = (col, name) => { const p = col.properties && col.properties[name]; return p && typeof p.value === 'string' && p.value.trim() !== '' ? p.value : null; };
// Split an SSIS expression into roles. "c ? a : b": refs in c → condition, refs in a/b → value (recursively).
// A lineage that appears in any value position is 'value'. Pure text scan; strings and parentheses respected.
function topTernary(e) {
  let depth = 0, inStr = false, q = -1;
  for (let i = 0; i < e.length; i++) { const ch = e[i];
    if (inStr) { if (ch === '\\') { i++; continue; } if (ch === '"') inStr = false; continue; }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '(') depth++; else if (ch === ')') depth--;
    else if (depth === 0 && ch === '?' && q < 0) q = i;
    else if (depth === 0 && ch === ':' && q >= 0) { // match nested ternaries inside the true-branch
      let d2 = 0, s2 = false, nest = 0; for (let k = q + 1; k < i; k++) { const c2 = e[k]; if (s2) { if (c2 === '\\') { k++; continue; } if (c2 === '"') s2 = false; continue; } if (c2 === '"') { s2 = true; continue; } if (c2 === '(') d2++; else if (c2 === ')') d2--; else if (d2 === 0 && c2 === '?') nest++; else if (d2 === 0 && c2 === ':') nest--; }
      if (nest === 0) return { cond: e.slice(0, q), a: e.slice(q + 1, i), b: e.slice(i + 1) }; }
  }
  return null;
}
function exprRoles(expr) {
  const out = new Map(); const set = (id, r) => { if (out.get(id) !== 'value') out.set(id, r); };
  (function walk(e, mode) { let t = e.trim(); for (;;) { const m = t.match(/^\(\s*DT_[A-Z0-9_]+(\s*,\s*[^()]*)?\)\s*/); if (m && m[0].length < t.length) t = t.slice(m[0].length).trim(); else break; } while (t.startsWith('(') && t.endsWith(')')) { let d = 0, ok = true; for (let i = 0; i < t.length - 1; i++) { if (t[i] === '(') d++; else if (t[i] === ')') d--; if (d === 0) { ok = false; break; } } if (!ok) break; t = t.slice(1, -1).trim(); }
    const tt = topTernary(t); if (!tt) { refsIn(t).forEach((x) => set(toLineage(x), mode)); return; }
    refsIn(tt.cond).forEach((x) => set(toLineage(x), 'condition')); walk(tt.a, mode); walk(tt.b, mode); })(expr || '', 'value');
  return out;
}
const refsIn = (s) => { const o = []; if (typeof s !== 'string') return o; let m; LREF.lastIndex = 0; while ((m = LREF.exec(s))) o.push(m[1]); return o; };

/* ---------- connections ---------- */
const cmInfo = {};
j.connectionManagers.forEach((c) => {
  const cs = c.connectionString || ''; const g = (k) => ((cs.match(new RegExp(k + '=([^;]*)', 'i')) || [])[1] || '').trim();
  cmInfo[c.refId] = { name: c.name, type: c.creationName, server: g('Data Source').toLowerCase(), catalog: g('Initial Catalog').toLowerCase(), flat: c.flatFile || null, expr: c.propertyExpressions };
});
const crmCatalogs = new Set(Object.values(cmInfo).filter((c) => /_mscrm$/.test(c.catalog)).map((c) => c.catalog));
const isCrmConn = (ref) => !!(cmInfo[ref] && crmCatalogs.has(cmInfo[ref].catalog));

/* ---------- index all columns ---------- */
const col = {}; // lineageId -> {df, comp, compName, cls, output, name, dataType, length, props}
const consumers = {}; // lineageId -> [{df, comp, input, ic}]
const compByRef = {}; const dfOfComp = {};
j.dataFlows.forEach((d) => d.components.forEach((c) => {
  compByRef[c.refId] = c; dfOfComp[c.refId] = d.task;
  c.outputs.forEach((o) => o.outputColumns.forEach((oc) => { col[oc.lineageId] = { df: d.task, comp: c.refId, compName: c.name, cls: c.classId, output: o.name, isErrorOut: o.isErrorOut, name: oc.name, dataType: oc.dataType, length: oc.length, oc, o, c }; }));
  c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { (consumers[ic.lineageId] = consumers[ic.lineageId] || []).push({ df: d.task, comp: c, input: i, ic }); }));
}));
// inputColumn refId -> lineageId (MergeJoin/Sort output properties reference input columns by refId)
const icRefToLineage = {};
j.dataFlows.forEach((d) => d.components.forEach((c) => c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { icRefToLineage[ic.refId] = ic.lineageId; }))));
const toLineage = (r) => (col[r] ? r : icRefToLineage[r] || r);
// component ancestry from data-flow paths (to restrict in-place modifications to upstream components)
const parents = {};
j.dataFlows.forEach((d) => d.paths.forEach((p) => {
  const from = p.startId.replace(/\.Outputs\[[^\]]*\]$/, ''), to = p.endId.replace(/\.Inputs\[[^\]]*\]$/, '');
  (parents[to] = parents[to] || new Set()).add(from);
}));
const children = {};
j.dataFlows.forEach((d) => d.paths.forEach((p) => { const m = p.startId.match(/^(.*)\.Outputs\[([^\]]*)\]$/); if (!m) return; const to = p.endId.replace(/\.Inputs\[[^\]]*\]$/, ''); (children[m[1]] = children[m[1]] || []).push({ output: m[2], to }); }));
function reachBypassing(fromComp, output, target, exclude) {
  const st = (children[fromComp] || []).filter((e) => e.output === output).map((e) => e.to); const seen = new Set();
  while (st.length) { const x = st.pop(); if (x === exclude || seen.has(x)) continue; if (x === target) return true; seen.add(x); (children[x] || []).forEach((e) => st.push(e.to)); }
  return false;
}
// Conditional Splits that decide WHETHER a row passes through component M on its way to ctx
// (some output reaches ctx while bypassing M, and some output reaches M) → their conditions influence M's replacement.
function branchSplits(M, ctx) {
  const out = [];
  [...ancestors(M)].filter((a) => ancestors(ctx).has(a)).forEach((a) => { const c = compByRef[a]; if (!c || !/ConditionalSplit/.test(c.classId)) return;
    const outs = c.outputs.filter((o) => !o.isErrorOut).map((o) => o.name);
    // S decides M only if S ITSELF routes some rows away from M: an output that reaches ctx but can never reach M,
    // plus an output that reaches M. (A split whose every output can still reach M is not the decider.)
    const reachesM = (o) => reachBypassing(a, o, M, null);
    const bypass = outs.some((o) => !reachesM(o) && reachBypassing(a, o, ctx, M)); const via = outs.some(reachesM);
    if (bypass && via) c.outputs.forEach((o) => { const e = (o.properties.Expression || {}).value; if (e) refsIn(e).map(toLineage).forEach((L) => out.push({ lineageId: L, split: a, output: o.name, expression: (o.properties.FriendlyExpression || {}).value || e })); });
  });
  return out;
}
const inputFeeder = {}; // "<comp>.Inputs[<name>]" -> upstream component refId
j.dataFlows.forEach((d) => d.paths.forEach((p) => { inputFeeder[p.endId] = p.startId.replace(/\.Outputs\[[^\]]*\]$/, ''); }));
const ancMemo = {};
function ancestors(c) { if (ancMemo[c]) return ancMemo[c]; const s = new Set(); const st = [...(parents[c] || [])]; while (st.length) { const x = st.pop(); if (s.has(x)) continue; s.add(x); (parents[x] || []).forEach((y) => st.push(y)); } return (ancMemo[c] = s); }
const extName = (c, id) => { for (const io of c.inputs.concat(c.outputs)) for (const m of io.externalMetadataColumns) if (m.refId === id) return m.name; return null; };

/* ---------- script buffer property maps (from generated BufferWrapper.cs) ---------- */
const scriptProps = {}; // compRef -> {in: {prop: lineageId}, out: {bufferClass: {prop: lineageId}}}
j.codeFiles.filter((f) => f.name === 'BufferWrapper.cs').forEach((f) => {
  const c = compByRef[f.owner]; if (!c) return;
  // Index of each property comes from its generated "<Prop>_IsNull" accessor: IsNull(k) / SetNull(k).
  // Input buffer: k < #inputColumns → input column k; else → new columns of synchronous outputs, in order.
  // Output buffer (async): k → that output's column k.
  const res = { in: {}, syncOut: {}, out: {} }; let cls = null;
  f.text.split(/\r?\n/).forEach((ln, i, arr) => {
    const mc = ln.match(/public class (\w+)\s*:\s*ScriptBuffer/); if (mc) { cls = mc[1]; return; }
    const mp = ln.match(/^\s*public\s+bool\s+(\w+)_IsNull\s*$/); if (!mp || !cls) return;
    let idx = null; for (let k = i + 1; k < Math.min(i + 16, arr.length); k++) { const mi = arr[k].match(/\b(?:IsNull|SetNull)\((\d+)\)/); if (mi) { idx = Number(mi[1]); break; } if (/^\s*public\s/.test(arr[k])) break; }
    if (idx == null) return; const prop = mp[1];
    const inp = c.inputs.find((x) => x.name.replace(/\s/g, '') + 'Buffer' === cls);
    if (inp) {
      if (idx < inp.inputColumns.length) { const ic = inp.inputColumns[idx]; res.in[prop] = { lineageId: ic.lineageId, column: ic.cachedName, usageType: ic.usageType, index: idx, line: i + 1 }; }
      else { const sc = c.outputs.filter((o) => o.synchronousInputId === inp.refId && !o.isErrorOut).flatMap((o) => o.outputColumns.map((oc) => ({ oc, o }))); const t = sc[idx - inp.inputColumns.length];
        if (t) res.syncOut[prop] = { lineageId: t.oc.lineageId, column: t.oc.name, output: t.o.name, index: idx, line: i + 1 }; else res.unmapped = (res.unmapped || []).concat(prop); }
    } else { const out = c.outputs.find((x) => x.name.replace(/\s/g, '') + 'Buffer' === cls);
      if (out) { const oc = out.outputColumns[idx]; (res.out[out.name] = res.out[out.name] || {}); if (oc) res.out[out.name][prop] = { lineageId: oc.lineageId, column: oc.name, index: idx, line: i + 1 }; else res.unmapped = (res.unmapped || []).concat(cls + '.' + prop); } }
  });
  scriptProps[c.refId] = res;
});

/* ---------- SQL projection parsing for OLE DB Sources (simple, auditable) ---------- */
function splitTop(s) { const parts = []; let depth = 0, cur = '', q = null; for (const ch of s) { if (q) { cur += ch; if (ch === q) q = null; continue; } if (ch === "'" ) { q = ch; cur += ch; continue; } if (ch === '(') depth++; if (ch === ')') depth--; if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch; } if (cur.trim()) parts.push(cur); return parts; }
const unbr = (s) => s.replace(/[\[\]"]/g, '').trim();
function parseSelect(sql) {
  const s = sql.replace(/--[^\n]*/g, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ');
  const m = s.match(/^\s*select\s+(?:top\s+\d+\s+|distinct\s+)*([\s\S]*?)\s+from\s+([\s\S]*)$/i); if (!m) return null;
  const fromPart = m[2]; const tbl = (fromPart.match(/^\s*([\[\]\w.]+)/) || [])[1];
  const joins = /\bjoin\b/i.test(fromPart);
  const where = (fromPart.match(/\bwhere\b([\s\S]*)$/i) || [])[1] || null;
  const items = splitTop(m[1]).map((raw) => {
    const t = raw.trim(); let mm = t.match(/^([\s\S]+?)\s+as\s+([\[\]\w]+)$/i) || t.match(/^([\[\]\w.]+)\s+([\[\]\w]+)$/);
    const expr = mm ? mm[1].trim() : t, alias = unbr(mm ? mm[2] : t.split('.').pop());
    const simple = /^[\[\]\w.]+$/.test(expr);
    return { raw: t, expr, alias, simple, sourceColumn: simple ? unbr(expr.split('.').pop()) : null };
  });
  return { table: tbl ? unbr(tbl).replace(/^dbo\./i, 'dbo.') : null, joins, where, items };
}

/* ---------- DB writers (cross data-flow bridges) ---------- */
const tableKey = (connRef, table) => { const ci = cmInfo[connRef] || {}; return (ci.catalog || '?') + '|' + unbr(table || '').toLowerCase().replace(/^dbo\./, ''); };
const dbWriters = {}; // key|column -> [{lineageId, comp, conn, server}]
j.dataFlows.forEach((d) => d.components.filter((c) => /OLEDBDestination/.test(c.classId)).forEach((c) => {
  const conn = c.connections[0] && c.connections[0].connectionManagerRefId; const table = c.properties.OpenRowset && c.properties.OpenRowset.value;
  c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { const cn = extName(c, ic.externalMetadataColumnId); const k = tableKey(conn, table) + '|' + (cn || '').toLowerCase();
    (dbWriters[k] = dbWriters[k] || []).push({ lineageId: ic.lineageId, comp: c.refId, conn, server: (cmInfo[conn] || {}).server, column: cn, table }); }));
}));

j.dataFlows.forEach((d) => d.components.filter((c) => /OLEDBCommand/.test(c.classId)).forEach((c) => {
  const sql = ((c.properties.SqlCommand || {}).value || '').replace(/--[^\n]*/g, ' ');
  const m = sql.match(/^\s*insert\s+into\s+([\[\]\w.]+)\s*\(([^)]*)\)\s*values\s*\(([^)]*)\)\s*;?\s*$/i); if (!m) return;
  const conn = c.connections[0] && c.connections[0].connectionManagerRefId; if (isCrmConn(conn)) return;
  const cols = m[2].split(',').map((x) => unbr(x)), vals = m[3].split(',').map((x) => x.trim()); if (cols.length !== vals.length) return;
  let k = 0; cols.forEach((cn, i) => { if (vals[i] !== '?') return; const param = 'Param_' + k++;
    const ic = c.inputs.flatMap((x) => x.inputColumns).find((x) => extName(c, x.externalMetadataColumnId) === param); if (!ic) return;
    const key = tableKey(conn, m[1]) + '|' + cn.toLowerCase(); (dbWriters[key] = dbWriters[key] || []).push({ lineageId: ic.lineageId, comp: c.refId, conn, server: (cmInfo[conn] || {}).server, column: cn, table: m[1], via: 'OLE DB Command INSERT ' + param }); });
}));

/* ---------- origin of a column (one step back) ---------- */
function stepBack(L) {
  const k = col[L]; if (!k) return { kind: 'unknown', note: 'lineageId not produced in any data flow' };
  const { c, oc } = k; const cls = c.classId;
  if (/FlatFileSource/.test(cls)) {
    const conn = c.connections[0] && c.connections[0].connectionManagerRefId; const ext = extName(c, oc.externalMetadataColumnId);
    const fc = cmInfo[conn] && cmInfo[conn].flat ? cmInfo[conn].flat.columns.find((x) => x.name === ext) : null;
    if (oc.name === (c.properties.FileNameColumnName || {}).value) return { kind: 'file-name-column', component: c.refId };
    return { kind: 'file-field', connection: conn, fileColumn: ext, ordinal: fc ? fc.ordinal : null, start: fc ? fc.start : null, end: fc ? fc.end : null, width: fc ? fc.columnWidth : null, evidence: 'FlatFileSource externalMetadataColumn ↔ ConnectionManager FlatFileColumn (same name, SSIS binding)' };
  }
  if (/OLEDBSource/.test(cls)) {
    const conn = c.connections[0] && c.connections[0].connectionManagerRefId; const am = (c.properties.AccessMode || {}).value; const ext = extName(c, oc.externalMetadataColumnId) || oc.name;
    if (am === '0' || am === '1') { const t = (c.properties.OpenRowset || {}).value; return { kind: 'db-column', conn, table: t, column: ext, key: tableKey(conn, t) + '|' + ext.toLowerCase(), evidence: 'OLE DB Source table mode' }; }
    const sql = (c.properties.SqlCommand || {}).value || ''; const p = parseSelect(sql);
    const it = p && p.items.find((x) => x.alias.toLowerCase() === ext.toLowerCase());
    if (p && it && it.simple && !p.joins && p.table) return { kind: 'db-column', conn, table: p.table, column: it.sourceColumn, alias: ext, key: tableKey(conn, p.table) + '|' + it.sourceColumn.toLowerCase(), evidence: 'SELECT projection: ' + it.raw, sqlWhere: p.where };
    return { kind: 'sql-expression', component: c.refId, conn, column: ext, item: it ? it.raw : null, sql: sql.slice(0, 4000), open: true, note: p ? (p.joins ? 'SQL has JOINs — analyst must resolve' : 'non-simple projection item') : 'SQL not parsed' };
  }
  if (/UnionAll/.test(cls)) {
    const ins = []; c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (refsIn((ic.properties.OutputColumnLineageID || {}).value).includes(L) || (ic.properties.OutputColumnLineageID || {}).value === L) ins.push({ lineageId: ic.lineageId, input: i.name }); }));
    return { kind: 'union', component: c.refId, from: ins };
  }
  if (/Lookup/.test(cls) && pv(oc, 'CopyFromReferenceColumn')) {
    const keys = []; c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (pv(ic, 'JoinToReferenceColumn')) keys.push({ lineageId: ic.lineageId, joinTo: pv(ic, 'JoinToReferenceColumn') }); }));
    const lconn = (c.connections[0] || {}).connectionManagerRefId; const lsql = (c.properties.SqlCommand || {}).value || ''; const lp = parseSelect(lsql); const refCol = pv(oc, 'CopyFromReferenceColumn');
    let refKey = null; if (lp && lp.table && !lp.joins) { const it = lp.items.find((x) => x.alias.toLowerCase() === refCol.toLowerCase()); const srcCol = lp.items.length === 1 && lp.items[0].raw === '*' ? refCol : it && it.simple ? it.sourceColumn : null; if (srcCol) refKey = tableKey(lconn, lp.table) + '|' + srcCol.toLowerCase(); }
    const refWriters = refKey && dbWriters[refKey] ? dbWriters[refKey] : null;
    return { kind: 'lookup-return', component: c.refId, referenceColumn: refCol, refTableKey: refKey, bridged: !!refWriters, keys, sql: ((c.properties.SqlCommand || {}).value || '').slice(0, 3000), conn: (c.connections[0] || {}).connectionManagerRefId };
  }
  const refs = new Set(); let exprProp = null;
  for (const [pn, pv] of Object.entries(oc.properties)) { const r = refsIn(pv.value); if (r.length) { r.forEach((x) => refs.add(toLineage(x))); if (/Expression/.test(pn)) exprProp = pn; } else if (typeof pv.value === 'string' && (col[pv.value] || icRefToLineage[pv.value])) refs.add(toLineage(pv.value)); }
  const roleMap = exprRoles((oc.properties.Expression || {}).value || '');
  if (refs.size) return { kind: /DerivedColumn/.test(cls) ? 'derived' : /Aggregate/.test(cls) ? 'aggregate' : /Sort/.test(cls) ? 'sort' : /MergeJoin/.test(cls) ? 'merge-join' : 'computed', component: c.refId, from: [...refs].map((x) => ({ lineageId: x, role: roleMap.get(x) || 'value' })), expression: (oc.properties.FriendlyExpression || {}).value || (oc.properties.Expression || {}).value || null, aggregation: (oc.properties.AggregationType || {}).value || null };
  if (/ManagedComponentHost/.test(cls)) {
    const r = RES.scriptOutputs.find((x) => x.component === c.refId && x.output === k.output && x.column === oc.name);
    if (r) {
      const ins = c.inputs.flatMap((i) => i.inputColumns); const from = [];
      (r.from || []).forEach((f) => { const ic = ins.find((x) => x.cachedName === f.column); if (ic) from.push({ lineageId: ic.lineageId, role: f.role || 'value' }); else from.push({ lineageId: null, missing: f.column }); });
      return { kind: 'script-code', component: c.refId, from: from.filter((f) => f.lineageId), roles: from, expression: r.expression || null, condition: r.condition || null, evidence: r.evidence, resolvedBy: 'analyst', constant: !(r.from || []).length };
    }
    return { kind: 'script-output', component: c.refId, output: k.output, column: oc.name, open: true, note: 'value assigned in script code — analyst must resolve' };
  }
  if (/DerivedColumn/.test(cls)) return { kind: 'derived-constant', component: c.refId, expression: (oc.properties.FriendlyExpression || {}).value || null };
  return { kind: 'unknown', component: c.refId, cls };
}

/* ---------- in-place modifications & uses of a lineageId ---------- */
function usesOf(L) {
  const out = [];
  (consumers[L] || []).forEach(({ comp: c, input, ic }) => {
    const cls = c.classId, base = { component: c.refId, componentName: c.name, df: dfOfComp[c.refId], cls: cls.replace('Microsoft.', '') };
    // NOTE: SSIS serialises these properties on every column, often with an empty value — test the value, not presence.
    if (/DerivedColumn/.test(cls) && pv(ic, 'Expression')) out.push({ ...base, use: 'replaced-in-place', expression: pv(ic, 'FriendlyExpression') || pv(ic, 'Expression'), refs: refsIn(pv(ic, 'Expression')).map(toLineage).filter((x) => x !== L), roles: Object.fromEntries(exprRoles(pv(ic, 'Expression'))) });
    else if (/Lookup/.test(cls)) { if (pv(ic, 'JoinToReferenceColumn')) out.push({ ...base, use: 'lookup-key', joinTo: pv(ic, 'JoinToReferenceColumn'), sql: ((c.properties.SqlCommand || {}).value || '').slice(0, 1500) }); if (pv(ic, 'CopyFromReferenceColumn')) out.push({ ...base, use: 'replaced-by-lookup', from: pv(ic, 'CopyFromReferenceColumn') }); }
    else if (/OLEDBCommand/.test(cls)) { const conn = (c.connections[0] || {}).connectionManagerRefId; out.push({ ...base, use: 'sql-param', param: extName(c, ic.externalMetadataColumnId), crmConnection: isCrmConn(conn), conn }); }
    else if (/OLEDBDestination/.test(cls)) { const conn = (c.connections[0] || {}).connectionManagerRefId; out.push({ ...base, use: 'db-write', table: (c.properties.OpenRowset || {}).value, column: extName(c, ic.externalMetadataColumnId), crmConnection: isCrmConn(conn), conn }); }
    else if (/FlatFileDestination/.test(cls)) out.push({ ...base, use: 'file-write', column: extName(c, ic.externalMetadataColumnId) });
    else if (/ManagedComponentHost/.test(cls)) { const sp = scriptProps[c.refId]; const prop = sp ? Object.keys(sp.in).find((p) => sp.in[p].lineageId === L && sp.in[p].column === ic.cachedName) : null; out.push({ ...base, use: ic.usageType === 'readWrite' ? 'script-input-readwrite' : 'script-input', rowProperty: prop || null }); }
    else if (/UnionAll/.test(cls)) out.push({ ...base, use: 'union-input', to: refsIn((ic.properties.OutputColumnLineageID || {}).value)[0] || (ic.properties.OutputColumnLineageID || {}).value });
    else if (/RowCount|Multicast/.test(cls)) { /* pass-through, not a use */ }
    else out.push({ ...base, use: 'input', usageType: ic.usageType });
  });
  // expression references (conditional split / derived / sort / aggregate / merge join outputs)
  j.dataFlows.forEach((d) => d.components.forEach((c) => {
    c.outputs.forEach((o) => {
      const e = o.properties.Expression; if (e && refsIn(e.value).includes(L)) out.push({ component: c.refId, componentName: c.name, df: d.task, cls: c.classId.replace('Microsoft.', ''), use: 'condition', output: o.name, expression: (o.properties.FriendlyExpression || {}).value || e.value });
      o.outputColumns.forEach((oc) => { for (const [pn, pv] of Object.entries(oc.properties)) if (refsIn(pv.value).map(toLineage).includes(L) || toLineage(pv.value) === L) { out.push({ component: c.refId, componentName: c.name, df: d.task, cls: c.classId.replace('Microsoft.', ''), use: 'feeds-column', toLineage: oc.lineageId, toName: oc.name, via: pn, expression: (oc.properties.FriendlyExpression || {}).value || null }); break; } });
    });
    c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (ic.lineageId !== L && /DerivedColumn/.test(c.classId) && refsIn((ic.properties.Expression || {}).value).includes(L)) out.push({ component: c.refId, componentName: c.name, df: d.task, cls: 'DerivedColumn', use: 'feeds-replace', toLineage: ic.lineageId, toName: ic.cachedName, expression: (ic.properties.FriendlyExpression || {}).value }); }));
  }));
  return out;
}

/* ---------- forward closure from a lineageId (across bridges) ---------- */
const dbReaders = {}; // key -> [{lineageId}]
Object.keys(col).forEach((L) => { const s = col[L].cls.includes('OLEDBSource') ? stepBack(L) : null; if (s && s.kind === 'db-column') (dbReaders[s.key] = dbReaders[s.key] || []).push({ lineageId: L, comp: col[L].comp, server: (cmInfo[s.conn] || {}).server, alias: s.alias || s.column, evidence: s.evidence }); });
function forward(L0) {
  const seen = new Set(); const paths = []; const stack = [{ L: L0, trail: [] }];
  while (stack.length) {
    const { L, trail } = stack.pop(); if (seen.has(L)) continue; seen.add(L);
    usesOf(L).forEach((u) => {
      const step = { at: col[L] ? col[L].name : L, lineageId: L, ...u }; delete step.sql;
      if (u.use === 'feeds-column' || u.use === 'feeds-replace' || u.use === 'union-input') { const to = u.toLineage || u.to; if (to) stack.push({ L: to, trail: trail.concat([step]) }); }
      else if (u.use === 'db-write') {
        const key = tableKey(u.conn, u.table) + '|' + (u.column || '').toLowerCase();
        const rs = dbReaders[key] || []; const writerServer = (cmInfo[u.conn] || {}).server;
        paths.push({ terminal: u, trail });
        rs.forEach((r) => stack.push({ L: r.lineageId, trail: trail.concat([{ ...step, bridge: true, readAs: r.alias, readBy: r.comp, serverMatch: r.server === writerServer, writerServer, readerServer: r.server, evidence: r.evidence }]) }));
      } else paths.push({ terminal: u, trail });
    });
  }
  return { reached: [...seen], paths };
}

/* ---------- build outputs ---------- */
const files = [];
j.dataFlows.forEach((d) => d.components.filter((c) => /FlatFileSource/.test(c.classId)).forEach((c) => {
  const conn = c.connections[0] && c.connections[0].connectionManagerRefId; const fl = cmInfo[conn] && cmInfo[conn].flat;
  const exposed = {}; c.outputs.filter((o) => !o.isErrorOut).forEach((o) => o.outputColumns.forEach((oc) => { const e = extName(c, oc.externalMetadataColumnId); if (e) exposed[e] = oc.lineageId; }));
  const fields = (fl ? fl.columns : []).map((fc) => {
    const L = exposed[fc.name] || null; const fw = L ? forward(L) : null;
    return { ordinal: fc.ordinal, name: fc.name, start: fc.start, end: fc.end, width: fc.columnWidth, dataType: fc.dataType, exposedToDataFlow: !!L, lineageId: L, paths: fw ? fw.paths : [] };
  });
  files.push({ component: c.refId, df: d.task, connection: conn, connectionExpressions: cmInfo[conn] ? cmInfo[conn].expr : [], format: fl ? fl.format : null, codePage: fl ? fl.codePage : null, fieldCount: fields.length, exposedCount: fields.filter((f) => f.exposedToDataFlow).length, fields });
}));

// Write components: CRM-relevant sinks the analyst must map (SQL commands on CRM conn, scripts with CRM SDK candidates, CRM-conn destinations)
const crmScriptOwners = new Set(j.candidates.code.filter((x) => /crm-sdk|crm-entity/.test(x.pattern)).map((x) => x.owner));
const writeComponents = [];
j.dataFlows.forEach((d) => d.components.forEach((c) => {
  const conn = (c.connections[0] || {}).connectionManagerRefId;
  const isCmd = /OLEDBCommand/.test(c.classId), isDest = /OLEDBDestination/.test(c.classId), isScript = /ManagedComponentHost/.test(c.classId) && crmScriptOwners.has(c.refId);
  const isCrmDest = /ManagedComponentHost/.test(c.classId) && /CrmDestinationComponent/.test(String((c.properties.UserComponentTypeName || {}).value || ''));
  if (!(isScript || isCrmDest || ((isCmd || isDest) && isCrmConn(conn)))) return;
  const inputs = c.inputs.flatMap((i) => i.inputColumns.map((ic) => {
    const sp = scriptProps[c.refId]; const prop = sp ? Object.keys(sp.in).find((p) => sp.in[p].lineageId === ic.lineageId && sp.in[p].column === ic.cachedName) : null;
    return { column: ic.cachedName, lineageId: ic.lineageId, usageType: ic.usageType, rowProperty: prop, param: (isCmd || isDest || isCrmDest) ? extName(c, ic.externalMetadataColumnId) : null };
  }));
  writeComponents.push({ component: c.refId, df: d.task, kind: isScript ? 'script' : isCrmDest ? 'crm-destination' : isCmd ? 'oledb-command' : 'oledb-destination', conn, crmConnection: isCrmDest ? 'crm-service' : isCrmConn(conn), crmDestination: isCrmDest ? { entity: (c.properties.DestinationEntity || {}).value, actionType: (c.properties.ActionType || {}).value, matchingCriteria: (c.properties.RecordMatchingCriteria || {}).value, matchingKeyFields: (c.properties.RecordMatchingKeyFields || {}).value, ignoreNullValuedFields: (c.properties.IgnoreNullValuedFields || {}).value, ignoreUnchangedFields: (c.properties.IgnoreUnchangedFields || {}).value, componentType: (c.properties.UserComponentTypeName || {}).value, line: c.line } : null, sql: isCmd ? (c.properties.SqlCommand || {}).value : null, table: isDest ? (c.properties.OpenRowset || {}).value : null, inputs, codeFiles: j.codeFiles.filter((f) => f.owner === c.refId && f.isSource).map((f) => f.name) });
}));

// Merge Join key columns for one input: walk up the path into this input; use the upstream output's sortKeyPosition
// columns (1..nk); if that output is synchronous, continue above its input (sort order passes through sync transforms).
function mjKeys(inp, nk) {
  let target = inp.refId;
  for (let hop = 0; hop < 50; hop++) {
    let p = null; j.dataFlows.forEach((d) => d.paths.forEach((x) => { if (x.endId === target) p = x; }));
    if (!p) return null;
    const m = p.startId.match(/^(.*)\.Outputs\[([^\]]*)\]$/); if (!m) return null;
    const u = compByRef[m[1]]; if (!u) return null; const o = u.outputs.find((x) => x.name === m[2]); if (!o) return null;
    const keyed = o.outputColumns.filter((oc) => oc.sortKeyPosition && Math.abs(Number(oc.sortKeyPosition)) >= 1 && Math.abs(Number(oc.sortKeyPosition)) <= nk);
    if (keyed.length) return keyed.sort((a, b) => Math.abs(Number(a.sortKeyPosition)) - Math.abs(Number(b.sortKeyPosition))).map((oc) => oc.lineageId);
    if (!o.synchronousInputId) return null;
    const si = u.inputs.find((i) => i.refId === o.synchronousInputId || i.refId.endsWith(o.synchronousInputId)); if (!si) return null;
    // a synchronous output re-exposes its input's columns under the same lineageIds; the keys sit further up
    target = si.refId;
  }
  return null;
}

// Row filters: which file fields decide WHETHER a row reaches a writer (not the value written).
function rowFilters(w) {
  const up = [...ancestors(w.component)]; const out = [];
  up.forEach((a) => { const c = compByRef[a]; if (!c) return;
    // a split FILTERS rows for this writer only if at least one of its outputs can never reach the writer
    // (otherwise every branch arrives and the split only decides values — handled as attribute-level influence)
    if (/ConditionalSplit/.test(c.classId) && c.outputs.filter((o) => !o.isErrorOut).some((o) => !reachBypassing(a, o.name, w.component, null))) c.outputs.forEach((o) => { const e = (o.properties.Expression || {}).value; if (!e) return; refsIn(e).map(toLineage).forEach((L) => out.push({ lineageId: L, component: c.refId, kind: 'conditional-split', output: o.name, leads: reachBypassing(a, o.name, w.component, null), expression: (o.properties.FriendlyExpression || {}).value || e })); });
    // Sort with EliminateDuplicates: keeps one row per sort key → the key columns decide which rows reach the writer
    if (/Sort/.test(c.classId) && /^(true|1)$/i.test(String((c.properties.EliminateDuplicates || {}).value || ''))) c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (Number(pv(ic, 'NewSortKeyPosition') || 0) !== 0) out.push({ lineageId: ic.lineageId, component: c.refId, kind: 'sort-dedup', output: 'EliminateDuplicates', expression: 'one row per sort key ' + ic.cachedName }); }));
    // INNER Merge Join (JoinType=2): rows without a partner on the other input are dropped → the join keys decide which rows pass.
    // Keys = the first NumKeyColumns sort-key columns of each input's (sorted) upstream output; followed back through synchronous outputs.
    if (/MergeJoin/.test(c.classId) && String((c.properties.JoinType || {}).value) === '2') {
      const nk = Number((c.properties.NumKeyColumns || {}).value || 0);
      const sides = c.inputs.map((inp) => mjKeys(inp, nk));
      if (sides.every((k) => k && k.length === nk)) {
        const expr = 'INNER join (' + nk + ' keys): ' + sides[0].map((L, i) => col[L].name + ' = ' + col[sides[1][i]].name).join(' AND ') + ' — rows with no partner on the other input are dropped';
        sides.forEach((k) => k.forEach((L) => out.push({ lineageId: L, component: c.refId, kind: 'inner-join', output: null, expression: expr })));
      } else out.push({ lineageId: null, component: c.refId, kind: 'inner-join', output: null, expression: 'INNER join (' + nk + ' keys) — key columns could not be resolved from sortKeyPosition (open)', unresolved: true });
    }
    // routing Lookup: a filter only if its Match or No Match output can never reach the writer
    if (/Lookup/.test(c.classId) && ((c.properties.NoMatchBehavior || {}).value === '1') && c.outputs.filter((o) => !o.isErrorOut).some((o) => !reachBypassing(a, o.name, w.component, null))) c.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (pv(ic, 'JoinToReferenceColumn')) out.push({ lineageId: ic.lineageId, component: c.refId, kind: 'lookup-routing', output: 'Match / No Match', expression: 'join ' + ic.cachedName + ' = ' + pv(ic, 'JoinToReferenceColumn') }); }));
  });
  const seen = new Set();
  return out.filter((x) => { const k = x.lineageId + '|' + x.component + '|' + (x.output || ''); if (seen.has(k)) return false; seen.add(k); return true; }).map((x) => {
    if (!x.lineageId) return { component: x.component, kind: x.kind, output: x.output, leads: null, expression: x.expression, fileFields: [], fileKeys: [], open: 1 };
    const n = backward(x.lineageId, x.component); const acc = { value: new Set(), influence: new Set(), open: [], scriptTouched: new Set() }; classify(n, 'value', acc);
    return { component: x.component, kind: x.kind, output: x.output, leads: x.leads, expression: x.expression, fileFields: [...new Set([...acc.value, ...acc.influence])], fileKeys: [...(acc.keys || [])], open: acc.open.length };
  });
}

// Backward origin chains for each write-component input (to file fields)
// ctx = the component that consumes L at this point of the backward walk; in-place modifications
// are only those performed by components upstream of ctx (ancestors) — never siblings/downstream.
function backward(L, ctx, depth = 0, seen = new Set()) {
  if (seen.has(L) || depth > 60) return [{ kind: 'cycle-or-depth', lineageId: L }]; seen.add(L);
  const s = stepBack(L); const node = { lineageId: L, name: col[L] ? col[L].name : null, component: col[L] ? col[L].comp : null, ...s };
  const up = ancestors(ctx);
  const mods = usesOf(L).filter((u) => /replaced|readwrite/.test(u.use) && up.has(u.component)).map((u) => ({ component: u.component, use: u.use, expression: u.expression || u.from || null }));
  // order: closest-to-consumer first (compose reverses chains so the upstream-most modification reads first)
  mods.sort((a, b) => (ancestors(b.component).has(a.component) ? 1 : ancestors(a.component).has(b.component) ? -1 : 0));
  if (mods.length) node.inPlace = mods;
  const extra = [];
  usesOf(L).filter((u) => u.use === 'replaced-in-place' && up.has(u.component)).forEach((u) => (u.refs || []).forEach((r) => extra.push({ lineageId: r, via: u.component, why: 'Derived Column REPLACE: ' + (u.expression || ''), role: (u.roles || {})[r] || 'value' })));
  RES.readWrite.filter((m) => up.has(m.component) && col[L] && (consumers[L] || []).some((x) => x.comp.refId === m.component && (m.column === '*' ? x.ic.usageType === 'readWrite' : x.ic.cachedName === m.column))).forEach((m) => {
    (node.rwMods = node.rwMods || []).push({ component: m.component, column: m.column === '*' ? col[L].name : m.column, expression: m.expression, condition: m.condition || null, evidence: m.evidence });
    const cm = compByRef[m.component]; (m.from || []).forEach((fr) => { const ic = cm.inputs.flatMap((i) => i.inputColumns).find((x) => x.cachedName === fr.column); if (ic && ic.lineageId !== L) extra.push({ lineageId: ic.lineageId, via: m.component, why: 'Script ReadWrite: ' + (m.expression || ''), role: fr.role || 'value' }); });
  });
  const condExtra = [];
  usesOf(L).filter((u) => (u.use === 'replaced-in-place' || u.use === 'replaced-by-lookup') && up.has(u.component)).forEach((u) => {
    branchSplits(u.component, ctx).forEach((b) => condExtra.push({ lineageId: b.lineageId, via: b.split, why: 'הענף שבו "' + tail(u.component) + '" מחליף את הערך נקבע ע"י ' + tail(b.split) + ' [' + b.output + ']: ' + b.expression }));
    if (u.use === 'replaced-by-lookup') { const lc = compByRef[u.component]; lc.inputs.forEach((i) => i.inputColumns.forEach((ic) => { if (pv(ic, 'JoinToReferenceColumn') && ic.lineageId !== L) condExtra.push({ lineageId: ic.lineageId, via: u.component, why: 'מפתח ה-Lookup "' + tail(u.component) + '" שדורס את הערך (' + ic.cachedName + ' = ' + pv(ic, 'JoinToReferenceColumn') + ')' }); })); }
  });
  if (condExtra.length) { const seenC = new Set(); node.condOrigins = (node.condOrigins || []).concat(condExtra.filter((x) => { const k = x.lineageId + '|' + x.via; if (seenC.has(k)) return false; seenC.add(k); return true; }).map((x) => ({ role: 'condition', why: x.why, via: x.via, origin: backward(x.lineageId, x.via, depth + 1, new Set(seen)) }))); }
  if (extra.length) node.alsoFrom = extra.map((x) => ({ via: x.via, why: x.why, role: x.role || 'value', origin: backward(x.lineageId, x.via, depth + 1, new Set(seen)) }));
  if (s.kind === 'union' && s.from) {
    const U = compByRef[s.component]; const connected = U.inputs.filter((i) => inputFeeder[i.refId]).map((i) => i.name);
    const providing = new Set(s.from.map((x) => x.input));
    if (providing.size && providing.size < connected.length) {
      const seenU = new Set(); const extraU = [];
      U.inputs.filter((i) => providing.has(i.name) && inputFeeder[i.refId]).forEach((i) => branchSplits(inputFeeder[i.refId], s.component).forEach((b) => { const k = b.lineageId + '|' + b.split; if (seenU.has(k)) return; seenU.add(k); extraU.push(b); }));
      if (extraU.length) node.condOrigins = (node.condOrigins || []).concat(extraU.map((b) => ({ role: 'condition', via: b.split, why: 'העמודה מגיעה רק מחלק מהענפים של "' + tail(s.component) + '" (בשאר הענפים NULL); הענף נקבע ע"י ' + tail(b.split) + ' [' + b.output + ']: ' + b.expression, origin: backward(b.lineageId, b.split, depth + 1, new Set(seen)) })));
    }
  }
  const prod = col[L] ? col[L].comp : ctx;
  if (s.kind === 'lookup-return' && s.bridged) { node.writers = dbWriters[s.refTableKey].map((w) => ({ comp: w.comp, viaLookup: true, serverMatch: w.server === (cmInfo[s.conn] || {}).server, writerServer: w.server, readerServer: (cmInfo[s.conn] || {}).server, origin: backward(w.lineageId, w.comp, depth + 1, new Set(seen)) })); }
  if (s.kind === 'db-column') { const ws = dbWriters[s.key] || []; node.writers = ws.map((w) => ({ comp: w.comp, serverMatch: w.server === (cmInfo[s.conn] || {}).server, writerServer: w.server, readerServer: (cmInfo[s.conn] || {}).server, origin: backward(w.lineageId, w.comp, depth + 1, new Set(seen)) })); }
  else if (s.from) {
    node.origin = s.from.filter((f) => !f.role || f.role === 'value').map((f) => backward(f.lineageId, prod, depth + 1, new Set(seen)));
    const cond = s.from.filter((f) => f.role && f.role !== 'value'); if (cond.length) node.condOrigins = (node.condOrigins || []).concat(cond.map((f) => ({ role: f.role, origin: backward(f.lineageId, prod, depth + 1, new Set(seen)) })));
  }
  else if (s.keys) node.keyOrigins = s.keys.map((k) => ({ joinTo: k.joinTo, origin: backward(k.lineageId, prod, depth + 1, new Set(seen)) }));
  return node;
}
writeComponents.forEach((w) => w.inputs.forEach((i) => { i.origin = backward(i.lineageId, w.component); }));
writeComponents.forEach((w) => { w.rowFilters = rowFilters(w); });
// Classify file fields reaching an input: 'value' = the file value flows (possibly transformed) into it;
// 'influence' = the file field only selects/filters (lookup key) or its value was overwritten by a lookup.
// 'unresolved' = path passes an open node (script output / complex SQL) — analyst must resolve.
function classify(n, mode, acc) {
  if (!n) return; if (Array.isArray(n)) { n.forEach((x) => classify(x, mode, acc)); return; }
  let m = mode;
  if (n.inPlace && n.inPlace.some((x) => x.use === 'replaced-by-lookup')) m = 'influence';
  if (n.kind === 'file-field') { acc[m].add(n.fileColumn); (acc.keys = acc.keys || new Set()).add(n.connection + '::' + n.fileColumn); return; }
  if (n.open) { acc.open.push({ kind: n.kind, component: n.component, column: n.column || n.name, output: n.output || null }); return; }
  if (n.inPlace && n.inPlace.some((x) => x.use === 'script-input-readwrite')) acc.scriptTouched.add(n.name);
  if (n.alsoFrom) n.alsoFrom.forEach((a) => classify(a.origin, a.role === 'value' ? m : 'influence', acc));
  if (n.condOrigins) n.condOrigins.forEach((a) => classify(a.origin, 'influence', acc));
  if (n.writers) n.writers.forEach((w) => classify(w.origin, m, acc));
  if (n.origin) classify(n.origin, m, acc);
  if (n.keyOrigins) n.keyOrigins.forEach((k) => classify(k.origin, 'influence', acc));
}
writeComponents.forEach((w) => w.inputs.forEach((i) => {
  const acc = { value: new Set(), influence: new Set(), open: [], scriptTouched: new Set() }; classify(i.origin, 'value', acc);
  i.valueFileFields = [...acc.value]; i.influenceFileFields = [...acc.influence].filter((x) => !acc.value.has(x)); i.openNodes = acc.open; i.scriptTouched = [...acc.scriptTouched];
  i.fileFields = [...new Set([...acc.value, ...acc.influence])];
}));

// Open items that lie on a path into a CRM write component (the only ones that matter for CRM mapping)
const openMap = {};
writeComponents.forEach((w) => w.inputs.forEach((i) => i.openNodes.forEach((o) => {
  const k = o.component + '|' + o.output + '|' + o.column; if (!openMap[k]) {
    const sp = scriptProps[o.component] || {}; const prop = Object.entries(sp.syncOut || {}).find(([, v]) => v.column === o.column && v.output === o.output) || Object.entries((sp.out || {})[o.output] || {}).find(([, v]) => v.column === o.column);
    openMap[k] = { component: o.component, output: o.output, column: o.column, bufferProperty: prop ? prop[0] : null, async: !(sp.syncOut && prop && sp.syncOut[prop[0]]), neededBy: new Set() };
  }
  openMap[k].neededBy.add(w.component);
})));
const openItems = Object.values(openMap).map((o) => ({ ...o, neededBy: [...o.neededBy] }));
const stats = {
  openItemsOnCrmPaths: openItems.length,
  fileFields: files.reduce((a, f) => a + f.fieldCount, 0), exposed: files.reduce((a, f) => a + f.exposedCount, 0),
  writeComponents: writeComponents.length, scriptWrites: writeComponents.filter((w) => w.kind === 'script').length, crmDestinations: writeComponents.filter((w) => w.kind === 'crm-destination').length, sqlWritesOnCrm: writeComponents.filter((w) => w.kind === 'oledb-command' || w.kind === 'oledb-destination').length,
  openSqlExpressions: Object.keys(col).filter((L) => /OLEDBSource/.test(col[L].cls) && stepBack(L).kind === 'sql-expression').length,
  scriptOutputsOpen: Object.keys(col).filter((L) => /ManagedComponentHost/.test(col[L].cls) && !col[L].isErrorOut && stepBack(L).kind === 'script-output').length,
  bridgesServerMismatch: Object.values(dbReaders).flat().filter((r) => { const ws = Object.entries(dbWriters).find(([k]) => (dbReaders[k] || []).includes(r)); return ws && ws[1].some((w) => w.server !== r.server); }).length,
};
const out = { schema: 'lineage/0.1', source: j.source, crmCatalogs: [...crmCatalogs], connections: cmInfo, stats, files, writeComponents, openItems, scriptProps, resolutionsApplied: RES.scriptOutputs.length };
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(out, null, 1));
console.log(JSON.stringify({ file: j.source.file, ...stats }, null, 1));
