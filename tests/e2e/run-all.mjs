// End-to-end tests for the built site, in headless Chromium. Exits non-zero if any test fails.
//   node tests/e2e/run-all.mjs SITE_DIR
// Starts the gzip static server (like GitHub Pages) and the fake local rewriter, then checks:
// the example answer, a human answer, hidden-character clean-up, the rewrite loop through the local
// engine with every guard, the Claude copy/paste path, undo and versions, My writing, the phone
// layout, and that nothing logs an error or 404s.
import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const here = path.dirname(fileURLToPath(import.meta.url));
const site = path.resolve(process.argv[2] || 'site');
const PORT = 8807, LLM = 18080;
const BASE = `http://127.0.0.1:${PORT}/answer-desk/`;

function loadPlaywright() {
  for (const from of [path.join(here, '../../'), '/opt/node-tools/node_modules/']) {
    try { return createRequire(from + (from.endsWith('/') ? '' : '/'))('playwright'); } catch { /* next */ }
  }
  throw new Error('playwright is not installed (npm ci)');
}
const pw = loadPlaywright();
// CI installs Playwright's own Chromium; elsewhere point PW_CHROMIUM at an existing build
const launchOpts = process.env.PW_CHROMIUM ? { executablePath: process.env.PW_CHROMIUM } : {};

const procs = [];
function start(args) {
  const p = spawn(process.execPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(p);
  return new Promise((resolve) => { p.stdout.once('data', () => resolve(p)); setTimeout(() => resolve(p), 3000); });
}
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try { await fn(); results.push([name, 'ok', Date.now() - t0]); console.log(`ok   ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`); }
  catch (e) { results.push([name, 'FAIL', Date.now() - t0, e]); console.log(`FAIL ${name}: ${e?.stack || e}`); }
}
const assert = (c, msg) => { if (!c) throw new Error(msg); };

const HUMAN = `We grew the home-loan book by about 18% last year, mostly in Nagpur, Indore and Coimbatore. Our branch teams in those towns knew the builders personally, and that mattered more than any campaign we ran from Mumbai.

The hard part was collections. When the moratorium ended, roughly one in twelve salaried customers came back to us with a changed job or a pay cut. We did not push them into restructuring by default. Each case went to a three-person desk that looked at the bank statements, called the employer where it made sense, and agreed a plan the customer could actually keep. It was slow and it cost us staff time, but our GNPA stayed under 2% through the year, and very few of those customers slipped again.

If I did it again, I would set up that desk six months earlier and give the branch managers more say in it.`;

async function waitChecked(page, { all = false, timeout = 600000 } = {}) {
  await page.waitForFunction((all) => {
    const vals = [...document.querySelectorAll('#ledger .row .val')].map((v) => v.textContent);
    const done = (v) => /(Flags AI|Borderline|Reads human|Failed|Retry|Turn on|not calibrated)/.test(v);
    const busy = document.getElementById('checkBtn').getAttribute('aria-busy') === 'true';
    return vals.length && !busy && (all ? vals.every(done) : vals.filter(done).length >= 2) && /\d/.test(document.getElementById('riskScore').textContent);
  }, all, { timeout, polling: 1000 });
}
const risk = (page) => page.evaluate(() => Number(document.getElementById('riskScore').textContent));

