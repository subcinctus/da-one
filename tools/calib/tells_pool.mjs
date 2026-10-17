// Score every text of a calibration pool with the page's AI-tell rules (tellScore in src/tells.mjs).
//   node tools/calib/tells_pool.mjs POOL.jsonl OUT.json   ->  {"ids": [...], "doc": {"tells": [...]}}
import fs from 'fs';
import { tellScore } from '../../ai-checker/src/tells.mjs';

const [poolPath, outPath] = process.argv.slice(2);
const pool = fs.readFileSync(poolPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const t0 = Date.now();
const scores = pool.map((p) => Math.round(tellScore(p.text) * 1e4) / 1e4);
fs.writeFileSync(outPath, JSON.stringify({ ids: pool.map((p) => p.id), doc: { tells: scores } }));
console.log(`tells: ${pool.length} texts in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
