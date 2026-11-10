#!/usr/bin/env node
// Builds ONE self-contained HTML (no network, no CDN) from a scan of the project + the optional manifest.
// Usage: node architecture-explorer/build.mjs [projectRoot=.] [--out out/architecture.html] [--scripts tools,scripts]
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf(n); if (i < 0) return d; const v = argv[i + 1]; argv.splice(i, 2); return v; };
const out = opt('--out', 'out/architecture.html');
const scripts = opt('--scripts', 'tools,scripts');
const root = path.resolve(argv[0] || '.');

const scan = JSON.parse(execFileSync(process.execPath, [path.join(here, 'scan.mjs'), root, '--scripts', scripts], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const manifest = scan.manifest || { steps: [], loops: [] };
const tpl = fs.readFileSync(path.join(here, 'template.html'), 'utf8');
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
// JSON is embedded in a <script>: neutralise "</" and U+2028/2029 so file contents cannot break out of it
const data = JSON.stringify({ scan, manifest }).replace(/</g, '\\u003c').replace(new RegExp('\\u2028', 'g'), '\\u2028').replace(new RegExp('\\u2029', 'g'), '\\u2029');
const html = tpl.replace('__TITLE__', esc(manifest.title || scan.root)).replace('__DATA__', () => data);
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${Math.round(html.length / 1024)} KB): ${JSON.stringify(scan.counts)}; health ${scan.health.length}`);
