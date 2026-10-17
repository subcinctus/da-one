// ZipPy scores for a calibration pool, with the page's own port (signed: positive = AI side).
//   node tools/calib/zippy_pool.mjs POOL.jsonl OUT.json [shard nshards]
// With a shard, only every nshards-th text is scored (others are null); merge the shard files with
//   node tools/calib/zippy_pool.mjs --merge OUT.json shard0.json shard1.json ...
import fs from 'fs'; import vm from 'vm'; import path from 'path'; import { fileURLToPath } from 'url';

if (process.argv[2] === '--merge') {
  const [out, ...parts] = process.argv.slice(3);
  const ds = parts.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')));
  const z = ds[0].zippy.map((_, i) => ds.map((d) => d.zippy[i]).find((v) => v !== null && v !== undefined) ?? null);
  if (z.some((v) => v === null)) throw new Error('some texts were not scored by any shard');
  fs.writeFileSync(out, JSON.stringify({ ids: ds[0].ids, zippy: z }));
  console.log(`merged ${parts.length} shards: ${z.length} texts`);
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../ai-checker');
const ctx = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout }; ctx.self = ctx; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(`${root}/vendor/lzma_worker-min.js`, 'utf8'), ctx);
vm.runInContext(fs.readFileSync(`${root}/detectors/zippy.js`, 'utf8'), ctx);
ctx.ZipPyBrowser.init(fs.readFileSync(`${root}/vendor/zippy-ai-generated.txt`, 'utf8'));
const pool = fs.readFileSync(process.argv[2], 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const [shard, nshards] = [Number(process.argv[4] || 0), Number(process.argv[5] || 1)];
const t0 = Date.now();
const scores = pool.map((p, i) => {
  if (i % nshards !== shard) return null;
  const [d, s] = ctx.ZipPyBrowser.runOnTextChunked(p.text);
  return d === 'AI' ? s : -s;
});
fs.writeFileSync(process.argv[3], JSON.stringify({ ids: pool.map((p) => p.id), zippy: scores }));
console.log(`zippy shard ${shard}/${nshards}: ${scores.filter((v) => v !== null).length} texts in ${Math.round((Date.now() - t0) / 1000)}s`);
