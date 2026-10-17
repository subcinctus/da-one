// ZipPy scores for a calibration pool, with the page's own port (signed: positive = AI side).
//   node tools/calib/zippy_pool.mjs POOL.jsonl OUT.json
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ai-checker');
const ctx = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout }; ctx.self = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(`${root}/vendor/lzma_worker-min.js`, 'utf8'), ctx);
vm.runInContext(fs.readFileSync(`${root}/detectors/zippy.js`, 'utf8'), ctx);
ctx.ZipPyBrowser.init(fs.readFileSync(`${root}/vendor/zippy-ai-generated.txt`, 'utf8'));
const pool = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const t0 = Date.now();
const scores = pool.map((p) => { const [d, s] = ctx.ZipPyBrowser.runOnTextChunked(p.text); return d === 'AI' ? s : -s; });
fs.writeFileSync(process.argv[3], JSON.stringify({ ids: pool.map((p) => p.id), zippy: scores }));
console.log(`zippy: ${pool.length} texts in ${Math.round((Date.now() - t0) / 1000)}s`);
