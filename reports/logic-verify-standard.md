# Standard for verifying business-logic description claims (logic.json)

Agreed 2026-11-07. Applies to every verifier of `tools/logic-claims.mjs` claims. Results go to `analysis/<pkg>/verify-L*.json`.
`tools/logic-audit.mjs` counts a claim as "אומת ב-100%" only when its latest verdict is CONFIRMED or FIXED **and** its hash equals the current text.

## Verdicts
1. **WRONG**: a stated fact that does not match the DTSX exactly. This covers:
   - tables, columns, entities, verbs, mechanism, and Supported/Unsupported;
   - conditions (operators, values, NULL semantics, AND/OR), fixed values (rule 7), order, branches, counts and disabled flags.
   - The following are also WRONG:
     - A meaning stated as fact without proof. Meanings taken from a column, task, data-flow or table name are not proof. They must be labelled השערה, or attributed exactly (code comment, code constant, SQL comment, or another supplied package), with evidence.
     - A statement that contradicts another claim of the same package.
     - A statement about failure handling that is not correct. Anything written about it must be correct.
2. **INCOMPLETE**: only for missing **business** logic. That means:
   - a row-selection condition;
   - a branch that decides what is written to CRM;
   - a value or attribute that is written;
   - a CRM write.
   - ETL plumbing is out of scope (CLAUDE.md Focus): error handling, ETL Warning paths, logging, runtime-exception behaviour (NULL reads, string overflow, FailComponent, MaximumErrorCount, Dts.TaskResult), and truncate/archive/file-move steps. Missing plumbing detail is **not** INCOMPLETE. It may be noted in `detail`.
3. **UNVERIFIABLE**: a unit that cannot be settled from the supplied files.
4. **CONFIRMED**: every unit is correct and no business logic is missing.

## Accepted forms
- **Runtime behaviour not shown in the files**: accepted only when explicitly marked unverified, conditional, or "לפי התנהגות SSIS המתועדת, לא מוצג בקבצים".
- **Ownership of an unqualified column in a multi-table query**: accepted only when stated as unknown, or argued explicitly. The argument is the ambiguity rule ("אילו העמודה הייתה קיימת בשתי הטבלאות השאילתה הייתה נכשלת; לפי המשתמש החבילה רצה בפרודקשן") plus evidence of which table has the column.
- **Connection strings**: these are design-time values. When the package loads the unsupplied `C:\Generix\SSISConfigFile.dtsConfig`, a text that names the runtime target must say the config file may override it.
- **DATEDIFF**: counts boundaries crossed, not elapsed time.
- **Findings**: must be conditional ("אם … אז …") when the outcome depends on data. They must never be framed as bugs (the user: everything works in production).

## Process rules (user-approved 2026-11-10, cost control without lowering quality)
1. **The standard is frozen.** Verifiers apply exactly the rules in this file. A real factual error is still WRONG. Do not invent new strictness categories beyond this file.
2. **Fixers must not reopen verified claims just to align wording.** Edit a claim that is already verified ONLY if it contains the same factual error that is being fixed elsewhere. In that case it must be fixed, because leaving a wrong fact would hurt quality. Never edit a verified claim for style, consistency of phrasing, or extra caveats.
3. **Fix minimally.** Change only the units the verifier flagged, plus the same wrong fact elsewhere. Do not add new detail that was not asked for, because every added sentence is new surface for errors.
4. **Round cap.** From 2026-11-10, each package gets at most two more fix + re-check cycles. A claim that is still not verified after that stays visibly "לא אומת" in the explorer, with the verifier's reason. It is never shown as verified.
5. Every verification is done by the strong model. No cheaper model is used for verification.

## Output
- Write one result per claim checked, with `id` and `hash` copied verbatim from `node tools/logic-claims.mjs "<pkg>" --open`.
- Format: `{ verifier, package, scope, checkedAt, checked, results:[{id,hash,verdict,detail,evidence,wrongUnits:[{unit,problem,correct,evidence}]}] }`.
- Never edit logic.json or any other file.
