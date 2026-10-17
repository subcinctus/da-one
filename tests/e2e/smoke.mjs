// Smoke test for the live site: the page loads, checkers download and pass their integrity check,
// the example answer gets a risk score, and the fact guard catches a changed number.
//   node tests/e2e/smoke.mjs https://<owner>.github.io/answer-desk/
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const url = process.argv[2];
let pw;
for (const from of [path.join(here, '../../') , '/opt/node-tools/node_modules/']) {
  try { pw = createRequire(from)('playwright'); break; } catch { /* next */ }
}
const browser = await pw.chromium.launch(process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
let ok = true;
const fail = (msg) => { ok = false; console.log('FAIL', msg); };
try {
  const res = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  if (!res || res.status() !== 200) fail(`page returned ${res?.status()}`);
  const manifest = await page.evaluate(async () => (await fetch('models/manifest.json')).json());
  const keys = Object.keys(manifest.models || {});
  if (keys.length < 3) fail(`manifest lists ${keys.length} models`);
  if (!manifest.calibration?.modes?.article) fail('manifest has no calibration');
  await page.waitForFunction(() => /\d/.test(document.getElementById('riskScore').textContent), null, { timeout: 600000, polling: 2000 });
  const risk = Number(await page.textContent('#riskScore'));
  if (!(risk >= 40)) fail(`example answer risk ${risk}, expected at least Medium`);
  const guard = await page.evaluate(async () => {
    const { compareFacts } = await import('./src/facts.mjs');
    return compareFacts('GNPA fell to 1.5% in FY24.', 'GNPA fell to 1.6% in FY24.');
  });
  if (guard.ok !== false) fail('fact guard did not catch 1.5% → 1.6%');
  if (errors.length) fail(`console errors: ${errors.slice(0, 5).join(' | ')}`);
  console.log(`${ok ? 'ok' : 'FAILED'}: ${keys.length} models in the manifest, example risk ${risk}`);
} catch (e) {
  fail(e?.stack || String(e));
} finally {
  await browser.close();
}
process.exit(ok ? 0 : 1);
