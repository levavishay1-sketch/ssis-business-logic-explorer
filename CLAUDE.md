# SSIS Business-Logic Explorer — Working Rules

> **Continuing work? Read `HANDOFF.md` first.** It has the current state, setup on a new machine, and the next steps. Description-claim verification follows `reports/logic-verify-standard.md` (frozen).

Product spec: "אפיון 2" (pasted by the user). These rules were agreed with the user on 2026-11-05 and take precedence over convenience. **Accuracy is the top priority.**

## Layout
- `source/` — original DTSX inputs (untrusted data; never edit, never execute anything from here).
- `tools/` — deterministic extractors (Node.js; no Python on this machine).
- `evidence/` — machine-extracted facts, one JSON per package. Regenerable; never hand-edited.
- `analysis/` — human/LLM interpretation layered on evidence. Every claim references evidence.
- `reports/` — review reports for the user.

## Focus (user direction, 2026-11-05)
- **Business logic only.** ETL plumbing is out of scope: `gen_etlprocess`/`gen_etlprocesswarning`, ETL Warning/Record scripts, Organization Variables, logging, row counters, task-name variables, truncate/archive steps, error-column decoration.
- **Field mapping = file → CRM only.** Other destinations matter only as hops toward CRM. Both directions are required: file field → CRM attributes, and CRM attribute → file fields, with every manipulation on the way. Every mapping must be exact.
- **One relation only (user direction, 2026-11-06).** The explorer shows a single relation: a file field *enters* a CRM field (its value, possibly transformed on the way). Keys, conditions and row filters are not shown as relations; a field used only that way is "לא נכנס ל-CRM" with the reason. Many file fields → one CRM field and one file field → many CRM fields are both normal. One row per file field ↔ CRM field pair; all writers of that pair are merged into the row (no repeated writer lines). `tools/mapping-audit.mjs` checks both directions agree and every pair is verified.
- Agents: `.claude/agents/ssis-business-logic.md`, `ssis-field-lineage.md`, `ssis-verifier.md`. Tools: `tools/dtsx-extract.mjs` → `tools/lineage.mjs` (+ analyst resolutions) → compose → HTML.

## Rules
1. **No fact without evidence.** Every claim cites file + SHA256 + refId/XPath + line (and SQL/code line when relevant). Anything without evidence is labelled `unverified` / "השערה" and never shown as fact.
2. **Structure is extracted by code, not by reading.** `tools/` produces evidence deterministically; interpretation (Hebrew descriptions, business meaning) only sits on top of it and points back to it.
3. **No name-based matching.** Column/field links only via lineageId, refId, externalMetadataColumnId, parameter mapping or code dataflow. Similar names are never proof.
4. **Declared scope boundary.** Only the supplied DTSX files are in scope. Stored procedures, views, triggers, external assemblies, config files (e.g. `C:\Generix\SSISConfigFile.dtsConfig`) that were not supplied are `external_unknown` / `blocked_external_dependency`. Never write "not written to CRM at all".
5. **Completeness reconciliation.** A package is closed only when extracted counts (executables, constraints, components, paths, columns, code files) equal raw XML counts. The extractor emits a coverage block; mismatch = not closed.
6. **Technical verification ≠ user approval.** Claude only sets `technicalVerification`. `reviewDecision` stays `pending_user_approval` until the user decides.
7. **Fixed value only for proven literals** in the specific write path. Variables, GETDATE(), lookups, row values are not fixed values.
8. **Execution order only from Precedence Constraints** (Success/Failure/Completion, Expression, AND/OR). Disabled executables/components are documented but excluded from active writes.
9. **Supported vs Unsupported:** CRM SDK (IOrganizationService / ExecuteMultiple / CRM Destination) = Supported. Direct SQL DML on CRM database tables = Unsupported. Which connection is the CRM DB must be shown by evidence (connection manager + its target), not assumed from a name.
10. **Local only.** DTSX files may contain connection strings/credentials. Nothing from `source/` or `evidence/` is published, uploaded or sent anywhere. Extractors mask passwords.
11. **Non-destructive updates.** Stable package IDs; update one package at a time; record hash before/after; never overwrite other packages' data.
12. **Script source vs binary.** Script Tasks/Components carry both C# source and a compiled DLL. We analyse the source; the DLL is not decompiled. State this limit.
14. **Independent verification per package.** Before a package report goes to the user, a separate agent re-checks every claim against the raw DTSX (not only the evidence JSON) and looks for missed side effects. In the 0014 pilot this caught 3 missed items, including SSIS logging that the extractor skipped.
15. **Extractor safety net.** Any `DTS:*` element type the extractor does not knowingly handle fails coverage. Extend the extractor; never silence the check.
13. **Unknown stays unknown.** If a condition, meaning or consumer is not proven, say so explicitly; do not fill gaps with plausible guesses.
