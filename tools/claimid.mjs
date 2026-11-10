// Stable claim IDs for composed CRM write targets, and deterministic matching of verifier results to targets.
//
// Canonical ID: "<writer component name>|<entity>|<verb>|<attribute>".
// When two writers in one package share that base (same component name in different data flows), the
// canonical ID gets the data flow appended: "<base> [<data flow>]". Unique bases keep the short form.
// claims.mjs prints canonical IDs; verifiers must copy them verbatim.
//
// matchVerdicts() also accepts older ad-hoc forms, but only where the match is provable:
//   - component given as a path suffix ("Flow\Writer|...")
//   - a "[...]" qualifier equal to the data flow name or to the writer's container path
//   - an unqualified ID shared by N writers, when the verifier wrote N results for it and all N verdicts agree
// Anything else (abbreviated qualifiers, disagreeing repeated verdicts) stays UNMATCHED and is reported,
// never guessed (CLAUDE.md rule 13).
const tail = (s) => (s || '').split('\\').pop();
export const baseId = (t) => `${tail(t.component)}|${t.entity}|${t.verb}|${t.attribute}`;
export function claimIds(targets) {
  const comps = {};
  targets.forEach((t) => { const b = baseId(t); (comps[b] = comps[b] || new Set()).add(t.component); });
  return targets.map((t) => { const b = baseId(t); return comps[b].size > 1 ? `${b} [${t.dataFlow}]` : b; });
}
const norm = (s) => (s || '').replace(/^Package\\/, '').trim().toLowerCase();
export function matchVerdicts(targets, results) {
  const ids = claimIds(targets);
  const byCanon = new Map(ids.map((id, i) => [id, i]));
  const attached = new Array(targets.length).fill(null);
  const unmatched = [];
  const groups = {}; // unqualified, ambiguous ids -> results
  results.forEach((r) => {
    const id = String(r.id || '');
    if (byCanon.has(id)) { attached[byCanon.get(id)] = { r, how: 'canonical' }; return; }
    const parts = id.split('|');
    if (parts.length !== 4) { unmatched.push({ id, verdict: r.verdict, why: 'not an attribute claim id' }); return; }
    let [comp, entity, verb, attr] = parts;
    let qual = null;
    const mb = attr.match(/^(.*?)\s*\[(.+)\]\s*$/); if (mb) { attr = mb[1]; qual = mb[2]; }
    const ma = !mb && attr.match(/^(\S+)\s+@(\S+)$/); if (ma) { attr = ma[1]; qual = '@' + ma[2]; }
    const compN = norm(comp);
    let cand = targets.map((t, i) => i).filter((i) => { const t = targets[i]; const p = norm(t.component); return t.entity === entity && t.verb === verb && t.attribute === attr && (p === compN || p.endsWith('\\' + compN)); });
    if (qual && !qual.startsWith('@')) {
      const q = norm(qual);
      cand = cand.filter((i) => { const t = targets[i]; const container = norm(t.component.split('\\').slice(0, -1).join('\\')); return norm(t.dataFlow) === q || container === q || container.endsWith('\\' + q); });
    } else if (qual) { unmatched.push({ id, verdict: r.verdict, why: 'abbreviated qualifier ' + qual + ' cannot be tied to a data flow' }); return; }
    if (cand.length === 1) { attached[cand[0]] = { r, how: qual ? 'qualifier' : 'path-suffix' }; return; }
    if (!cand.length) { unmatched.push({ id, verdict: r.verdict, why: 'no target with this component/entity/verb/attribute' }); return; }
    const k = cand.join(','); (groups[k] = groups[k] || { cand, rs: [] }).rs.push(r);
  });
  Object.values(groups).forEach(({ cand, rs }) => {
    const verdicts = new Set(rs.map((r) => r.verdict));
    if (rs.length === cand.length && verdicts.size === 1) cand.forEach((i) => { if (!attached[i]) attached[i] = { r: rs[0], how: 'same-verdict-for-all-' + cand.length }; });
    else rs.forEach((r) => unmatched.push({ id: r.id, verdict: r.verdict, why: `shared by ${cand.length} writers; ${rs.length} result(s) with verdicts ${[...verdicts].join('/')} — cannot tell which is which` }));
  });
  return { ids, attached, unmatched };
}
