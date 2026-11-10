// Inspect BufferWrapper property→index layout for a script component (dev helper).
import fs from 'node:fs';
const [, , ev, suffix] = process.argv;
const j = JSON.parse(fs.readFileSync(ev, 'utf8'));
const c = j.dataFlows.flatMap((d) => d.components).find((x) => x.refId.endsWith(suffix));
console.log('inputs:', c.inputs.map((i) => i.name + '(' + i.inputColumns.length + ')').join(', '));
console.log('outputs:', c.outputs.map((o) => o.name + (o.synchronousInputId ? '[sync]' : '[async]') + (o.isErrorOut ? '[err]' : '') + '(' + o.outputColumns.map((x) => x.name).join(',') + ')').join(' | '));
const bw = j.codeFiles.find((f) => f.owner === c.refId && f.name === 'BufferWrapper.cs');
let cls = null;
bw.text.split(/\r?\n/).forEach((ln, i, a) => {
  const mc = ln.match(/public class (\w+)/); if (mc) { cls = mc[1]; console.log('CLASS', cls); }
  const mp = ln.match(/^\s*public\s+([\w\[\]]+)\s+(\w+)\s*$/);
  if (mp && !mp[2].endsWith('_IsNull')) { for (let k = i + 1; k < i + 14; k++) { const mi = a[k] && a[k].match(/BufferColumnIndexes\[(\d+)\]/); if (mi) { const setter = a.slice(i, i + 20).join(' ').includes('set'); console.log('  ', mp[2], mi[1], setter ? 'get/set' : 'get'); break; } } }
});