async function main() {
  await start([path.join(here, 'server.mjs'), site, String(PORT), '/answer-desk/']);
  await start([path.join(here, 'fake-llm.mjs'), String(LLM)]);
  const browser = await pw.chromium.launch(launchOpts);
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  const errors = [], missing = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/favicon/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('response', (r) => { if (r.status() === 404 && r.url().startsWith(BASE)) missing.push(r.url()); });
  await page.addInitScript((u) => { localStorage.setItem('ard.localUrl', JSON.stringify(u)); }, `http://127.0.0.1:${LLM}`);

  await test('example answer scores high', async () => {
    await page.goto(BASE);
    await waitChecked(page, { all: true });
    const r = await risk(page);
    assert(r >= 65, `example risk ${r}, expected High (≥65)`);
    const flagged = await page.locator('#sentList .sent').count();
    assert(flagged >= 2, `only ${flagged} flagged sentences`);
    const tells = await page.locator('#tellList .tell-item').count();
    assert(tells >= 3, `only ${tells} AI tells listed for the example`);
  });

  await test('human answer scores lower than the example', async () => {
    const before = await risk(page);
    await page.fill('#editor', HUMAN);
    await page.click('#checkBtn');
    await waitChecked(page, { all: true });
    const r = await risk(page);
    assert(r < before && r < 65, `human answer risk ${r} (example ${before})`);
  });

  await test('hidden and look-alike characters are found and cleaned', async () => {
    await page.fill('#editor', 'We lent ₹2.5 crore in FY24.\u200b Our GNPA fell to 1.2%. The bаnk agreed.');  // Cyrillic а
    await page.waitForSelector('#cleanBanner:not([hidden])', { timeout: 5000 });
    await page.click('#cleanBtn');
    const t = await page.inputValue('#editor');
    assert(!/\u200b/.test(t) && t.includes('bank') && t.includes('₹2.5 crore'), `cleaned text: ${JSON.stringify(t)}`);
    await page.click('#undoBtn');
    assert((await page.inputValue('#editor')).includes('\u200b'), 'undo did not restore the original');
  });

  await test('rewrite loop through the local engine keeps every fact and lowers the score', async () => {
    // reload with no draft so the example answer comes back and is checked straight away (the page
    // saves the editor on pagehide, so empty it first or the old draft is written back)
    await page.fill('#editor', '');
    await page.evaluate(() => { localStorage.removeItem('ard.draft'); localStorage.removeItem('ard.seenExample'); localStorage.setItem('ard.engine', JSON.stringify('local')); });
    await page.goto(BASE);
    await waitChecked(page, { all: true });
    const before = await risk(page);
    await page.click('#rewriteBtn');
    await page.waitForSelector('#engineList .engine .status.ok', { timeout: 20000 });
    await page.check('#engineList input[value="local"]');
    await page.click('#startBtn');
    await page.waitForSelector('#rwResult:not([hidden])', { timeout: 900000 });
    const facts = await page.textContent('#reviewFacts');
    assert(/Fact check passed/.test(facts), `fact report: ${facts}`);
    const summary = await page.textContent('#rwSummary');
    assert(/sentences changed/.test(summary), `summary: ${summary}`);
    await page.waitForFunction(() => /Overall risk/.test(document.getElementById('rwCompare').textContent), null, { timeout: 300000 });
    await page.click('#acceptBtn');
    await waitChecked(page, { all: true });
    const after = await risk(page);
    const text = await page.inputValue('#editor');
    for (const fact of ['GNPA', '1.5%', 'Tier 2', 'Tier 3', 'DSAs']) assert(text.includes(fact), `lost ${fact}`);
    assert(after < before, `risk did not drop: ${before} → ${after}`);
    await page.click('#undoBtn');
    assert((await page.inputValue('#editor')).startsWith("In today's dynamic lending landscape"), 'undo did not bring the original back');
  });

  await test('Claude copy/paste path parses variants and applies the guards', async () => {
    await page.click('#checkBtn');
    await waitChecked(page, { all: true });
    await page.click('#rewriteBtn');
    await page.check('#engineList input[value="manual"]');
    await page.click('#startBtn');
    await page.waitForSelector('#manualBox:not([hidden])');
    const req = await page.inputValue('#promptOut');
    assert(req.length > 200 && /JSON/.test(req), 'request missing or not asking for JSON');
    const ids = [...req.matchAll(/"(\d+)"\s*:/g)].map((m) => m[1]);
    const reply = '```json\n' + JSON.stringify(Object.fromEntries((ids.length ? ids : ['0']).map((id) => [id, ['Builders and DSAs bring us most of our good customers, so we stay close to them.', 'This version drops a fact entirely.']]))) + '\n```';
    await page.fill('#pasteBack', reply);
    await page.click('#usePastedBtn');
    await page.waitForSelector('#rwResult:not([hidden])', { timeout: 300000 });
    const summary = await page.textContent('#rwSummary');
    assert(/thrown out|No version passed|changed/.test(summary), `summary: ${summary}`);
    await page.click('#keepMineBtn');
  });

  await test('versions and My writing', async () => {
    await page.click('#versionsBtn');
    assert((await page.locator('#versionList .ver').count()) >= 2, 'no versions saved');
    await page.click('#versionsOverlay [data-close]');
    await page.click('#myWritingBtn');
    await page.fill('#sampleInput', `${HUMAN}\n---\n${HUMAN.replace('18%', '22%').replace('Nagpur', 'Nashik')}`);
    await page.click('#addSampleBtn');
    await page.waitForFunction(() => document.querySelectorAll('#sampleList .sample').length >= 2);
    await page.click('#checkSamplesBtn');
    await page.waitForSelector('#samplesSummary:not([hidden])', { timeout: 300000 });
    await page.click('#writingOverlay [data-close]');
  });

  await test('phone layout has no horizontal scroll', async () => {
    const m = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await m.goto(BASE);
    await m.waitForTimeout(1500);
    const over = await m.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    assert(!over, 'horizontal overflow at 390 px');
    await m.close();
  });

  await test('no console errors and no missing files', async () => {
    assert(!errors.length, `console errors:\n${errors.slice(0, 8).join('\n')}`);
    assert(!missing.length, `404s:\n${missing.slice(0, 8).join('\n')}`);
  });

  await browser.close();
}

main().catch((e) => { console.error(e); results.push(['setup', 'FAIL', 0, e]); }).finally(() => {
  for (const p of procs) p.kill();
  const failed = results.filter((r) => r[1] !== 'ok');
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
});
