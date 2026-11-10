#!/usr/bin/env node
// Compose the final file↔CRM field mapping for a package.
// 1) gathers analyst scriptOutputs from analysis/<pkg>/mapping-*.json → analysis/<pkg>/resolutions.json
// 2) re-runs tools/lineage.mjs with the resolutions
// 3) joins analyst crmWrites with deterministic lineage → analysis/<pkg>/fieldmap.json
// Usage: node tools/compose.mjs <pkg>
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const pkg = process.argv[2];
const dir = path.join('analysis', pkg);
const mappings = fs.readdirSync(dir).filter((f) => /^mapping-.*\.json$/.test(f)).map((f) => ({ f, j: JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')) }));
const scriptOutputs = mappings.flatMap((m) => (m.j.scriptOutputs || []).map((s) => ({ ...s, analystFile: m.f })));
const readWrite = mappings.flatMap((m) => (m.j.readWriteModifications || []).filter((r) => typeof r.column === 'string').map((r) => ({ ...r, analystFile: m.f })));
const rwUnstructured = mappings.flatMap((m) => (m.j.readWriteModifications || []).filter((r) => typeof r.column !== 'string').map((r) => ({ ...r, analystFile: m.f })));
fs.writeFileSync(path.join(dir, 'resolutions.json'), JSON.stringify({ scriptOutputs, readWrite }, null, 1));
execFileSync(process.execPath, ['tools/lineage.mjs', `evidence/${pkg}.json`, `lineage/${pkg}.lineage.json`, path.join(dir, 'resolutions.json')], { stdio: 'inherit' });
const L = JSON.parse(fs.readFileSync(`lineage/${pkg}.lineage.json`, 'utf8'));
const tail = (s) => (s || '').split('\\').pop();
const dfName = (s) => (s || '').split('\\').slice(-2, -1)[0] || '';

/* ---- flatten an origin tree into chains: one chain per file-field leaf ---- */
function describe(n) {
  const k = n.kind, c = tail(n.component);
  if (k === 'file-field') return { t: 'file', text: `שדה בקובץ ${n.fileColumn} (מיקום ${n.start ?? '?'}–${n.end ?? '?'})`, field: n.fileColumn };
  if (k === 'db-column') return { t: 'staging-read', text: `נקרא מטבלת ${n.table}.${n.column}${n.alias && n.alias !== n.column ? ' AS ' + n.alias : ''}`, component: n.component };
  if (k === 'derived') return { t: 'derived', text: `Derived Column "${c}": ${n.name} = ${n.expression}`, component: n.component, manip: true };
  if (k === 'computed' || k === 'aggregate') return { t: k, text: `${c}: ${n.name}${n.aggregation ? ' (' + n.aggregation + ')' : ''}${n.expression ? ' = ' + n.expression : ''}`, component: n.component, manip: true };
  if (k === 'sort') return { t: 'sort', text: `מיון "${c}" (העברה ללא שינוי ערך)`, component: n.component };
  if (k === 'merge-join') return { t: 'merge-join', text: `Merge Join "${c}" (העברה ללא שינוי ערך)`, component: n.component };
  if (k === 'union') return { t: 'union', text: `Union All "${c}"`, component: n.component };
  if (k === 'lookup-return') return n.bridged ? { t: 'lookup', text: `ערך מוחזר מ-Lookup "${c}" (עמודה ${n.referenceColumn} מטבלת Staging שנכתבה קודם באותה חבילה)`, component: n.component } : { t: 'lookup', text: `ערך מוחזר מ-Lookup "${c}" (עמודה ${n.referenceColumn} מנתוני ה-CRM/DB)`, component: n.component, fromLookup: true };
  if (k === 'script-code') return { t: 'script', text: `Script "${c}": ${n.name} = ${n.expression || '?'}${n.condition ? ' [תנאי: ' + n.condition + ']' : ''} (${n.evidence || ''})`, component: n.component, manip: true };
  if (k === 'script-output') return { t: 'open', text: `לא נפתר: פלט Script "${c}".${n.column}`, component: n.component, open: true };
  if (k === 'sql-expression') return { t: 'staging-read', text: `נקרא כעמודה ${n.column} מהשאילתה של "${c}"${n.item ? ' (' + n.item + ')' : ''}` };
  if (k === 'derived-constant') return { t: 'constant', text: `ערך קבוע מ-Derived Column "${c}": ${n.expression}`, component: n.component };
  return { t: k, text: `${k} ${c}` };
}
function inPlaceSteps(n) { const rw = n.rwMods || []; return (n.inPlace || []).map((m) => { const r = m.use === 'script-input-readwrite' ? rw.find((x) => x.component === m.component) : null; if (r) return { t: 'in-place', component: m.component, text: 'Script "' + tail(m.component) + '" משנה את העמודה: ' + r.expression + (r.condition ? ' [תנאי: ' + r.condition + ']' : '') + ' (' + (r.evidence || '') + ')', manip: true }; return ({ t: 'in-place', component: m.component, text: m.use === 'replaced-in-place' ? `Derived Column "${tail(m.component)}" מחליף את הערך (בשורות שעוברות ברכיב זה): ${m.expression}` : m.use === 'replaced-by-lookup' ? `Lookup "${tail(m.component)}" דורס את הערך מעמודה ${m.expression} (בשורות שנמצאה להן התאמה)` : `Script "${tail(m.component)}" מקבל את העמודה לקריאה/כתיבה (ReadWrite) — ראה ממצאי הסוכן`, manip: m.use !== 'script-input-readwrite', readWrite: m.use === 'script-input-readwrite', overwritten: m.use === 'replaced-by-lookup' }); }); }
function chains(n, role, acc, steps) {
  if (!n) return; if (Array.isArray(n)) { n.forEach((x) => chains(x, role, acc, steps)); return; }
  const here = [...inPlaceSteps(n), describe(n)];
  const s = steps.concat(here);
  let r = role; if (here.some((x) => x.overwritten || x.fromLookup)) r = r === 'value' ? 'influence' : r;
  if (n.alsoFrom) n.alsoFrom.forEach((a) => chains(a.origin, a.role === 'value' ? r : 'influence', acc, steps.concat([{ t: 'merge-in', text: 'ערך נוסף נכנס לעמודה דרך "' + tail(a.via) + '": ' + a.why, manip: true }])));
  if (n.condOrigins) n.condOrigins.forEach((a) => chains(a.origin, 'influence', acc, s.concat([{ t: 'condition', text: a.why ? a.why : `משמש כתנאי (${a.role}) בחישוב העמודה ${n.name || ''} ב-"${tail(n.component)}"` }])));
  if (n.kind === 'file-field') { acc.push({ field: n.fileColumn, conn: n.connection, ordinal: n.ordinal, start: n.start, end: n.end, role: r, steps: s.slice().reverse() }); return; }
  if (n.kind === 'sql-expression') { acc.push({ field: null, db: tail(n.component) + ': ' + n.column, dbQuery: true, role: r, steps: s.slice().reverse() }); return; }
  if (n.kind === 'db-column' && !(n.writers && n.writers.length)) { acc.push({ field: null, db: n.table + '.' + n.column, role: r, steps: s.slice().reverse() }); return; }
  if (n.kind === 'script-output') { acc.push({ field: null, role: r, open: true, steps: s.slice().reverse() }); return; }
  if (n.writers) n.writers.forEach((w) => chains(w.origin, r, acc, s.concat([{ t: 'staging-write', text: `נכתב ל-Staging ע"י "${tail(w.comp)}"${w.serverMatch ? '' : ' (שרת שונה!)'}` }])));
  if (n.origin) chains(n.origin, r, acc, s);
  if (n.keyOrigins) n.keyOrigins.forEach((k) => chains(k.origin, 'influence', acc, s.concat([{ t: 'lookup-key', text: `משמש כמפתח חיפוש (${k.joinTo}) ב-Lookup "${tail(n.component)}"` }])));
}

/* ---- targets (CRM attribute → sources) ---- */
const wcBy = Object.fromEntries(L.writeComponents.map((w) => [w.component, w]));
const targets = [];
mappings.forEach(({ f, j }) => (j.crmWrites || []).forEach((cw) => {
  const w = wcBy[cw.component];
  (cw.attributes || []).forEach((a) => {
    const srcs = []; const missing = [];
    (a.from || []).forEach((fr) => {
      const inp = w ? w.inputs.find((i) => i.column === fr.column) : null;
      if (!inp) { missing.push(fr.column); return; }
      const acc = []; chains(inp.origin, fr.role === 'value' ? 'value' : 'influence', acc, [{ t: 'write-input', text: `קלט "${fr.column}" לרכיב "${tail(cw.component)}"` }]);
      if (!acc.length) acc.push({ field: null, role: fr.role, noFileOrigin: true, steps: [describe(inp.origin)] });
      acc.forEach((x) => srcs.push({ ...x, viaColumn: fr.column, declaredRole: fr.role }));
    });
    { const seen = new Set(); for (let i = srcs.length - 1; i >= 0; i--) { const k = srcs[i].role + '|' + srcs[i].conn + '|' + srcs[i].field + '|' + srcs[i].steps.map((x) => x.text).join('>'); if (seen.has(k)) srcs.splice(i, 1); else seen.add(k); } }
    (function () {
    });
    // record key columns of the write → influence ('key') on every attribute of that write
    (cw.recordKeyColumns || []).forEach((col) => { const inp = w ? w.inputs.find((i) => i.column === col) : null; if (!inp) { missing.push(col); return; }
      const acc = []; chains(inp.origin, 'influence', acc, [{ t: 'record-key', text: 'מזהה את הרשומה שמתעדכנת (מפתח רשומה "' + col + '" ברכיב "' + tail(cw.component) + '")' }]); acc.forEach((x) => srcs.push({ ...x, viaColumn: col, declaredRole: 'key' })); });
    // sources the writer's input columns cannot express (branch conditions far upstream, lookup-equivalent values) — declared with evidence
    (a.declaredSources || []).forEach((d) => srcs.push(d.db || !d.file ? { field: null, db: d.db || d.field, role: d.role === 'value' ? 'value' : 'influence', declared: true, viaColumn: null, declaredRole: d.role, steps: [{ t: 'declared', text: 'הוצהר ע"י האנליסט: ' + d.why + (d.evidence ? ' (' + d.evidence + ')' : ''), manip: d.role === 'value' }] } : { field: d.field, conn: 'Package.ConnectionManagers[' + d.file + ']', role: d.role === 'value' ? 'value' : 'influence', declared: true, viaColumn: null, declaredRole: d.role, steps: [{ t: 'declared', text: 'הוצהר ע"י האנליסט: ' + d.why + (d.evidence ? ' (' + d.evidence + ')' : ''), manip: d.role === 'value' }] }));
    (a.excludeFromValue || []).forEach((ex) => { if (!ex.field && !ex.db) { console.error('excludeFromValue without field/db ignored: ' + a.attribute); return; } let hit = 0; srcs.forEach((x) => { const match = ex.db ? (x.db === ex.db) : (x.field != null && x.field === ex.field); if (match && x.role === 'value') { hit++; x.role = 'influence'; x.steps = x.steps.concat([{ t: 'declared', text: 'הערך לא יכול להגיע ליעד: ' + ex.why + (ex.evidence ? ' (' + ex.evidence + ')' : '') }]); } }); if (!hit) console.error('excludeFromValue matched no value source: ' + a.attribute + ' ' + (ex.db || ex.field)); });
    { const seen2 = new Set(); for (let i = srcs.length - 1; i >= 0; i--) { const k = srcs[i].role + '|' + srcs[i].conn + '|' + srcs[i].field + '|' + srcs[i].steps.map((x) => x.text).join('>'); if (seen2.has(k)) srcs.splice(i, 1); else seen2.add(k); } }
    targets.push({
      disabled: !!cw.disabled, entity: cw.entity, attribute: a.attribute, verb: cw.verb, mechanism: cw.mechanism, status: cw.status, component: cw.component, dataFlow: dfName(cw.component), identicalCopies: cw.identicalCopies || [],
      rowFilters: (w ? (w.rowFilters || []).map((x) => ({ component: tail(x.component), kind: x.kind, output: x.output, leads: x.leads, expression: x.expression, fileFields: x.fileFields, fileKeys: x.fileKeys })) : []).concat((cw.declaredRowFilters || []).map((d) => ({ component: d.via, kind: 'declared', output: null, expression: d.why + (d.evidence ? ' (' + d.evidence + ')' : ''), fileFields: [d.field], fileKeys: ['Package.ConnectionManagers[' + d.file + ']::' + d.field] }))).reduce((acc, x) => { const k = [x.component, x.kind, x.output, x.expression].join('\u0001'); const o = acc.find((y) => y._k === k); if (o) { o.fileFields = [...new Set([...(o.fileFields || []), ...(x.fileFields || [])])]; o.fileKeys = [...new Set([...(o.fileKeys || []), ...(x.fileKeys || [])])]; } else acc.push({ ...x, _k: k }); return acc; }, []).map(({ _k, ...x }) => x).filter((x) => !(cw.suppressedRowFilters || []).some((sf) => tail(sf.component) === tail(x.component) && (!sf.output || sf.output === x.output))), rowFiltersSuppressed: (cw.suppressedRowFilters || []).map((sf) => ({ component: tail(sf.component), output: sf.output || null, why: sf.why, evidence: sf.evidence || '' })),
      recordKey: cw.recordKey || null, writeCondition: cw.condition || null, expression: a.expression || null, fixedValue: a.fixedValue ?? null, attrCondition: a.condition || null, evidence: a.evidence || cw.evidence,
      valueSources: srcs.filter((s) => s.role === 'value' && s.field), influenceSources: srcs.filter((s) => s.role !== 'value' && s.field), dbSources: srcs.filter((s) => s.db), openSources: srcs.filter((s) => s.open), nonFile: srcs.filter((s) => s.noFileOrigin), missingInputs: missing, analystFile: f,
    });
  });
}));

targets.forEach((t) => { const cw = mappings.flatMap((m) => m.j.crmWrites || []).find((x) => x.component === t.component && x.entity === t.entity && x.verb === t.verb); const a = cw && (cw.attributes || []).find((x) => x.attribute === t.attribute); const declared = ((a && a.additionalFileFields) || []).map((x) => x.field); const derived = new Set([...t.valueSources, ...t.influenceSources].map((x) => x.field)); t.crossCheck = { agentAdditional: declared, missingInTool: declared.filter((x) => !derived.has(x)) }; });
/* ---- sources (file field → CRM targets / disposition) ---- */
const sources = [];
const writerNames = new Set(mappings.flatMap((m) => (m.j.crmWrites || []).flatMap((c) => [c.component, ...(c.identicalCopies || [])])).map(tail));
L.files.forEach((fl) => fl.fields.forEach((fd) => {
  const hits = []; targets.forEach((t) => [...t.valueSources.map((s) => ({ s, role: 'value' })), ...t.influenceSources.map((s) => ({ s, role: 'influence' }))].forEach(({ s, role }) => { if (s.field === fd.name && s.conn === fl.connection) hits.push({ entity: t.entity, attribute: t.attribute, verb: t.verb, status: t.status, component: t.component, role, steps: s.steps }); }));
  const uses = {}; fd.paths.forEach((p) => { const u = p.terminal; const k = u.use + (u.use === 'db-write' ? ':' + u.table : ''); (uses[k] = uses[k] || new Set()).add(tail(u.component)); });
  const useSummary = Object.fromEntries(Object.entries(uses).map(([k, v]) => [k, [...v]]));
  let disposition;
  const filterHits = []; const fseen = new Set(); targets.forEach((t) => (t.rowFilters || []).forEach((rf) => { if ((rf.fileKeys || []).includes(fl.connection + '::' + fd.name)) { const k = t.entity + '|' + t.verb + '|' + rf.component; if (!fseen.has(k)) { fseen.add(k); filterHits.push({ entity: t.entity, verb: t.verb, status: t.status, component: t.component, via: rf.component, kind: rf.kind, expression: rf.expression }); } } }));
  if (hits.some((h) => h.role === 'value')) disposition = 'crm_value';
  else if (hits.length) disposition = 'crm_influence_only';
  else if (filterHits.length) disposition = 'crm_row_filter';
  else if (!fd.exposedToDataFlow) disposition = 'not_exposed';
  else disposition = null;
  const readBack = fd.paths.some((p) => p.trail.some((s) => s.bridge));
  if (!disposition && fd.exposedToDataFlow) {
    const nonStage = Object.keys(useSummary).filter((k) => !k.startsWith('db-write'));
    const reachesWriter = Object.entries(useSummary).some(([k, v]) => /^script-input|^sql-param/.test(k) && v.some((c) => writerNames.has(c)));
    disposition = !fd.paths.length ? 'not_used' : reachesWriter ? 'writer_input_unmapped' : nonStage.length ? 'logic_only_no_crm' : readBack ? 'read_no_use' : 'staging_only';
  }
  sources.push({ file: (fl.connection || '').replace(/^Package\.ConnectionManagers\[|\]$/g, ''), connection: fl.connection, ordinal: fd.ordinal, field: fd.name, start: fd.start, end: fd.end, width: fd.width, dataType: fd.dataType, exposed: fd.exposedToDataFlow, readBackFromStaging: readBack, disposition, crm: hits, rowFilterOf: filterHits, uses: useSummary });
}));

const stats = {
  fileFields: sources.length, crmValue: sources.filter((s) => s.disposition === 'crm_value').length, crmInfluenceOnly: sources.filter((s) => s.disposition === 'crm_influence_only').length, crmRowFilter: sources.filter((s) => s.disposition === 'crm_row_filter').length,
  logicOnly: sources.filter((s) => s.disposition === 'logic_only_no_crm').length, writerInputUnmapped: sources.filter((s) => s.disposition === 'writer_input_unmapped').length, readNoUse: sources.filter((s) => s.disposition === 'read_no_use').length, stagingOnly: sources.filter((s) => s.disposition === 'staging_only').length, notUsed: sources.filter((s) => s.disposition === 'not_used').length, notExposed: sources.filter((s) => s.disposition === 'not_exposed').length,
  crmAttributesWritten: targets.filter((t) => !t.disabled).length, crmAttributesDisabled: targets.filter((t) => t.disabled).length, targetsFromFile: targets.filter((t) => t.valueSources.length).length, targetsFromDb: targets.filter((t) => !t.valueSources.length && (t.dbSources || []).some((x) => x.role === 'value')).length, targetsWithOpenSources: targets.filter((t) => t.openSources.length).length, targetsMissingInputs: targets.filter((t) => t.missingInputs.length).length,
  scriptResolutions: scriptOutputs.length, readWriteResolutions: readWrite.length, readWriteUnstructured: rwUnstructured.length, crossCheckMismatches: targets.filter((t) => t.crossCheck.missingInTool.length).length, openItemsRemaining: L.openItems.length,
};
const stepDict = []; const stepIdx = new Map();
const enc = (st) => (st || []).map((x) => { const k = JSON.stringify([x.text, !!x.manip, !!x.open, x.t || '']); if (!stepIdx.has(k)) { stepIdx.set(k, stepDict.length); stepDict.push({ text: x.text, t: x.t || null, manip: !!x.manip, open: !!x.open }); } return stepIdx.get(k); });
targets.forEach((t) => ['valueSources', 'influenceSources', 'openSources', 'nonFile', 'dbSources'].forEach((k) => t[k].forEach((x) => { x.steps = enc(x.steps); })));
sources.forEach((x) => { const seen = new Set(); x.crm = x.crm.filter((c) => { const k = c.role + '|' + c.component + '|' + c.entity + '|' + c.attribute + '|' + c.steps.map((y) => y.text).join('>'); if (seen.has(k)) return false; seen.add(k); return true; }); x.crm.forEach((c) => { c.steps = enc(c.steps); }); });
fs.writeFileSync(path.join(dir, 'fieldmap.json'), JSON.stringify({ package: pkg, source: L.source, stats, stepDict, targets, sources, openItems: L.openItems, unresolved: mappings.flatMap((m) => m.j.unresolved || []), notes: mappings.flatMap((m) => (m.j.notes || []).map((n) => ({ file: m.f, note: n }))), lookupBridges: mappings.flatMap((m) => m.j.lookupBridges || []) }, null, 1));
console.log(JSON.stringify(stats, null, 1));
