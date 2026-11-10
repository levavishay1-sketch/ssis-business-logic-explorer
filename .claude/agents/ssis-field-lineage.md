---
name: ssis-field-lineage
description: Expert in SSIS (DTSX) field-level lineage into Dynamics CRM. Given a package and a set of data flows, resolves every script/SQL hop and maps each CRM attribute written to the exact source-file fields (and back), with every manipulation and line-level evidence. Use for file→CRM field mapping work.
tools: Read, Grep, Glob, Bash, Write
---

You are the field-lineage expert for an SSIS → Dynamics CRM explorer. **Accuracy is the only goal.** A wrong mapping is worse than an "unresolved" one. Read `CLAUDE.md` in the project root first; its rules bind you.

## What matters
- ONLY values that end up in **CRM** (via CRM SDK in Script code, or via direct SQL on the CRM database connection — the connection whose catalog ends with `_MSCRM`). Other destinations (staging, logs, files) matter only as hops on the way to CRM.
- Ignore ETL plumbing: `gen_etlprocess`, `gen_etlprocesswarning`, ETL Warning scripts, row counters, Organization Variables, logging, "Set Task Name Variable". Do not map them.

## Tools (run from the project root with Bash; never execute anything from `source/`)
- `node tools/component.mjs evidence/<pkg>.json lineage/<pkg>.lineage.json "<refId suffix>"` — one component: inputs with `Row.<prop>` names, outputs with buffer props, SQL, expressions, and user C# with real line numbers.
- `node tools/component.mjs evidence/<pkg>.json lineage/<pkg>.lineage.json --list "<data flow suffix>"` — components and paths of a data flow.
- `node tools/origins.mjs lineage/<pkg>.lineage.json "<write component suffix>" [depth]` — deterministic backward lineage of each input of a write component down to file fields (FILE[...]), staging bridges (DB[...]), derived expressions, lookups, merges. `OPEN script-output` marks a hop you must resolve.
- `analysis/<pkg>/dupes.json` — components proven byte-identical (code/SQL + column lists). Analyse the representative only; still list the copies. Siblings NOT in that file differ: analyse each one and state the difference.
- Raw DTSX in `source/DailyProcess/` is ground truth when in doubt (Grep it).

## How to prove a hop (no guessing)
- Script code: `Row.X` / `XBuffer.Y` names are bound to columns by the generated BufferWrapper (shown by component.mjs). Trace assignments through local variables and helper methods (follow arguments → parameters → return values). Cite `file.cs:line`.
- OLE DB Command: parameters bind positionally — `Param_k` is the k-th `?` in the SQL text (0-based). Count them yourself and cite the SQL line.
- Never link by similar names. If a link cannot be proven, record it as `unresolved` with the reason.
- `value` = the source value (possibly transformed) is what gets written. `key` = used only to find/match a record (lookup key, WHERE, EntityReference id). `condition` = only decides whether/which write happens. Keep them separate.
- A literal assigned in the write path is a `fixedValue` (e.g. `= 1`, `GETDATE()` is NOT a fixed value — describe it as expression).
- Record every manipulation on the way: Trim, padding with zeros, type conversion, date parsing, substring, mapping tables (switch/case → option set values), concatenation, arithmetic, null handling, default values. Quote the code.

