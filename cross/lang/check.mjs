#!/usr/bin/env node
// Checks Capri's French dictionaries (cross/lang/fr/*.json, read by cross/French.cs).
//   node cross/lang/check.mjs            all files
//   node cross/lang/check.mjs pet.json   one file
// Errors fail the check. "Not in code" warnings list English lines that no string in the code matches,
// which usually means a typo: the line would never be translated.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..');
const folder = join(here, 'fr');
const only = process.argv[2];

// Every string literal in the C# code, joined, to look the English up in.
let code = '';
for (const dir of ['cross', 'app']) {
  for (const name of readdirSync(join(root, dir))) {
    if (!name.endsWith('.cs')) continue;
    const text = readFileSync(join(root, dir, name), 'utf8');
    for (const m of text.matchAll(/@?"((?:[^"\\\n]|\\.|"")*)"/g)) code += '\u0000' + m[1].replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/""/g, '"');
  }
}

let errors = 0, warnings = 0, lines = 0, tips = 0;
const everywhere = new Map();
const slots = (s) => [...s.matchAll(/\{(\d)\}/g)].map((m) => m[1]).sort().join(',');
for (const file of readdirSync(folder).filter((f) => f.endsWith('.json') && (!only || f === only)).sort()) {
  let data;
  try { data = JSON.parse(readFileSync(join(folder, file), 'utf8')); }
  catch (e) { console.log(`ERROR ${file}: not valid JSON: ${e.message}`); errors++; continue; }
  const bad = (msg) => { console.log(`ERROR ${file}: ${msg}`); errors++; };
  const warn = (msg) => { console.log(`warn  ${file}: ${msg}`); warnings++; };
  for (const key of Object.keys(data)) if (key !== 'lines' && key !== 'tips') bad(`unknown section "${key}" (use "lines" and "tips")`);
  for (const [en, fr] of Object.entries(data.lines || {})) {
    lines++;
    const before = everywhere.get(en);
    if (before && before.fr !== fr) warn(`"${en}" is also in ${before.file} as "${before.fr}"; files load in name order, the last one wins`);
    everywhere.set(en, { fr, file });
    if (typeof fr !== 'string' || !fr.trim()) { bad(`empty French for "${en}"`); continue; }
    if (slots(en) !== slots(fr)) bad(`placeholders differ: "${en}" -> "${fr}"`);
    if (/\{\d\}/.test(en)) {
      const literal = en.replace(/\{\d\}/g, '');
      if (literal.replace(/[\s.,!?:;'"()-]/g, '').length < 6) bad(`template too generic, it would match unrelated text: "${en}"`);
      if (/\{\d\}\{\d\}/.test(en)) bad(`two placeholders side by side can't be told apart: "${en}"`);
      const pieces = en.split(/\{\d\}/).filter((p) => p.trim().length >= 4);
      const missing = pieces.filter((p) => !code.includes(p));
      if (missing.length) { warn(`not in code (template pieces ${JSON.stringify(missing)}): "${en}"`); }
    } else if (!code.includes(en)) {
      warn(`not in code: "${en}"`);
    }
  }
  for (const [name, fr] of Object.entries(data.tips || {})) {
    tips++;
    if (typeof fr !== 'string' || !fr.trim()) bad(`empty tip "${name}"`);
    if (!code.includes('"' + name) && !code.includes('\u0000' + name + '\u0000')) {
      if (!code.split('\u0000').includes(name)) warn(`tip name not in MainframeTips: "${name}"`);
    }
  }
}
console.log(`${lines} lines, ${tips} tips, ${errors} errors, ${warnings} warnings`);
process.exit(errors ? 1 : 0);
