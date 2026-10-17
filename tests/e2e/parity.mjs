// Cross-check tools/check_texts.mjs against the page: run each text through the built site in Chromium and
// compare the risk, each checker's percentile and the flagged sentences with the offline report.
//   node tests/e2e/parity.mjs SITE_DIR IN.jsonl REPORT.json [MAX]
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const [site, inPath, reportPath, max = '12'] = process.argv.slice(2);
const pw = createRequire(path.join(here, '../../'))('playwright');
const PORT = 8809, BASE = `http://127.0.0.1:${PORT}/answer-desk/`;
const srv = spawn(process.execPath, [path.join(here, 'server.mjs'), path.resolve(site), String(PORT), '/answer-desk/'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const rows = fs.readFileSync(inPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l)).slice(0, Number(max));
const report = new Map(JSON.parse(fs.readFileSync(reportPath, 'utf8')).map((r) => [r.id, r]));
const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await (await browser.newContext({ viewport: { width: 1366, height: 900 } })).newPage();
let worst = { risk: 0, pct: 0 }, flagMismatch = 0;
try {
  await page.goto(BASE);
  for (const r of rows) {
    await page.fill('#editor', r.text);
    await page.click('#checkBtn');
    await page.waitForFunction(() => {
      const vals = [...document.querySelectorAll('#ledger .row .val')].map((v) => v.textContent);
      const done = (v) => /(Flags AI|Borderline|Not flagged|Failed|Retry|Turn on|not calibrated)/.test(v);
      return vals.length && document.getElementById('checkBtn').getAttribute('aria-busy') !== 'true' && vals.every(done)
        && /\d/.test(document.getElementById('riskScore').textContent) && !document.querySelector('#sentList .empty')?.textContent.includes('Scoring');
    }, null, { timeout: 600000, polling: 500 });
    await page.waitForTimeout(300);
    const got = await page.evaluate(() => ({
      risk: Number(document.getElementById('riskScore').textContent),
      pcts: Object.fromEntries([...document.querySelectorAll('#ledger .row')].map((row) => [row.dataset.key, Number((row.querySelector('.val .num')?.textContent || '').replace(/\D/g, '')) || null])),
      flagged: [...document.querySelectorAll('#sentList .sent q')].map((q) => q.textContent.trim()),
    }));
    const want = report.get(r.id);
    const dr = Math.abs(got.risk - want.risk);
    const dp = Math.max(0, ...Object.entries(want.checkers).filter(([k]) => got.pcts[k] !== null && got.pcts[k] !== undefined).map(([k, v]) => Math.abs(got.pcts[k] - Math.round(v))));
    const wf = want.sentences.filter((s) => s.flagged).map((s) => s.text.trim());
    const same = got.flagged.length === Math.min(14, wf.length) && got.flagged.every((t) => wf.includes(t));
    if (!same) flagMismatch++;
    worst = { risk: Math.max(worst.risk, dr), pct: Math.max(worst.pct, dp) };
    console.log(`${r.id}: page risk ${got.risk}, offline ${want.risk} (Δ${dr}); max checker Δ${dp}; flagged sentences ${same ? 'same' : `differ (page ${got.flagged.length}, offline ${wf.length})`}`);
  }
} finally {
  await browser.close(); srv.kill();
}
console.log(`\n${rows.length} texts: worst risk difference ${worst.risk}, worst checker percentile difference ${worst.pct}, flagged-sentence mismatches ${flagMismatch}`);
process.exit(worst.risk <= 1 && worst.pct <= 1 && flagMismatch === 0 ? 0 : 1);