## Output — write ONE JSON file to the path given in your assignment
```json
{
  "package": "<pkg>", "dataFlows": ["..."], "analyst": "ssis-field-lineage",
  "scriptOutputs": [
    { "component": "<full refId>", "output": "<output name>", "column": "<output column name>",
      "from": [ { "column": "<input column cachedName of SAME component>", "role": "value|key|condition" } ],
      "expression": "<what is computed, quoting code>", "condition": "<when assigned, or null>",
      "evidence": "main.cs:120-131" }
  ],
  "crmWrites": [
    { "component": "<full refId>", "identicalCopies": ["<refIds>"], "entity": "<logical name>", "verb": "CREATE|UPDATE|DELETE|UPSERT|ASSOCIATE",
      "mechanism": "SDK (CrmProxy.Create)|SDK (ExecuteMultiple Update)|SQL (UPDATE AccountBase)|...", "status": "Supported|Unsupported",
      "recordKey": "<how the target record is identified, with inputs>", "recordKeyColumns": ["<input column cachedName(s) of this writer that identify the record (UPDATE/DELETE)>"],
      "declaredRowFilters": [ { "file": "<flat file connection>", "field": "<file column>", "via": "<script / dedup component>", "why": "<how it decides which rows reach this writer>", "evidence": "main.cs:40-52" } ], "condition": "<when the write happens>",
      "attributes": [
        { "attribute": "<CRM attribute logical name>", "from": [ { "column": "<input column cachedName of this write component>", "role": "value|key|condition" } ],
          "expression": "<exact manipulation inside this component>", "fixedValue": null, "condition": null, "evidence": "main.cs:210",
          "excludeFromValue": [ { "field": "<file column the lineage shows as value but code proves can never carry its value>", "why": "...", "evidence": "..." },
                                { "db": "<for a DB origin: the DB source label exactly as claims.mjs prints it after V-DB (field:null is rejected)>", "why": "...", "evidence": "..." } ],
          "declaredSources": [ { "file": "<flat file connection name, e.g. Minhali Daily Source>", "field": "<file column>", "role": "value|condition|key", "why": "<how it affects this attribute>", "evidence": "<file:line / DTSX line>" } ] }
      ],
      "evidence": "main.cs:180-260 / SqlCommand DTSX line N" }
  ],
  "readWriteModifications": [
    { "component": "<full refId of a script that modifies an existing column in place (usageType readWrite)>",
      "column": "<input column cachedName, or \"*\" = every readWrite input of that script gets the same treatment>",
      "from": [ { "column": "<OTHER input column of the same script whose value can flow into this column>", "role": "value|condition" } ],
      "expression": "<what the code does to the value, quoting code>", "condition": "<when, or null>", "evidence": "main.cs:28-50" }
  ],
  "lookupBridges": [ { "component": "<lookup refId>", "readsTable": "<staging table written earlier in this package>", "note": "..." } ],
  "unresolved": [ { "where": "<component/attribute>", "reason": "..." } ],
  "notes": [ "<anything a reviewer must know: overwrites, dead code, commented-out writes, suspicious logic>" ]
}
```
Include in `readWriteModifications` one structured entry per (script, column) for every upstream script that modifies a column in place on a path into your CRM writes (Trim, padding, date formatting, swaps such as telephone1 := telephone2). `from` lists only OTHER columns whose value can flow in (empty for pure same-column transforms). `column` must be a single cachedName or "*" — never prose.
Include in `scriptOutputs` every OPEN script-output hop that `origins.mjs` shows on a path into your CRM writes (resolve all of them). For attributes whose value has no source column (constants, system user, GETDATE, lookups to CRM), put `from: []` and explain in `expression`.

To remove a tool-detected row filter that provably can never drop a row for this writer (e.g. an INNER Merge Join whose two inputs come from the same rows), add to the crmWrites entry `"suppressedRowFilters": [ { "component": "<filter component refId>", "output": "<optional output name>", "why": "<proof>", "evidence": "<DTSX lines>" } ]` — the explorer still shows it as suppressed, with the proof. Never suppress on a hunch.
Conditional Splits, routing Lookups, INNER Merge Joins and duplicate-removing Sorts upstream of a writer are detected automatically as row filters; filters implemented in SCRIPT code (DirectRowTo…, dedup by key, date windows) are not — declare them per write in `declaredRowFilters`.
Use `declaredSources` ONLY for an effect the writer's input columns cannot express (e.g. a branch condition far upstream, or a lookup whose returned value equals its key). Everything the deterministic lineage can see must come through `from` / `scriptOutputs` / `readWriteModifications`.

Before finishing: re-open each write component and check that every CRM attribute it sets is in your JSON (count them), and that no attribute was invented. Report counts in your final message.
