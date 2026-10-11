// Bundles src/main.js (+ three.js) into ONE self-contained HTML file.
//   node tools/build.mjs          -> dist/index.html (minified, shippable, double-click to play)
//   node tools/build.mjs --dev    -> dist/dev.html   (unminified, readable stack traces, used by smoke tests)
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dev = process.argv.includes('--dev');
const outIdx = process.argv.indexOf('--out');
const outArg = outIdx >= 0 ? process.argv[outIdx + 1] : null;

const t0 = Date.now();
let result;
try {
  result = await esbuild.build({
    entryPoints: [path.join(root, 'src/main.js')],
    bundle: true,
    format: 'iife',
    minify: !dev,
    sourcemap: dev ? 'inline' : false,
    write: false,
    target: 'es2020',
    legalComments: 'none',
    logLevel: 'silent',
    define: { __DEV__: dev ? 'true' : 'false' },
  });
} catch (e) {
  for (const err of e.errors || []) {
    const loc = err.location ? `${err.location.file}:${err.location.line}:${err.location.column}` : '';
    console.error(`BUILD ERROR ${loc}\n  ${err.text}\n  ${err.location ? err.location.lineText : ''}`);
  }
  if (!e.errors) console.error(e);
  process.exit(1);
}
for (const w of result.warnings) {
  const loc = w.location ? `${w.location.file}:${w.location.line}` : '';
  console.warn(`build warning ${loc}: ${w.text}`);
}
const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const template = fs.readFileSync(path.join(root, 'src/index.html'), 'utf8');
const html = template.replace('<!--GAME_SCRIPT-->', () => `<script>${js}</script>`);
fs.mkdirSync(path.join(root, 'dist'), { recursive: true });
const out = outArg ? path.resolve(root, outArg) : path.join(root, 'dist', dev ? 'dev.html' : 'index.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, html);
console.log(`built ${path.relative(root, out)} (${(html.length / 1024).toFixed(0)} KB) in ${Date.now() - t0} ms`);

// Release builds also emit dist/artifact.html: the same page without the document wrapper
// (doctype/html/head/body/charset/viewport), for hosts that supply their own skeleton. <title> stays first.
if (!dev && !outArg) {
  const art = html
    .replace(/<!doctype html>\s*/i, '')
    .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
    .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
    .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
    .replace(/<meta charset[^>]*>\s*/i, '')
    .replace(/<meta name="viewport"[^>]*>\s*/i, '');
  const artOut = path.join(root, 'dist', 'artifact.html');
  fs.writeFileSync(artOut, art);
  console.log(`built ${path.relative(root, artOut)} (${(art.length / 1024).toFixed(0)} KB)`);
}
