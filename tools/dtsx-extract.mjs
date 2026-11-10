#!/usr/bin/env node
// Deterministic DTSX evidence extractor.
// Usage: node tools/dtsx-extract.mjs <file.dtsx> <out.json> [relativePathRoot]
// Produces facts only (no interpretation). Every object carries refId + line.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const EXTRACTOR = { name: 'dtsx-extract', version: '0.2.0' };

/* ---------------- strict XML parser with line numbers ---------------- */
function parseXml(src) {
  const lineStarts = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) lineStarts.push(i + 1);
  const lineOf = (pos) => { let lo = 0, hi = lineStarts.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (lineStarts[m] <= pos) lo = m; else hi = m - 1; } return lo + 1; };
  const ENT = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
  const decode = (s) => s.indexOf('&') < 0 ? s : s.replace(/&([^;\s&]*);/g, (m, e) => {
    if (e[0] === '#') { const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); if (!Number.isFinite(cp)) throw new Error('Bad char ref ' + m); return String.fromCodePoint(cp); }
    if (!(e in ENT)) throw new Error('Unknown entity ' + m); return ENT[e];
  });
  const root = { name: '#root', attrs: {}, children: [], text: '', line: 0 };
  const stack = [root];
  let i = src.charCodeAt(0) === 0xfeff ? 1 : 0;
  const addText = (t) => { stack[stack.length - 1].text += t; };
  const isWs = (c) => c === ' ' || c === '\n' || c === '\r' || c === '\t';
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt < 0) { addText(decode(src.slice(i))); break; }
    if (lt > i) addText(decode(src.slice(i, lt)));
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); if (e < 0) throw new Error('Unclosed comment @' + lineOf(lt)); i = e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); if (e < 0) throw new Error('Unclosed CDATA @' + lineOf(lt)); addText(src.slice(lt + 9, e)); i = e + 3; continue; }
    if (src.startsWith('<?', lt)) { const e = src.indexOf('?>', lt + 2); if (e < 0) throw new Error('Unclosed PI'); i = e + 2; continue; }
    if (src.startsWith('<!', lt)) throw new Error('DOCTYPE/declaration not supported @' + lineOf(lt));
    if (src[lt + 1] === '/') {
      const e = src.indexOf('>', lt); const name = src.slice(lt + 2, e).trim(); const top = stack.pop();
      if (!top || top.name !== name) throw new Error(`Mismatched end tag </${name}> vs <${top && top.name}> @${lineOf(lt)}`);
      i = e + 1; continue;
    }
    let j = lt + 1; while (j < src.length && !isWs(src[j]) && src[j] !== '>' && src[j] !== '/') j++;
    const node = { name: src.slice(lt + 1, j), attrs: {}, children: [], text: '', line: lineOf(lt) };
    let selfClose = false;
    for (;;) {
      while (isWs(src[j])) j++;
      if (src[j] === '>') { j++; break; }
      if (src[j] === '/' && src[j + 1] === '>') { selfClose = true; j += 2; break; }
      const ns = j; while (j < src.length && src[j] !== '=' && !isWs(src[j])) j++;
      const an = src.slice(ns, j); while (isWs(src[j])) j++;
      if (src[j] !== '=') throw new Error('Attr without value ' + an + ' @' + node.line); j++; while (isWs(src[j])) j++;
      const q = src[j]; if (q !== '"' && q !== "'") throw new Error('Unquoted attr ' + an + ' @' + node.line);
      const ve = src.indexOf(q, j + 1); if (ve < 0) throw new Error('Unclosed attr');
      if (an in node.attrs) throw new Error('Duplicate attr ' + an + ' @' + node.line);
      node.attrs[an] = decode(src.slice(j + 1, ve)); j = ve + 1;
    }
    stack[stack.length - 1].children.push(node);
    if (!selfClose) stack.push(node);
    i = j;
  }
  if (stack.length !== 1) throw new Error('Unclosed element <' + stack[stack.length - 1].name + '>');
  return { root, lines: lineStarts.length };
}

