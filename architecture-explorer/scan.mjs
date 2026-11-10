#!/usr/bin/env node
// Architecture scanner: reads a Claude Code project (agents, skills, commands, hooks, MCP, rules, helper scripts)
// and prints ONE JSON document describing it. No dependencies, no network, read-only.
// Usage: node architecture-explorer/scan.mjs [projectRoot=.] [--scripts tools,scripts] [--out file.json]
// Everything reported is read from files. Cross-references are exact file-name MENTIONS in text (not proof of a call); output files cannot be read from agent definitions, so they belong in the manifest.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const opt = (name, dflt) => { const i = argv.indexOf(name); if (i < 0) return dflt; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const scriptDirs = (opt('--scripts', 'tools,scripts') || '').split(',').filter(Boolean);
const outFile = opt('--out', null);
const root = path.resolve(argv[0] || '.');

const rel = (p) => path.relative(root, p).split(path.sep).join('/');
const exists = (p) => fs.existsSync(p);
const read = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return null; } };
const list = (d, f = () => true) => (exists(d) ? fs.readdirSync(d, { withFileTypes: true }).filter(f) : []);
const lines = (s) => (s || '').split(/\r?\n/);

// ---- frontmatter (flat key: value pairs only; lists are comma separated) ----
function frontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text || '');
  if (!m) return { fm: {}, body: text || '' };
  const fm = {};
  lines(m[1]).forEach((l) => { const k = /^([A-Za-z_-]+):\s*(.*)$/.exec(l); if (k) fm[k[1]] = k[2].trim().replace(/^["']|["']$/g, ''); });
  return { fm, body: m[2] };
}
const csv = (v) => (v ? v.split(',').map((x) => x.trim()).filter(Boolean) : []);

// ---- helper scripts ----
const SCRIPT_EXT = /\.(mjs|cjs|js|ts|py|sh|ps1)$/;
function firstComment(text) {
  const out = [];
  for (const l of lines(text)) {
    if (/^#!/.test(l)) continue;
    const m = /^\s*(?:\/\/|#)\s?(.*)$/.exec(l);
    if (m) { if (m[1].trim()) out.push(m[1].trim()); if (out.length >= 3) break; } else if (l.trim() === '') { if (out.length) break; } else break;
  }
  return out;
}
function headerBlock(text) { const out = []; for (const l of lines(text)) { if (/^#!/.test(l)) continue; const m = /^\s*(?:\/\/|#)\s?(.*)$/.exec(l); if (m) out.push(m[1]); else break; if (out.length >= 24) break; } return out; }
const scripts = [];
for (const d of scriptDirs) {
  for (const e of list(path.join(root, d), (x) => x.isFile() && SCRIPT_EXT.test(x.name))) {
    const p = path.join(root, d, e.name), t = read(p) || '';
    const fc = firstComment(t);
    scripts.push({ name: e.name, path: rel(p), lines: lines(t).length, description: fc[0] || null, descriptionLines: fc, documented: fc.length > 0, headerLines: headerBlock(t) });
  }
}
const scriptByName = new Map(scripts.map((s) => [s.name, s]));
const scriptNameRe = scripts.length ? new RegExp(`(?<![\\w-])(${scripts.map((s) => s.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})(?![\\w-])`, 'g') : null;
const refsTo = (text) => (scriptNameRe ? [...new Set([...(text || '').matchAll(scriptNameRe)].map((m) => m[1]))] : []);
// names that look like a script reference but do not exist (tools/x.mjs style paths only)
const pathLikeRe = new RegExp(`(?:${scriptDirs.map((d) => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})/([\\w.-]+${SCRIPT_EXT.source.slice(0, -1)})`, 'g');
const missingRefs = (text) => (scriptDirs.length ? [...new Set([...(text || '').matchAll(pathLikeRe)].map((m) => m[1]).filter((n) => !scriptByName.has(n)))] : []);

// ---- rules files ----
function rulesFile(name) {
  const p = path.join(root, name), t = read(p);
  if (t == null) return null;
  const L = lines(t);
  const headings = L.map((l, i) => ({ l, i })).filter((x) => /^#{1,3}\s/.test(x.l)).map((x) => ({ level: x.l.match(/^#+/)[0].length, text: x.l.replace(/^#+\s*/, '').trim(), line: x.i + 1 }));
  return { path: name, lines: L.length, headings, numberedItems: L.filter((l) => /^\d+\.\s/.test(l)).length, scriptRefs: refsTo(t) };
}
const rules = ['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md'].map(rulesFile).filter(Boolean);

// ---- agents ----
const agents = list(path.join(root, '.claude/agents'), (e) => e.isFile() && e.name.endsWith('.md')).map((e) => {
  const p = path.join(root, '.claude/agents', e.name), t = read(p) || '';
  const { fm, body } = frontmatter(t);
  const sRefs = refsTo(body), refs = { scripts: sRefs, missingScripts: missingRefs(body) };
  return {
    file: rel(p), name: fm.name || null, description: fm.description || null, tools: csv(fm.tools), model: fm.model || null,
    skills: csv(fm.skills), bodyLines: lines(body).length, readsRules: rules.filter((r) => body.includes(r.path)).map((r) => r.path),
    mentionedFiles: [...new Set([...body.matchAll(/`((?:analysis|reports|evidence|out)\/[^`\s]+)`/g)].map((m) => m[1]))],
    ...refs,
  };
});

// ---- skills / commands ----
const skills = list(path.join(root, '.claude/skills'), (e) => e.isDirectory()).map((e) => {
  const p = path.join(root, '.claude/skills', e.name, 'SKILL.md'), t = read(p);
  if (t == null) return { name: e.name, file: null, problem: 'missing SKILL.md' };
  const { fm, body } = frontmatter(t);
  return { name: fm.name || e.name, file: rel(p), description: fm.description || null, bodyLines: lines(body).length, scripts: refsTo(body) };
});
const commands = list(path.join(root, '.claude/commands'), (e) => e.isFile() && e.name.endsWith('.md')).map((e) => {
  const p = path.join(root, '.claude/commands', e.name), { fm, body } = frontmatter(read(p) || '');
  return { name: e.name.replace(/\.md$/, ''), file: rel(p), description: fm.description || null, scripts: refsTo(body) };
});

// ---- settings: hooks, permissions, mcp, launch ----
const json = (p) => { const t = read(p); if (t == null) return null; try { return JSON.parse(t); } catch (e) { return { __error: String(e.message) }; } };
const settingsFiles = ['.claude/settings.json', '.claude/settings.local.json'].map((f) => ({ f, j: json(path.join(root, f)) })).filter((x) => x.j);
const hooks = [];
settingsFiles.forEach(({ f, j }) => Object.entries(j.hooks || {}).forEach(([event, arr]) => (Array.isArray(arr) ? arr : []).forEach((h) => (h.hooks || []).forEach((c) => hooks.push({ source: f, event, matcher: h.matcher || null, type: c.type || null, command: c.command || null, scripts: refsTo(c.command) })))));
const mcpJson = json(path.join(root, '.mcp.json'));
const mcpServers = mcpJson && mcpJson.mcpServers ? Object.keys(mcpJson.mcpServers) : [];
const launch = json(path.join(root, '.claude/launch.json'));
const launchConfigs = launch && launch.configurations ? launch.configurations.map((c) => ({ name: c.name, command: [c.runtimeExecutable, ...(c.runtimeArgs || [])].join(' '), port: c.port || null, scripts: refsTo([c.runtimeExecutable, ...(c.runtimeArgs || [])].join(' ')) })) : [];
const manifest = json(path.join(root, '.claude/architecture.json')) || json(path.join(root, 'architecture.json'));

// ---- script cross references: who uses which script ----
const usage = new Map(scripts.map((s) => [s.name, { agents: [], skills: [], commands: [], hooks: [], launch: [], rules: [], scripts: [] }]));
const add = (key, from, ns) => ns.forEach((n) => { if (usage.has(n) && !usage.get(n)[key].includes(from)) usage.get(n)[key].push(from); });
agents.forEach((a) => add('agents', a.name || a.file, a.scripts));
skills.forEach((s) => add('skills', s.name, s.scripts || []));
commands.forEach((c) => add('commands', c.name, c.scripts));
hooks.forEach((h) => add('hooks', `${h.event}`, h.scripts));
launchConfigs.forEach((l) => add('launch', l.name, l.scripts));
rules.forEach((r) => add('rules', r.path, r.scriptRefs));
scripts.forEach((s) => { const t = read(path.join(root, s.path)) || ''; add('scripts', s.name, refsTo(t).filter((n) => n !== s.name)); });
scripts.forEach((s) => { s.usedBy = usage.get(s.name); });

// ---- health checks (facts only) ----
const health = [];
const H = (severity, code, subject, message) => health.push({ severity, code, subject, message });
agents.forEach((a) => {
  if (!a.name) H('high', 'agent-no-name', a.file, 'No name in frontmatter');
  if (!a.description) H('medium', 'agent-no-description', a.file, 'No description: the orchestrator cannot decide when to use it');
  if (!a.model) H('info', 'agent-no-model', a.name || a.file, 'No model set (inherits the default)');
  if (!a.tools.length) H('medium', 'agent-no-tools', a.name || a.file, 'No tools line: the agent inherits every tool');
  if (a.missingScripts.length) H('high', 'agent-missing-script', a.name || a.file, `References scripts that do not exist: ${a.missingScripts.join(', ')}`);
  if (a.bodyLines > 80) H('info', 'agent-long', a.name || a.file, `Long definition (${a.bodyLines} lines): candidate for moving knowledge into a skill`);
});
const dupNames = agents.map((a) => a.name).filter((n, i, arr) => n && arr.indexOf(n) !== i);
dupNames.forEach((n) => H('high', 'agent-duplicate-name', n, 'Two agent files share one name'));
skills.forEach((s) => { if (s.problem) H('high', 'skill-broken', s.name, s.problem); else if (!s.description) H('medium', 'skill-no-description', s.name, 'No description: it will not be triggered'); });
scripts.forEach((s) => {
  const u = usage.get(s.name), used = Object.values(u).some((a) => a.length);
  if (!used) H('info', 'script-unreferenced', s.path, 'Not referenced by any agent, skill, command, hook, rules file or other script');
  if (!s.documented) H('info', 'script-undocumented', s.path, 'No leading comment explaining what it does');
});
hooks.forEach((h) => { if (!h.command) H('medium', 'hook-no-command', h.event, 'Hook without a command'); });
settingsFiles.forEach(({ f, j }) => { if (j.__error) H('high', 'settings-invalid-json', f, j.__error); });
if (!rules.length) H('medium', 'no-rules-file', root, 'No CLAUDE.md / AGENTS.md');
if (manifest) {
  const known = new Set(agents.map((a) => a.name));
  (manifest.steps || []).forEach((st) => (st.agents || []).forEach((n) => { if (!known.has(n) && !(st.proposed)) H('high', 'manifest-unknown-agent', `step ${st.id || st.title || '?'}`, `architecture.json mentions agent "${n}" that has no file`); }));
  // declared flow vs agent definitions (exact file-name mentions)
  const agentByName = new Map(agents.map((a) => [a.name, a]));
  const declared = new Map();
  (manifest.steps || []).forEach((st) => Object.entries(st.uses || {}).forEach(([an, ss]) => { declared.set(an, new Set([...(declared.get(an) || []), ...ss])); }));
  (manifest.steps || []).forEach((st) => (st.scripts || []).concat(Object.values(st.uses || {}).flat()).forEach((n) => { if (!scriptByName.has(n)) H('high', 'manifest-unknown-script', `step ${st.id}`, `architecture.json mentions script "${n}" that does not exist`); }));
  declared.forEach((set, an) => {
    const a = agentByName.get(an); if (!a) return;
    set.forEach((s) => { if (!a.scripts.includes(s)) H('medium', 'flow-script-not-in-agent', an, `The flow says ${an} uses ${s}, but its definition file never mentions it`); });
    a.scripts.forEach((s) => { if (!set.has(s)) H('info', 'agent-script-not-in-flow', an, `${an}'s definition mentions ${s}, which the flow does not list for it`); });
  });
}

const out = {
  scannedAt: new Date().toISOString(), root: path.basename(root), scriptDirs,
  counts: { agents: agents.length, skills: skills.length, commands: commands.length, hooks: hooks.length, mcpServers: mcpServers.length, scripts: scripts.length, rulesFiles: rules.length },
  rules, agents, skills, commands, hooks, mcpServers, launch: launchConfigs, scripts,
  manifest: manifest || null, health,
};
const text = JSON.stringify(out, null, 2);
if (outFile) { fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true }); fs.writeFileSync(outFile, text); console.log(`wrote ${outFile}: ${JSON.stringify(out.counts)}; health ${health.length}`); } else console.log(text);
