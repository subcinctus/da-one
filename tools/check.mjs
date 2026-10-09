// Fast static check: bundles everything (catches syntax errors, bad imports, missing exports)
// and runs `node --check` on every source file. Usage: node tools/check.mjs
import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = false;
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []);
}
for (const f of walk(path.join(root, 'src'))) {
  try { execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' }); }
  catch (e) { failed = true; console.error(`SYNTAX ${path.relative(root, f)}\n${e.stderr.toString()}`); }
}
try {
  const r = await esbuild.build({ entryPoints: [path.join(root, 'src/main.js')], bundle: true, write: false, format: 'iife', logLevel: 'silent', define: { __DEV__: 'true' } });
  for (const w of r.warnings) console.warn(`warning ${w.location ? w.location.file + ':' + w.location.line : ''}: ${w.text}`);
} catch (e) {
  failed = true;
  for (const err of e.errors || []) console.error(`BUNDLE ${err.location ? err.location.file + ':' + err.location.line : ''}: ${err.text}`);
}
console.log(failed ? 'CHECK FAILED' : 'CHECK OK');
process.exit(failed ? 1 : 0);
