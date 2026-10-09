// Headless play-test harness. Boots the real game in Chromium (SwiftShader WebGL), runs it,
// optionally drives a scenario, captures errors + screenshots, prints a JSON report.
//
// Usage:
//   node tools/smoke.mjs [--seconds 8] [--shot .smoke/shot.png] [--no-build] [--seed 1337]
//                        [--scenario path/to/scenario.mjs] [--eval "js expression run in page after start"]
//                        [--size 1280x720] [--keep-going] [--tag myname]
//   --tag NAME isolates concurrent runs: builds dist/dev-NAME.html and writes screenshots to .smoke/NAME/
//
// A scenario module default-exports: async ({ page, game, keys, wait, shot, log }) => any
//   game(fnOrString, arg)    -> page.evaluate with `window.game` available as the first param: game(g => g.player.position.x)
//   keys(code, ms)           -> hold a key (KeyboardEvent.code, e.g. 'KeyW') for ms milliseconds
//   wait(ms)                 -> sleep
//   shot(name)               -> screenshot to .smoke/<name>.png
//   log(...)                 -> adds to report.log
// Exit code 1 when the page threw uncaught errors or logged console.error.
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const seconds = parseFloat(opt('seconds', '6'));
const tag = opt('tag', '');
const outDir = path.join(root, '.smoke', tag);
const devFile = path.join(root, 'dist', tag ? `dev-${tag}.html` : 'dev.html');
fs.mkdirSync(outDir, { recursive: true });
const shotPath = opt('shot', path.join(outDir, 'shot.png'));
const [w, h] = opt('size', '1280x720').split('x').map(Number);

if (!flag('no-build')) {
  try { execFileSync(process.execPath, [path.join(root, 'tools/build.mjs'), '--dev', '--out', devFile], { stdio: 'inherit' }); }
  catch (e) { console.log(JSON.stringify({ ok: false, pageErrors: ['BUILD FAILED (see stderr above)'] })); process.exit(1); }
}

const report = { ok: true, pageErrors: [], consoleErrors: [], warnings: {}, log: [], stats: null, scenario: null, bootMs: 0 };
const browser = await chromium.launch({
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: w, height: h } });
page.on('pageerror', (e) => report.pageErrors.push(String(e.stack || e)));
page.on('console', (m) => {
  const t = m.text();
  if (m.type() === 'error') report.consoleErrors.push(t);
  else if (m.type() === 'warning') report.warnings[t] = (report.warnings[t] || 0) + 1;
  else if (flag('verbose')) console.log('[page]', t);
});

const url = pathToFileURL(devFile).href + `?autostart=1&seed=${opt('seed', '1337')}${opt('params', '') ? '&' + opt('params', '') : ''}`;
const t0 = Date.now();
await page.goto(url);
try {
  await page.waitForFunction(() => window.game && window.game.state === 'playing', null, { timeout: 120000, polling: 250 });
} catch (e) {
  report.pageErrors.push('BOOT TIMEOUT: game never reached state "playing" (state=' +
    (await page.evaluate(() => window.game && window.game.state).catch(() => '?')) + ')');
}
report.bootMs = Date.now() - t0;

const game = (fn, arg) => page.evaluate(typeof fn === 'string' ? fn : `(${fn})(window.game, ${JSON.stringify(arg)})`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const keys = async (code, ms) => { await page.keyboard.down(code); await wait(ms); await page.keyboard.up(code); };
const shot = (name) => page.screenshot({ path: path.join(outDir, name.endsWith('.png') ? name : name + '.png') });
const log = (...a) => report.log.push(a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' '));

try {
  const scen = opt('scenario', null);
  if (scen) {
    const mod = await import(pathToFileURL(path.resolve(scen)).href + '?t=' + Date.now());
    report.scenario = await mod.default({ page, game, keys, wait, shot, log });
  }
  const ev = opt('eval', null);
  if (ev) report.scenario = await page.evaluate(ev);
} catch (e) {
  report.pageErrors.push('SCENARIO ERROR: ' + (e.stack || e));
}
await wait(seconds * 1000);
report.stats = await page.evaluate(() => (window.game && window.game.debug && window.game.debug.stats) ? window.game.debug.stats() : null).catch((e) => String(e));
await page.screenshot({ path: shotPath });
report.screenshot = path.relative(root, shotPath);
await browser.close();

report.ok = report.pageErrors.length === 0 && report.consoleErrors.length === 0;
// keep report readable
report.pageErrors = [...new Set(report.pageErrors)].slice(0, 30);
report.consoleErrors = [...new Set(report.consoleErrors)].slice(0, 30);
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok || flag('keep-going') ? 0 : 1);
