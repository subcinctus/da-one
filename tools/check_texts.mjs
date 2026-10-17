// Check a batch of texts offline exactly as the page does, for testing on real writing.
//   node tools/check_texts.mjs prepare IN.jsonl POOL.jsonl
//   python3 tools/calib/score_pool.py POOL.jsonl MODELS_DIR SCORES.json KEY1,KEY2,...
//   node tools/check_texts.mjs report IN.jsonl SCORES.json OUT.json [CALIBRATION.json]
// IN.jsonl rows are {id, text, ...}; any other fields are copied to the output. "prepare" writes every
// text and its 3-sentence windows (the page's splitSentences and windowsOf), already passed through the
// page's forDetector, for score_pool.py. "report" adds ZipPy and the tell rules, then computes what the
// page shows: each checker's percentile, the combined risk and band, sentence heat and the flagged
// sentences with their tells. tools/check_texts.sh runs all three steps.
import fs from 'fs';
import path from 'path';
import vm from 'vm';
import { fileURLToPath } from 'url';
import { splitSentences, words } from '../ai-checker/src/text.mjs';
import { forDetector } from '../ai-checker/src/normalize.mjs';
import { humanPct, combine, band, smoothHeat } from '../ai-checker/src/calibration.mjs';
import { findTells, styleStats, tellScore } from '../ai-checker/src/tells.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const SENT_FLAG = 90;  // as in app.mjs
const readJsonl = (p) => fs.readFileSync(p, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const windowsOf = (S, text) => S.map((_, i) => text.slice(S[Math.max(0, i - 1)].start, S[Math.min(S.length - 1, i + 1)].end));

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'prepare') {
  const [inPath, poolPath] = rest;
  const out = [];
  for (const r of readJsonl(inPath)) {
    out.push({ id: r.id, text: forDetector(r.text), win: false });
    const S = splitSentences(r.text);
    windowsOf(S, r.text).forEach((w, i) => out.push({ id: `${r.id}#w${i}`, text: forDetector(w), win: false }));
  }
  fs.writeFileSync(poolPath, out.map((r) => JSON.stringify(r)).join('\n') + '\n');
  console.log(`${out.length} texts to score (documents and sentence windows)`);
} else if (mode === 'report') {
  const [inPath, scoresPath, outPath, calPath = path.join(here, '../ai-checker/calibration.json')] = rest;
  const cal = JSON.parse(fs.readFileSync(calPath, 'utf8'));
  const m = cal.modes[cal.default_mode || 'article'];
  const sc = JSON.parse(fs.readFileSync(scoresPath, 'utf8'));
  const at = new Map(sc.ids.map((id, i) => [id, i]));
  const keys = Object.keys(sc.doc);
  // ZipPy with the page's own port, as tools/calib/zippy_pool.mjs does
  const root = path.join(here, '../ai-checker');
  const ctx = { TextEncoder, TextDecoder, console, setTimeout, clearTimeout }; ctx.self = ctx; vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(`${root}/vendor/lzma_worker-min.js`, 'utf8'), ctx);
  vm.runInContext(fs.readFileSync(`${root}/detectors/zippy.js`, 'utf8'), ctx);
  ctx.ZipPyBrowser.init(fs.readFileSync(`${root}/vendor/zippy-ai-generated.txt`, 'utf8'));
  const weight = (k) => m.ensemble?.weights?.[k] ?? 0;
  const winWeight = (k) => cal.window_weights?.[k] ?? 0;
  const results = [];
  for (const r of readJsonl(inPath)) {
    const i = at.get(r.id);
    if (i === undefined) throw new Error(`${r.id} was not scored`);
    const raw = Object.fromEntries(keys.map((k) => [k, sc.doc[k][i]]));
    const z = ctx.ZipPyBrowser.runOnTextChunked(r.text);
    raw.zippy = z[0] === 'AI' ? z[1] : -z[1];
    raw.tells = tellScore(r.text);
    const pcts = {};
    for (const [k, v] of Object.entries(raw)) if (m.checkers[k] && v !== null && v !== undefined) pcts[k] = humanPct(m.checkers[k].human_q, v);
    const e = combine(m, Object.fromEntries(Object.entries(pcts).filter(([k]) => weight(k) > 0)));
    // sentence heat: weighted window percentiles, then smoothed, as scoreSentencesInner()
    const S = splitSentences(r.text);
    const wkeys = keys.filter((k) => cal.windows?.[k] && winWeight(k) > 0);
    const per = Object.fromEntries(wkeys.map((k) => [k, S.map((_, j) => humanPct(cal.windows[k], sc.doc[k][at.get(`${r.id}#w${j}`)]))]));
    const own = S.map((_, j) => {
      let s = 0, w = 0;
      for (const k of wkeys) { s += per[k][j] * winWeight(k); w += winWeight(k); }
      return w ? s / w : null;
    });
    const heat = smoothHeat(own);
    const tells = findTells(r.text);
    // flagged sentences, as flaggedSentences() (default list; only when the answer is Medium or High)
    const scored = S.map((s, j) => ({ j, h: heat[j] })).filter((x) => x.h !== null).sort((a, b) => b.h - a.h);
    const flagged = !e || e.risk < 40 ? [] : (() => {
      const out = scored.filter((x) => x.h >= SENT_FLAG);
      const want = Math.min(scored.length, Math.max(2, Math.ceil(scored.length * 0.3)));
      for (const x of scored) { if (out.length >= want) break; if (!out.includes(x)) out.push(x); }
      return out.map((x) => x.j).sort((a, b) => a - b);
    })();
    const { text, ...meta } = r;
    results.push({
      ...meta, words: words(r.text), risk: e?.risk ?? null, band: e ? band(e.risk) : 'none', pct: e ? Math.round(e.pct * 10) / 10 : null,
      checkers: Object.fromEntries(Object.entries(pcts).map(([k, v]) => [k, Math.round(v * 10) / 10])),
      raw, style: styleStats(r.text),
      sentences: S.map((s, j) => ({
        text: s.text, heat: heat[j] === null ? null : Math.round(heat[j] * 10) / 10, flagged: flagged.includes(j),
        agree: wkeys.filter((k) => per[k][j] >= SENT_FLAG).length, tells: tells.filter((t) => t.start < s.end && t.end > s.start).map((t) => t.message),
      })),
      tells: tells.map((t) => ({ rule: t.rule, text: r.text.slice(t.start, t.end), message: t.message })),
    });
  }
  fs.writeFileSync(outPath, JSON.stringify(results, null, 1));
  const n = (b) => results.filter((x) => x.band === b).length;
  console.log(`${results.length} texts: ${n('high')} High, ${n('mid')} Medium, ${n('low')} Low, ${n('none')} not scored`);
} else {
  console.error('usage: node tools/check_texts.mjs prepare IN.jsonl POOL.jsonl | report IN.jsonl SCORES.json OUT.json [CAL.json]');
  process.exit(2);
}