/* ---------------- helpers ---------------- */
const kids = (n, name) => (n ? n.children.filter((c) => c.name === name) : []);
const kid = (n, name) => (n ? n.children.find((c) => c.name === name) : undefined);
const A = (n, a) => (n ? n.attrs[a] : undefined);
function walk(n, fn, parent = null) { fn(n, parent); n.children.forEach((c) => walk(c, fn, n)); }
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const mask = (s) => s == null ? s : String(s).replace(/((?:password|pwd)\s*=\s*)("[^"]*"|'[^']*'|[^;]*)/gi, '$1***MASKED***');
// Generic lossless-ish capture of an XML subtree (binary payloads replaced by size+hash).
function capture(n, depth = 0) {
  const o = { el: n.name, line: n.line };
  if (Object.keys(n.attrs).length) { o.attrs = {}; for (const [k, v] of Object.entries(n.attrs)) o.attrs[k] = /password|pwd/i.test(k) ? '***MASKED***' : mask(v); }
  const t = n.text.trim();
  if (t) {
    if (n.name === 'BinaryItem' || (t.length > 2000 && /^[A-Za-z0-9+/=\s]+$/.test(t))) o.binary = { chars: t.length, sha256: sha(t) };
    else o.text = mask(t);
  }
  if (n.children.length) o.children = n.children.map((c) => capture(c, depth + 1));
  return o;
}
const PC_VALUE = { 0: 'Success', 1: 'Failure', 2: 'Completion' };
const PC_EVAL = { 1: 'Expression', 2: 'Constraint', 3: 'ExpressionAndConstraint', 4: 'ExpressionOrConstraint' };

/* ---------------- extraction ---------------- */
function extract(file, relRoot) {
  const buf = fs.readFileSync(file);
  const src = buf.toString('utf8');
  const { root, lines } = parseXml(src);
  const pkg = root.children.find((c) => c.name === 'DTS:Executable');
  if (!pkg) throw new Error('No root DTS:Executable');

  // raw counts (independent walk) for coverage reconciliation
  const raw = { elements: 0, executables: 0, precedenceConstraints: 0, eventHandlers: 0, connectionManagers: 0, variables: 0, components: 0, paths: 0, inputColumns: 0, outputColumns: 0, externalMetadataColumns: 0, projectItems: 0, sourceCodeProps: 0, disabledExecutables: 0, sourceCodeArrayDeclared: 0, sourceCodeElements: 0, logProviders: 0, loggingOptions: 0, flatFileColumns: 0, forEachVariableMappings: 0 };
  // Safety net: every DTS:* element type present must be one the extractor knowingly handles.
  const HANDLED_DTS = new Set(['DTS:Executable', 'DTS:Executables', 'DTS:Property', 'DTS:ConnectionManagers', 'DTS:ConnectionManager', 'DTS:ObjectData', 'DTS:Configurations', 'DTS:Configuration',
    'DTS:LogProviders', 'DTS:LogProvider', 'DTS:LoggingOptions', 'DTS:SelectedLogProviders', 'DTS:SelectedLogProvider', 'DTS:Variables', 'DTS:Variable', 'DTS:VariableValue',
    'DTS:PrecedenceConstraints', 'DTS:PrecedenceConstraint', 'DTS:EventHandlers', 'DTS:EventHandler', 'DTS:PropertyExpression', 'DTS:DesignTimeProperties', 'DTS:FlatFileColumns', 'DTS:FlatFileColumn', 'DTS:ForEachEnumerator', 'DTS:ForEachVariableMappings', 'DTS:ForEachVariableMapping']);
  const dtsTypes = {};
  walk(root, (n) => {
    if (n === root) return; raw.elements++;
    if (n.name.startsWith('DTS:')) dtsTypes[n.name] = (dtsTypes[n.name] || 0) + 1;
    switch (n.name) {
      case 'DTS:Executable': raw.executables++; if (A(n, 'DTS:Disabled') === 'True') raw.disabledExecutables++; break;
      case 'DTS:PrecedenceConstraint': raw.precedenceConstraints++; break;
      case 'DTS:EventHandler': raw.eventHandlers++; break;
      case 'DTS:ConnectionManager': if (A(n, 'DTS:refId')) raw.connectionManagers++; break;
      case 'DTS:Variable': raw.variables++; break;
      case 'component': raw.components++; break;
      case 'path': raw.paths++; break;
      case 'inputColumn': raw.inputColumns++; break;
      case 'outputColumn': raw.outputColumns++; break;
      case 'externalMetadataColumn': raw.externalMetadataColumns++; break;
      case 'ProjectItem': raw.projectItems++; break;
      case 'DTS:LogProvider': raw.logProviders++; break;
      case 'DTS:FlatFileColumn': raw.flatFileColumns++; break;
      case 'DTS:ForEachVariableMapping': raw.forEachVariableMappings++; break;
      case 'DTS:LoggingOptions': raw.loggingOptions++; break;
      case 'property': if (A(n, 'name') === 'SourceCode') { raw.sourceCodeProps++; const ae = kid(n, 'arrayElements'); raw.sourceCodeArrayDeclared += ae ? Number(A(ae, 'arrayElementCount')) : 0; } break;
    }
  });

  const out = {
    schema: 'dtsx-evidence/0.1', extractor: EXTRACTOR, extractedAt: new Date().toISOString(),
    source: { file: path.basename(file), relativePath: relRoot ? path.relative(relRoot, file).replace(/\\/g, '/') : path.basename(file), sha256: crypto.createHash('sha256').update(buf).digest('hex').toUpperCase(), bytes: buf.length, lines },
    package: {}, connectionManagers: [], configurations: [], variables: [], executables: [], precedenceConstraints: [], dataFlows: [], codeFiles: [], sqlStatements: [], candidates: { code: [], sql: [] }, coverage: {},
  };

  // package properties
  const props = {}; kids(pkg, 'DTS:Property').forEach((p) => { props[A(p, 'DTS:Name')] = p.text.trim(); });
  out.package = { refId: A(pkg, 'DTS:refId'), objectName: A(pkg, 'DTS:ObjectName'), dtsId: A(pkg, 'DTS:DTSID'), creationDate: A(pkg, 'DTS:CreationDate'), versionBuild: A(pkg, 'DTS:VersionBuild'), versionGuid: A(pkg, 'DTS:VersionGUID'), lastModifiedProductVersion: A(pkg, 'DTS:LastModifiedProductVersion'), packageFormatVersion: props.PackageFormatVersion, protectionLevel: A(pkg, 'DTS:ProtectionLevel') ?? '(default)', line: pkg.line };

  // connection managers
  const cmByDtsId = {};
  walk(pkg, (n) => {
    if (n.name !== 'DTS:ConnectionManager' || !A(n, 'DTS:refId')) return;
    const inner = kid(kid(n, 'DTS:ObjectData'), 'DTS:ConnectionManager');
    const cm = { refId: A(n, 'DTS:refId'), name: A(n, 'DTS:ObjectName'), creationName: A(n, 'DTS:CreationName'), dtsId: A(n, 'DTS:DTSID'), line: n.line,
      connectionString: mask(A(inner, 'DTS:ConnectionString') ?? null),
      propertyExpressions: kids(n, 'DTS:PropertyExpression').map((p) => ({ property: A(p, 'DTS:Name'), expression: p.text.trim(), line: p.line })),
      objectData: kid(n, 'DTS:ObjectData') ? capture(kid(n, 'DTS:ObjectData')) : null };
    if (inner && kid(inner, 'DTS:FlatFileColumns')) {
      // Physical file layout (ordinal + coordinates). ColumnWidth applies to fixed-width columns;
      // a column with a ColumnDelimiter (e.g. last column of RaggedRight) has variable length.
      let pos = 1, variable = false;
      const cols = kids(kid(inner, 'DTS:FlatFileColumns'), 'DTS:FlatFileColumn').map((fc, i) => {
        const width = Number(A(fc, 'DTS:ColumnWidth') ?? 0), delim = A(fc, 'DTS:ColumnDelimiter') ?? '';
        const c = { ordinal: i + 1, name: A(fc, 'DTS:ObjectName'), dtsId: A(fc, 'DTS:DTSID'), columnType: A(fc, 'DTS:ColumnType') ?? null, columnWidth: width, maximumWidth: Number(A(fc, 'DTS:MaximumWidth') ?? 0), dataType: A(fc, 'DTS:DataType') ?? null, dataPrecision: A(fc, 'DTS:DataPrecision') ?? null, dataScale: A(fc, 'DTS:DataScale') ?? null, columnDelimiter: delim, textQualified: A(fc, 'DTS:TextQualified') ?? null, line: fc.line };
        if (!variable && !delim && width > 0) { c.start = pos; c.end = pos + width - 1; pos += width; }
        else { c.start = variable ? null : pos; c.end = null; c.positionNote = delim ? 'delimited (' + delim + ') — variable length' : 'position not derivable'; variable = true; }
        return c;
      });
      cm.flatFile = { format: A(inner, 'DTS:Format'), codePage: A(inner, 'DTS:CodePage'), localeId: A(inner, 'DTS:LocaleID'), unicode: A(inner, 'DTS:Unicode') ?? null, headerRowsToSkip: A(inner, 'DTS:HeaderRowsToSkip') ?? '0', dataRowsToSkip: A(inner, 'DTS:DataRowsToSkip') ?? '0', columnNamesInFirstDataRow: A(inner, 'DTS:ColumnNamesInFirstDataRow') ?? null, headerRowDelimiter: A(inner, 'DTS:HeaderRowDelimiter') ?? null, rowDelimiter: A(inner, 'DTS:RowDelimiter') ?? null, textQualifier: A(inner, 'DTS:TextQualifier') ?? null, columns: cols };
      raw.flatFileColumnsExtracted = (raw.flatFileColumnsExtracted || 0) + cols.length;
    }
    out.connectionManagers.push(cm); cmByDtsId[cm.dtsId] = cm.refId;
  });
  // configurations
  walk(pkg, (n) => { if (n.name === 'DTS:Configuration') out.configurations.push({ name: A(n, 'DTS:ObjectName'), type: A(n, 'DTS:ConfigurationType'), configurationString: A(n, 'DTS:ConfigurationString'), variable: A(n, 'DTS:ConfigurationVariable') ?? null, line: n.line }); });

  // log providers (a write side effect: SSIS logging into a DB/file)
  out.logProviders = kids(kid(pkg, 'DTS:LogProviders'), 'DTS:LogProvider').map((lp) => ({ name: A(lp, 'DTS:ObjectName'), creationName: A(lp, 'DTS:CreationName'), dtsId: A(lp, 'DTS:DTSID'), configString: A(lp, 'DTS:ConfigString') ?? null, line: lp.line }));
  const LOGMODE = { 0: 'UseParentSetting', 1: 'Enabled', 2: 'Disabled' };
  function loggingOf(n) {
    const lo = kid(n, 'DTS:LoggingOptions'); if (!lo) return null;
    const ef = kids(lo, 'DTS:Property').find((p) => A(p, 'DTS:Name') === 'EventFilter');
    let events = null; if (ef) { const parts = ef.text.trim().split(','); events = []; for (let i = 1; i + 1 < parts.length; i += 2) events.push(parts[i + 1]); }
    return { mode: LOGMODE[A(lo, 'DTS:LoggingMode') ?? '0'] ?? A(lo, 'DTS:LoggingMode'), filterKind: A(lo, 'DTS:FilterKind') ?? null, events, selectedProviders: kids(kid(lo, 'DTS:SelectedLogProviders'), 'DTS:SelectedLogProvider').map((s) => A(s, 'DTS:InstanceID')), line: lo.line };
  }
  out.package.logging = loggingOf(pkg);

  // executables (recursive, including event handlers) + variables + constraints
  function scopeOf(n) { return A(n, 'DTS:refId') || A(n, 'DTS:ObjectName'); }
  function visitContainer(c, parentRef, kind) {
    const ref = scopeOf(c);
    kids(kid(c, 'DTS:Variables'), 'DTS:Variable').forEach((v) => {
      const vv = kid(v, 'DTS:VariableValue');
      out.variables.push({ scope: ref, namespace: A(v, 'DTS:Namespace'), name: A(v, 'DTS:ObjectName'), dataType: A(vv, 'DTS:DataType') ?? null, value: vv ? mask(vv.text.trim()) : null, expression: A(v, 'DTS:Expression') ?? null, evaluateAsExpression: A(v, 'DTS:EvaluateAsExpression') === 'True', line: v.line });
    });
    kids(kid(c, 'DTS:PrecedenceConstraints'), 'DTS:PrecedenceConstraint').forEach((p) => {
      const val = A(p, 'DTS:Value') ?? '0', ev = A(p, 'DTS:EvalOp') ?? '2';
      out.precedenceConstraints.push({ container: ref, refId: A(p, 'DTS:refId'), from: A(p, 'DTS:From'), to: A(p, 'DTS:To'), value: PC_VALUE[val] ?? val, evalOp: PC_EVAL[ev] ?? ev, expression: A(p, 'DTS:Expression') ?? null, logicalAnd: A(p, 'DTS:LogicalAnd') === 'True', /* the serializer omits defaults (Value=0/EvalOp=2 never appear); LogicalAnd="True" is always explicit, so a missing attribute means OR */ disabled: A(p, 'DTS:Disabled') === 'True', line: p.line, defaultsApplied: { value: A(p, 'DTS:Value') == null, evalOp: A(p, 'DTS:EvalOp') == null } });
    });
    kids(kid(c, 'DTS:Executables'), 'DTS:Executable').forEach((e, idx) => visitExecutable(e, ref, kind, idx));
    kids(kid(c, 'DTS:EventHandlers'), 'DTS:EventHandler').forEach((h) => {
      const hr = A(h, 'DTS:refId');
      out.executables.push({ refId: hr, name: A(h, 'DTS:EventName'), type: 'EventHandler', parent: ref, context: 'event-handler', disabled: A(h, 'DTS:Disabled') === 'True', line: h.line, xmlOrder: null, logging: loggingOf(h) });
      visitContainer(h, hr, 'event-handler');
    });
  }
  function visitExecutable(e, parentRef, ctx, idx) {
    const type = A(e, 'DTS:ExecutableType') || A(e, 'DTS:CreationName');
    const ex = { refId: A(e, 'DTS:refId'), name: A(e, 'DTS:ObjectName'), type, description: A(e, 'DTS:Description') ?? null, dtsId: A(e, 'DTS:DTSID'), parent: parentRef, context: ctx, disabled: A(e, 'DTS:Disabled') === 'True', line: e.line, xmlOrder: idx,
      propertyExpressions: kids(e, 'DTS:PropertyExpression').map((p) => ({ property: A(p, 'DTS:Name'), expression: p.text.trim(), line: p.line })),
      logging: loggingOf(e), forLoop: null, foreach: null };
    const fe = kid(e, 'DTS:ForEachEnumerator');
    if (fe) ex.foreach = { enumerator: A(fe, 'DTS:CreationName'), objectData: kid(fe, 'DTS:ObjectData') ? capture(kid(fe, 'DTS:ObjectData')) : null, line: fe.line,
      variableMappings: kids(kid(e, 'DTS:ForEachVariableMappings'), 'DTS:ForEachVariableMapping').map((m) => ({ variable: A(m, 'DTS:VariableName'), valueIndex: A(m, 'DTS:ValueIndex'), line: m.line })) };
    if (/ForLoop/i.test(type)) ex.forLoop = { init: A(e, 'DTS:InitExpression') ?? null, eval: A(e, 'DTS:EvalExpression') ?? null, assign: A(e, 'DTS:AssignExpression') ?? null };
    const od = kid(e, 'DTS:ObjectData');
    if (/ExecuteSQLTask/i.test(type)) {
      const t = od && od.children[0];
      if (t) { const sql = { owner: ex.refId, kind: 'ExecuteSQLTask', connection: cmByDtsId[A(t, 'SQLTask:Connection')] || A(t, 'SQLTask:Connection'), sqlSourceType: A(t, 'SQLTask:SqlStmtSourceType') ?? 'DirectInput', text: A(t, 'SQLTask:SqlStatementSource') ?? null, resultType: A(t, 'SQLTask:ResultType') ?? null, line: t.line,
          parameterBindings: kids(t, 'SQLTask:ParameterBinding').map((b) => ({ parameterName: A(b, 'SQLTask:ParameterName'), variable: A(b, 'SQLTask:DtsVariableName'), direction: A(b, 'SQLTask:ParameterDirection'), dataType: A(b, 'SQLTask:DataType'), line: b.line })),
          resultBindings: kids(t, 'SQLTask:ResultBinding').map((b) => ({ resultName: A(b, 'SQLTask:ResultName'), variable: A(b, 'SQLTask:DtsVariableName'), line: b.line })) };
        out.sqlStatements.push(sql); ex.sql = sql.text; }
    }
    if (/ScriptTask/i.test(type) && od) {
      const sp = kid(od, 'ScriptProject');
      if (sp) { ex.script = { language: A(sp, 'Language'), projectName: A(sp, 'Name'), readOnlyVariables: A(sp, 'ReadOnlyVariables') ?? null, readWriteVariables: A(sp, 'ReadWriteVariables') ?? null, entryPoint: A(sp, 'EntryPoint') ?? null };
        kids(sp, 'ProjectItem').forEach((pi) => addCode(ex.refId, 'ScriptTask', A(pi, 'Name'), pi.text, pi.line));
        ex.script.binaryItems = kids(sp, 'BinaryItem').map((b) => ({ name: A(b, 'Name'), chars: b.text.trim().length, sha256: sha(b.text.trim()) })); }
    }
    if (od && !/Pipeline/i.test(type)) ex.objectData = capture(od);
    if (/Pipeline/i.test(type)) out.dataFlows.push(extractPipeline(ex.refId, kid(od, 'pipeline')));
    out.executables.push(ex);
    visitContainer(e, ex.refId, ctx);
  }

  function propsOf(n) {
    const o = {};
    kids(kid(n, 'properties'), 'property').forEach((p) => {
      const ae = kid(p, 'arrayElements');
      const v = ae ? kids(ae, 'arrayElement').map((x) => x.text) : p.text.trim();
      o[A(p, 'name')] = { value: ae ? v : mask(v), dataType: A(p, 'dataType') ?? null, typeConverter: A(p, 'typeConverter') ?? null, line: p.line, ...(A(p, 'expressionType') ? { expressionType: A(p, 'expressionType') } : {}) };
    });
    return o;
  }
  function extractPipeline(taskRef, pl) {
    const df = { task: taskRef, components: [], paths: [], lineage: [] };
    if (!pl) return df;
    kids(kid(pl, 'components'), 'component').forEach((c, idx) => {
      const p = propsOf(c);
      const comp = { refId: A(c, 'refId'), name: A(c, 'name'), classId: A(c, 'componentClassID'), description: A(c, 'description') ?? null, version: A(c, 'version') ?? null, xmlOrder: idx, line: c.line, disabled: false,
        userComponentTypeName: p.UserComponentTypeName ? p.UserComponentTypeName.value : null, attrs: { ...c.attrs }, properties: {}, connections: [], inputs: [], outputs: [] };
      for (const [k, v] of Object.entries(p)) { if (k === 'SourceCode' || k === 'BinaryCode') continue; comp.properties[k] = v; }
      if (p.SourceCode) {
        // Layout is triplets: [fileName, encoding, content]. Verify instead of assuming.
        const arr = p.SourceCode.value, ENC = /^(UTF8|UTF16LE|UTF16BE|UTF7|ASCII|Unicode|Default)$/i;
        let ok = arr.length % 3 === 0; for (let i = 0; ok && i < arr.length; i += 3) ok = ENC.test(arr[i + 1].trim());
        if (!ok) throw new Error('Unexpected SourceCode layout in ' + comp.refId + ' (len ' + arr.length + ')');
        for (let i = 0; i < arr.length; i += 3) addCode(comp.refId, 'ScriptComponent', arr[i].trim(), arr[i + 2], p.SourceCode.line, arr[i + 1].trim());
        raw.sourceCodeElements += arr.length;
      }
      if (p.BinaryCode) comp.binaryCode = (Array.isArray(p.BinaryCode.value) ? p.BinaryCode.value : [p.BinaryCode.value]).map((x) => ({ chars: x.length, sha256: sha(x) }));
      kids(kid(c, 'connections'), 'connection').forEach((x) => comp.connections.push({ refId: A(x, 'refId'), name: A(x, 'name'), connectionManagerRefId: A(x, 'connectionManagerRefId') || A(x, 'connectionManagerID'), line: x.line }));
      kids(kid(c, 'inputs'), 'input').forEach((inp) => comp.inputs.push({ refId: A(inp, 'refId'), name: A(inp, 'name'), errorRowDisposition: A(inp, 'errorRowDisposition') ?? null, attrs: { ...inp.attrs }, line: inp.line, properties: propsOf(inp),
        inputColumns: kids(kid(inp, 'inputColumns'), 'inputColumn').map((ic) => ({ refId: A(ic, 'refId'), cachedName: A(ic, 'cachedName'), lineageId: A(ic, 'lineageId'), usageType: A(ic, 'usageType') ?? null, cachedDataType: A(ic, 'cachedDataType') ?? null, cachedLength: A(ic, 'cachedLength') ?? null, externalMetadataColumnId: A(ic, 'externalMetadataColumnId') ?? null, properties: propsOf(ic), line: ic.line })),
        externalMetadataColumns: kids(kid(inp, 'externalMetadataColumns'), 'externalMetadataColumn').map(emc) }));
      kids(kid(c, 'outputs'), 'output').forEach((o) => comp.outputs.push({ refId: A(o, 'refId'), name: A(o, 'name'), isErrorOut: A(o, 'isErrorOut') === 'true', errorRowDisposition: A(o, 'errorRowDisposition') ?? null, truncationRowDisposition: A(o, 'truncationRowDisposition') ?? null, attrs: { ...o.attrs }, exclusionGroup: A(o, 'exclusionGroup') ?? null, synchronousInputId: A(o, 'synchronousInputId') ?? null, isSorted: A(o, 'isSorted') ?? null, line: o.line, properties: propsOf(o),
        outputColumns: kids(kid(o, 'outputColumns'), 'outputColumn').map((oc) => ({ refId: A(oc, 'refId'), name: A(oc, 'name'), lineageId: A(oc, 'lineageId'), sortKeyPosition: A(oc, 'sortKeyPosition') ?? null, dataType: A(oc, 'dataType') ?? null, length: A(oc, 'length') ?? null, precision: A(oc, 'precision') ?? null, scale: A(oc, 'scale') ?? null, codePage: A(oc, 'codePage') ?? null, externalMetadataColumnId: A(oc, 'externalMetadataColumnId') ?? null, errorOrTruncationOperation: A(oc, 'errorOrTruncationOperation') ?? null, errorRowDisposition: A(oc, 'errorRowDisposition') ?? null, specialFlags: A(oc, 'specialFlags') ?? null, properties: propsOf(oc), line: oc.line })),
        externalMetadataColumns: kids(kid(o, 'externalMetadataColumns'), 'externalMetadataColumn').map(emc) }));
      for (const k of ['SqlCommand', 'SqlCommandParam']) if (comp.properties[k] && typeof comp.properties[k].value === 'string' && comp.properties[k].value) out.sqlStatements.push({ owner: comp.refId, kind: comp.classId + '.' + k, connection: comp.connections.map((x) => x.connectionManagerRefId).join(',') || null, text: comp.properties[k].value, line: comp.properties[k].line });
      df.components.push(comp);
    });
    kids(kid(pl, 'paths'), 'path').forEach((p) => df.paths.push({ refId: A(p, 'refId'), name: A(p, 'name'), startId: A(p, 'startId'), endId: A(p, 'endId'), line: p.line }));
    // lineage: each inputColumn -> producing outputColumn (by lineageId string)
    const producers = {}; df.components.forEach((c) => c.outputs.forEach((o) => o.outputColumns.forEach((oc) => { producers[oc.lineageId] = { component: c.refId, output: o.refId, column: oc.refId, name: oc.name }; })));
    df.components.forEach((c) => c.inputs.forEach((i) => i.inputColumns.forEach((ic) => df.lineage.push({ consumer: c.refId, input: i.refId, inputColumn: ic.refId, cachedName: ic.cachedName, usageType: ic.usageType, lineageId: ic.lineageId, producer: producers[ic.lineageId] || null }))));
    df.unresolvedLineage = df.lineage.filter((l) => !l.producer).length;
    return df;
  }
  const emc = (m) => ({ refId: A(m, 'refId'), name: A(m, 'name'), dataType: A(m, 'dataType') ?? null, length: A(m, 'length') ?? null, precision: A(m, 'precision') ?? null, scale: A(m, 'scale') ?? null, codePage: A(m, 'codePage') ?? null, line: m.line });

  function addCode(owner, kind, name, text, line, encoding) {
    const t = text.replace(/^\r?\n/, '');
    const isCode = /\.(cs|vb)$/i.test(name);
    const generated = isCode && (/\.Designer\.|AssemblyInfo|^BufferWrapper\.|^ComponentWrapper\./i.test(name) || /THIS IS AUTO-GENERATED CODE/.test(t.slice(0, 200)));
    const f = { owner, kind, name, encoding: encoding || null, lineInDtsx: line, sha256: sha(t), lines: t.split(/\r?\n/).length, isSource: isCode && !generated, generated, text: t };
    out.codeFiles.push(f);
  }

  // root container
  visitContainer(pkg, out.package.refId, 'control-flow');

  // external assembly references declared by script projects (dependency inventory)
  const FRAMEWORK = /^(System(\.|$)|Microsoft\.SqlServer\.|Microsoft\.CSharp|Microsoft\.VisualBasic|mscorlib|Microsoft\.VisualStudio\.|Accessibility)/;
  out.externalReferences = [];
  out.codeFiles.filter((f) => /\.(cs|vb)proj$/i.test(f.name)).forEach((f) => {
    const re = /<Reference\s+Include="([^"]+)"\s*(\/>|>([\s\S]*?)<\/Reference>)/g; let m;
    while ((m = re.exec(f.text))) {
      const asm = m[1].split(',')[0].trim(); const hint = (m[3] || '').match(/<HintPath>([^<]+)<\/HintPath>/);
      out.externalReferences.push({ owner: f.owner, assembly: asm, fullName: m[1], hintPath: hint ? hint[1] : null, framework: FRAMEWORK.test(asm), suppliedInScope: false });
    }
  });

  // candidate scans (NOT conclusions)
  const CODE_PATTERNS = [
    ['crm-sdk-create', /\.Create\s*\(/], ['crm-sdk-update', /\.Update\s*\(/], ['crm-sdk-delete', /\.Delete\s*\(/], ['crm-sdk-execute', /\.Execute\s*\(|ExecuteMultiple|CreateRequest|UpdateRequest|DeleteRequest|UpsertRequest|SetStateRequest|AssignRequest/],
    ['crm-entity', /new\s+Entity\s*\(|EntityReference|OptionSetValue|new\s+Money\s*\(/], ['crm-service', /IOrganizationService|OrganizationServiceProxy|CrmServiceClient|ServiceClient|OrganizationService/],
    ['crm-query', /QueryExpression|FetchExpression|RetrieveMultiple|\.Retrieve\s*\(|QueryByAttribute|<fetch/i],
    ['sql-command', /SqlCommand|OleDbCommand|SqlConnection|OleDbConnection|ExecuteNonQuery|ExecuteScalar|ExecuteReader|SqlBulkCopy/],
    ['sql-dml-text', /\b(INSERT\s+INTO|UPDATE\s+[\[\w]|DELETE\s+FROM|MERGE\s+INTO|TRUNCATE\s+TABLE)\b/i],
    ['file-io', /File\.(Write|Append|Copy|Move|Delete|Read|Open)|StreamWriter|StreamReader|FileStream|Directory\./],
    ['mail-http', /SmtpClient|MailMessage|HttpClient|WebRequest|WebClient/],
    ['output-buffer', /Output0Buffer|\w+Buffer\.Add(Row)?\s*\(|Row\.\w+\s*=/],
    ['variables-write', /Dts\.Variables\[[^\]]+\]\.Value\s*=/],
  ];
  out.codeFiles.filter((f) => f.isSource).forEach((f) => f.text.split(/\r?\n/).forEach((ln, i) => {
    const s = ln.trim(); if (!s || s.startsWith('//')) return;
    CODE_PATTERNS.forEach(([k, re]) => { if (re.test(ln)) out.candidates.code.push({ owner: f.owner, file: f.name, line: i + 1, pattern: k, text: s.slice(0, 300) }); });
  }));
  const SQL_RE = /\b(INSERT\s+INTO|UPDATE|DELETE\s+FROM|DELETE|MERGE\s+INTO|MERGE|TRUNCATE\s+TABLE|SELECT\b[\s\S]*?\bINTO|EXEC(?:UTE)?)\s+([#@\[\]\w.]+)/gi;
  out.sqlStatements.forEach((s) => { if (!s.text) return; let m; SQL_RE.lastIndex = 0; while ((m = SQL_RE.exec(s.text))) out.candidates.sql.push({ owner: s.owner, verb: m[1].replace(/\s+/g, ' ').toUpperCase().slice(0, 30), object: m[2], offset: m.index }); });

  // coverage reconciliation
  const ext = {
    executables: out.executables.filter((e) => e.type !== 'EventHandler').length + 1 /* root package */,
    precedenceConstraints: out.precedenceConstraints.length,
    eventHandlers: out.executables.filter((e) => e.type === 'EventHandler').length,
    connectionManagers: out.connectionManagers.length,
    variables: out.variables.length,
    components: out.dataFlows.reduce((a, d) => a + d.components.length, 0),
    paths: out.dataFlows.reduce((a, d) => a + d.paths.length, 0),
    inputColumns: out.dataFlows.reduce((a, d) => a + d.components.reduce((b, c) => b + c.inputs.reduce((x, i) => x + i.inputColumns.length, 0), 0), 0),
    outputColumns: out.dataFlows.reduce((a, d) => a + d.components.reduce((b, c) => b + c.outputs.reduce((x, o) => x + o.outputColumns.length, 0), 0), 0),
    externalMetadataColumns: out.dataFlows.reduce((a, d) => a + d.components.reduce((b, c) => b + c.inputs.concat(c.outputs).reduce((x, i) => x + i.externalMetadataColumns.length, 0), 0), 0),
    projectItems: out.codeFiles.filter((f) => f.kind === 'ScriptTask').length,
    sourceCodeProps: new Set(out.codeFiles.filter((f) => f.kind === 'ScriptComponent').map((f) => f.owner)).size,
    disabledExecutables: out.executables.filter((e) => e.disabled && e.type !== 'EventHandler').length,
    logProviders: out.logProviders.length,
    flatFileColumns: out.connectionManagers.reduce((a, c) => a + (c.flatFile ? c.flatFile.columns.length : 0), 0),
    forEachVariableMappings: out.executables.reduce((a, e) => a + (e.foreach ? e.foreach.variableMappings.length : 0), 0),
    loggingOptions: (out.package.logging ? 1 : 0) + out.executables.filter((e) => e.logging).length,
  };
  const checks = Object.keys(ext).map((k) => ({ item: k, rawXml: raw[k], extracted: ext[k], match: raw[k] === ext[k] }));
  checks.push({ item: 'sourceCodeArrayElements(declared vs parsed)', rawXml: raw.sourceCodeArrayDeclared, extracted: raw.sourceCodeElements, match: raw.sourceCodeArrayDeclared === raw.sourceCodeElements });
  const unhandledDts = Object.keys(dtsTypes).filter((k) => !HANDLED_DTS.has(k));
  checks.push({ item: 'unhandledDtsElementTypes', rawXml: unhandledDts.length, extracted: 0, match: unhandledDts.length === 0, detail: unhandledDts });
  out.coverage = { rawElementCount: raw.elements, dtsElementTypes: dtsTypes, checks, allMatch: checks.every((c) => c.match), unresolvedLineage: out.dataFlows.reduce((a, d) => a + d.unresolvedLineage, 0) };
  return out;
}

const [, , inFile, outFile, relRoot] = process.argv;
if (!inFile || !outFile) { console.error('usage: dtsx-extract.mjs <in.dtsx> <out.json> [relRoot]'); process.exit(2); }
const res = extract(inFile, relRoot);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(res, null, 1));
console.log(JSON.stringify({ file: res.source.file, sha256: res.source.sha256, elements: res.coverage.rawElementCount, coverageAllMatch: res.coverage.allMatch, unresolvedLineage: res.coverage.unresolvedLineage, checks: res.coverage.checks.filter((c) => !c.match) }, null, 1));
