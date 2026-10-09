// HUD stylesheet (injected once from JS; there are no CSS files). Screens (panels, inventory, map, menus, touch,
// loading) live in styles_screens.js. Sizes are authored for 1280x720; corner clusters scale with --s.
import { SCREEN_CSS } from './styles_screens.js';

const HUD_CSS = `
#ui { font-synthesis: none; }
#ui { --s: 1; --hud-green: #74d46a; --hp: #4fc24f; --hp-low: #e0443a; --armor: #3f8fe0; --wp: #e040fb;
  --gold: #f5c518; --busted: #3d8bff; --wasted: #d32027; --pad: 22px;
  --sl: env(safe-area-inset-left, 0px); --sr: env(safe-area-inset-right, 0px);
  --st: env(safe-area-inset-top, 0px); --sb: env(safe-area-inset-bottom, 0px); }
.bc-hud { position: absolute; inset: 0; pointer-events: none; font-family: var(--font); color: #fff;
  transition: opacity .35s ease; -webkit-font-smoothing: antialiased; }
.bc-hud { z-index: 1; }
.bc-hud.bc-hud-top { z-index: 55; }
.bc-hud.off { opacity: 0; }
.bc-hud.cine .cl { opacity: 0; transition: opacity .6s ease; }
.bc-hud .cl { transition: opacity .4s ease; }
.bc-hud.off * { animation-play-state: paused !important; }
.bc-hud .cl { position: absolute; transform: scale(var(--s)); }
.bc-tl { left: calc(var(--pad) + var(--sl)); top: calc(18px + var(--st)); transform-origin: 0 0; width: 380px; }
.bc-tc { left: 50%; top: calc(16px + var(--st)); transform-origin: 50% 0; }
.bc-hud .bc-tc { transform: translateX(-50%) scale(var(--s)); }
.bc-tr { right: calc(var(--pad) + var(--sr)); top: calc(16px + var(--st)); transform-origin: 100% 0;
  display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.bc-bl { left: calc(var(--pad) + var(--sl)); bottom: calc(18px + var(--sb)); transform-origin: 0 100%; }
.bc-br { right: calc(var(--pad) + var(--sr)); bottom: calc(18px + var(--sb)); transform-origin: 100% 100%;
  display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
.bc-bc { left: 50%; bottom: calc(10px + var(--sb)); transform-origin: 50% 100%;
  display: flex; flex-direction: column; align-items: center; gap: 6px; }
.bc-hud .bc-bc { transform: translateX(-50%) scale(var(--s)); }
.bc-center { position: absolute; left: 50%; top: 50%; width: 0; height: 0; }

/* text helpers */
.bc-key { display: inline-block; min-width: 1.55em; padding: 0 .38em; margin: 0 .08em; height: 1.5em; line-height: 1.42em;
  text-align: center; font: 700 .86em/1.42em var(--font); color: #111; background: linear-gradient(#fdfdfd, #d7dbe2);
  border: 1px solid #000; border-radius: 4px; box-shadow: 0 2px 0 #000, inset 0 -2px 0 rgba(0,0,0,.18);
  vertical-align: .08em; text-shadow: none; }
.hl-y { color: #ffd23f; } .hl-g { color: #74d46a; } .hl-r { color: #ff5a4f; } .hl-b { color: #63a8ff; }
.hl-p { color: #e58cff; } .hl-o { color: #ffa23a; }
.bc-out { text-shadow: -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 2px 3px rgba(0,0,0,.6); }

/* ---------- top-left: help text + fps ---------- */
.bc-fps { font: 600 12px/1 ui-monospace, Menlo, Consolas, monospace; color: #cfe8cf; background: rgba(0,0,0,.55);
  padding: 4px 7px; border-radius: 4px; display: inline-block; margin-bottom: 8px; }
.bc-fps.hide { display: none; }
.bc-notes { display: flex; flex-direction: column; gap: 8px; align-items: flex-start; }
.bc-note { position: relative; max-width: 380px; padding: 11px 15px 12px 15px; background: rgba(0,0,0,.78);
  border-radius: 3px; font: 500 15px/1.38 var(--font); color: #f4f4f4; box-shadow: 0 6px 18px rgba(0,0,0,.25);
  transform-origin: 0 0; animation: bc-note-in .28s cubic-bezier(.2,.9,.3,1.2) both; overflow-wrap: anywhere; }
.bc-note.accent { padding-left: 19px; }
.bc-note.accent::before { content: ''; position: absolute; left: 0; top: 0; bottom: 0; width: 4px; background: var(--c, var(--gold));
  border-radius: 3px 0 0 3px; }
.bc-note.out { animation: bc-note-out .32s ease-in both; }
.bc-note .bar { position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: rgba(255,255,255,.28);
  transform-origin: 0 0; transition: transform .1s linear; }
@keyframes bc-note-in { from { opacity: 0; transform: translateX(-24px) scale(.96); } to { opacity: 1; transform: none; } }
@keyframes bc-note-out { to { opacity: 0; transform: translateX(-16px); } }

/* ---------- top-centre: timer ---------- */
.bc-timer { display: none; align-items: baseline; gap: 10px; padding: 6px 18px 7px; background: rgba(0,0,0,.62);
  border-radius: 6px; box-shadow: 0 4px 14px rgba(0,0,0,.3); }
.bc-timer.on { display: flex; animation: bc-pop .35s ease both; }
.bc-timer .lbl { font: 700 12px/1 var(--font); letter-spacing: .14em; color: #c9ced6; }
.bc-timer .val { font: 800 32px/1 var(--font-display); letter-spacing: .03em; color: #fff; font-variant-numeric: tabular-nums; }
.bc-timer.low .val { color: #ff4d42; animation: bc-throb 1s ease-in-out infinite; }
@keyframes bc-throb { 50% { transform: scale(1.12); } }
@keyframes bc-pop { from { opacity: 0; transform: scale(.7); } to { opacity: 1; transform: none; } }

/* ---------- top-right: clock, weapon, wanted, money ---------- */
.bc-clock { display: flex; align-items: center; gap: 6px; padding: 3px 9px 3px 7px; background: rgba(0,0,0,.45); border-radius: 12px;
  font: 600 14px/1.2 var(--font); color: #eef2f7; font-variant-numeric: tabular-nums; }
.bc-clock .sun { width: 11px; height: 11px; border-radius: 50%; background: #ffd23f; box-shadow: 0 0 6px #ffb300; }
.bc-clock.night .sun { background: transparent; box-shadow: inset -4px -2px 0 0 #dfe6ff; transform: rotate(-20deg); }
.bc-weapon { display: flex; align-items: center; gap: 10px; min-height: 52px; transition: opacity .3s; }
.bc-weapon.hide { display: none; }
.bc-weapon .ico { width: 60px; height: 60px; display: grid; place-items: center;
  filter: drop-shadow(0 2px 0 rgba(0,0,0,.65)) drop-shadow(0 0 1px #000); }
.bc-weapon .ico img { width: 60px; height: 60px; image-rendering: pixelated; }
.bc-weapon .ico .emoji { font-size: 40px; line-height: 1; }
.bc-weapon .ammo { font: 800 26px/1 var(--font-display); letter-spacing: .02em; color: #fff; font-variant-numeric: tabular-nums;
  text-align: right; white-space: nowrap; -webkit-text-stroke: 1.2px #000; paint-order: stroke fill; text-shadow: 0 2px 0 #000; }
.bc-weapon .ammo .res { color: #d5dae1; font-size: 20px; }
.bc-weapon .ammo.empty .mag { color: #ff5a4f; }
.bc-weapon .rl { display: block; font: 800 11px/1 var(--font); letter-spacing: .16em; color: #ffd23f; margin-top: 4px; text-align: right; }
.bc-weapon .rl:empty { display: none; }
.bc-stars { display: flex; gap: 3px; height: 30px; transition: opacity .6s ease; }
.bc-stars.zero { opacity: 0; }
.bc-star { width: 30px; height: 30px; }
.bc-star svg { width: 100%; height: 100%; display: block; overflow: visible; }
.bc-star path { fill: rgba(0,0,0,.35); stroke: rgba(255,255,255,.45); stroke-width: 1.3; stroke-linejoin: round; }
.bc-star.on path { fill: #fff; stroke: #000; stroke-width: 2.2; paint-order: stroke; }
.bc-star.on { filter: drop-shadow(0 2px 2px rgba(0,0,0,.55)); }
.bc-stars.search .bc-star.on { animation: bc-star-blink .9s steps(1) infinite; }
@keyframes bc-star-blink { 50% { opacity: .22; } }
.bc-money { font: 800 38px/1 var(--font-display); color: var(--hud-green); letter-spacing: .02em; font-variant-numeric: tabular-nums;
  -webkit-text-stroke: 1.6px #000; paint-order: stroke fill;
  text-shadow: 0 3px 0 #000, 0 0 8px rgba(0,0,0,.5); white-space: nowrap; }
.bc-delta { height: 24px; font: 800 24px/1 var(--font-display); letter-spacing: .02em; -webkit-text-stroke: 1.2px #000;
  paint-order: stroke fill; text-shadow: 0 2px 0 #000; opacity: 0; transition: opacity .4s; }
.bc-delta.on { opacity: 1; animation: bc-delta-in .3s ease both; }
.bc-delta.pos { color: var(--hud-green); } .bc-delta.neg { color: #ff5a4f; }
@keyframes bc-delta-in { from { transform: translateY(-8px); opacity: 0; } }

/* ---------- bottom-left: radar + bars ---------- */
.bc-radar-wrap { position: relative; width: 236px; }
.bc-radar { position: relative; width: 236px; height: 156px; border-radius: 12px; overflow: hidden; background: #1b3f74;
  box-shadow: 0 0 0 3px rgba(0,0,0,.82), 0 8px 22px rgba(0,0,0,.4); }
.bc-radar canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bc-radar.alert { animation: bc-radar-alert .7s steps(1) infinite; }
@keyframes bc-radar-alert { 0% { box-shadow: 0 0 0 3px #e0242a, 0 0 18px rgba(224,36,42,.55); }
  50% { box-shadow: 0 0 0 3px #2d6bff, 0 0 18px rgba(45,107,255,.55); } }
.bc-bars { display: flex; gap: 4px; margin-top: 7px; height: 9px; }
.bc-bar { position: relative; height: 100%; background: rgba(0,0,0,.6); box-shadow: 0 0 0 2px rgba(0,0,0,.75); overflow: hidden; }
.bc-bar.hp { flex: 0 0 57%; } .bc-bar.ar { flex: 1 1 auto; }
.bc-bar i { position: absolute; left: 0; top: 0; bottom: 0; width: 100%; transform-origin: 0 0; }
.bc-bar .chip { background: rgba(255,255,255,.55); transition: transform .6s ease .25s; }
.bc-bar .fill { background: var(--hp); box-shadow: inset 0 2px 0 rgba(255,255,255,.25); }
.bc-bar.ar .fill { background: var(--armor); }
.bc-bar.hp.low .fill { background: var(--hp-low); animation: bc-blink .8s steps(1) infinite; }
.bc-bar.hp.dead .fill { background: #555; }
@keyframes bc-blink { 50% { opacity: .45; } }
.bc-breath { display: flex; gap: 3px; margin-top: 6px; height: 12px; transition: opacity .3s; }
.bc-breath.hide { opacity: 0; }
.bc-breath b { width: 12px; height: 12px; border-radius: 50%; background: radial-gradient(circle at 35% 35%, #fff 0 18%, #7fd3ff 30%, #2b7fc9 85%);
  box-shadow: 0 0 0 1px rgba(0,0,0,.55); transition: transform .2s, opacity .2s; }
.bc-breath b.pop { transform: scale(.2); opacity: 0; }

/* ---------- bottom-right: names + speedometer ---------- */
.bc-names { display: flex; flex-direction: column; align-items: flex-end; gap: 2px; text-align: right; }
.bc-vname { font: 800 34px/1.05 var(--font-display); letter-spacing: .03em; color: #fff; -webkit-text-stroke: 1.2px #000;
  paint-order: stroke fill; text-shadow: 0 3px 0 rgba(0,0,0,.85); opacity: 0; transform: translateX(14px);
  transition: opacity .45s ease, transform .45s ease; white-space: nowrap; }
.bc-area { font: 700 18px/1.2 var(--font); letter-spacing: .12em; text-transform: uppercase; color: #fff; opacity: 0;
  transform: translateX(14px); transition: opacity .45s ease, transform .45s ease; white-space: nowrap; }
.bc-vname.on, .bc-area.on { opacity: 1; transform: none; }
.bc-speedo { position: relative; width: 132px; height: 132px; display: none; }
.bc-speedo.on { display: block; animation: bc-pop .3s ease both; }
.bc-speedo svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.bc-speedo .trk { fill: none; stroke: rgba(0,0,0,.55); stroke-width: 10; stroke-linecap: round; }
.bc-speedo .arc { fill: none; stroke: #fff; stroke-width: 6; stroke-linecap: round; transition: stroke .3s; }
.bc-speedo .arc.fast { stroke: #ffd23f; } .bc-speedo .arc.max { stroke: #ff5a4f; }
.bc-speedo .tick { stroke: rgba(255,255,255,.55); stroke-width: 2; }
.bc-speedo .face { fill: rgba(0,0,0,.5); }
.bc-speedo .num { position: absolute; left: 0; right: 0; top: 40px; text-align: center; font: 800 38px/1 var(--font-display);
  color: #fff; font-variant-numeric: tabular-nums; text-shadow: 0 2px 0 #000; }
.bc-speedo .unit { position: absolute; left: 0; right: 0; top: 81px; text-align: center; font: 800 11px/1 var(--font);
  letter-spacing: .2em; color: #c9ced6; }
.bc-speedo .alt { position: absolute; left: 0; right: 0; top: 97px; text-align: center; font: 700 11px/1 var(--font); color: #7fd3ff; }
.bc-speedo .vhp { position: absolute; left: 30px; right: 30px; bottom: 6px; height: 5px; background: rgba(0,0,0,.6);
  box-shadow: 0 0 0 1.5px rgba(0,0,0,.7); }
.bc-speedo .vhp i { position: absolute; inset: 0; background: #e8eef5; transform-origin: 0 0; }
.bc-speedo .vhp.warn i { background: #ffb02e; } .bc-speedo .vhp.crit i { background: #ff4d42; animation: bc-blink .5s steps(1) infinite; }

/* ---------- bottom-centre: prompt, objective, item name, hotbar ---------- */
.bc-prompt { display: none; align-items: center; gap: 8px; padding: 9px 16px 10px; max-width: 560px; background: rgba(0,0,0,.76);
  border-radius: 4px; font: 600 16px/1.3 var(--font); color: #fff; box-shadow: 0 6px 16px rgba(0,0,0,.25); text-align: center; }
.bc-prompt.on { display: flex; animation: bc-prompt-in .18s ease both; }
@keyframes bc-prompt-in { from { opacity: 0; transform: translateY(6px); } }
.bc-obj { display: none; max-width: 720px; padding: 0 12px; text-align: center; font: 600 21px/1.3 var(--font); color: #fff;
  text-shadow: 0 0 2px #000, 0 2px 2px #000, 0 0 10px rgba(0,0,0,.6); }
.bc-obj.on { display: block; }
.bc-iname { height: 22px; font: 700 17px/22px var(--font); color: #fff; text-shadow: 2px 2px 0 #3f3f3f, 0 0 6px rgba(0,0,0,.5);
  opacity: 0; transition: opacity .5s ease; white-space: nowrap; }
.bc-iname.on { opacity: 1; transition: none; }
.bc-iname small { font-weight: 600; color: #ffd23f; margin-left: 6px; }
.bc-hotbar.dim { opacity: .5; }
.bc-hotbar { transition: opacity .4s; display: flex; padding: 3px; background: rgba(0,0,0,.42); box-shadow: 0 0 0 2px rgba(0,0,0,.85), 0 8px 20px rgba(0,0,0,.35); }
.bc-slot { position: relative; width: 46px; height: 46px; border: 3px solid; border-color: rgba(55,55,55,.9) rgba(255,255,255,.55) rgba(255,255,255,.55) rgba(55,55,55,.9);
  background: rgba(139,139,139,.42); display: grid; place-items: center; }
.bc-slot .ico { width: 34px; height: 34px; display: grid; place-items: center; }
.bc-slot .ico img, .bc-islot .ico img { width: 100%; height: 100%; image-rendering: pixelated; }
.bc-slot .ico .emoji { font-size: 24px; line-height: 1; }
.bc-slot .cnt, .bc-islot .cnt { position: absolute; right: 1px; bottom: -1px; font: 700 14px/1 ui-monospace, Menlo, Consolas, monospace;
  color: #fff; text-shadow: 2px 2px 0 #3f3f3f; pointer-events: none; }
.bc-slot .cnt.ammo, .bc-islot .cnt.ammo { font-size: 11px; color: #ffe27a; }
.bc-slot .cnt.ammo.zero, .bc-islot .cnt.ammo.zero { color: #ff6b5f; }
.bc-slot .num { position: absolute; left: 2px; top: 1px; font: 700 9px/1 var(--font); color: rgba(255,255,255,.5); }
.bc-slot.sel { z-index: 1; }
.bc-slot.sel::after { content: ''; position: absolute; inset: -7px; border: 3px solid #fff; box-shadow: 0 0 0 2px #000, inset 0 0 0 2px #000;
  pointer-events: none; animation: bc-sel .14s ease-out; }
@keyframes bc-sel { from { transform: scale(.86); } }
.bc-slot.sel .ico { transform: scale(1.06); }

/* ---------- centre: crosshair, ring, hit marker, damage direction ---------- */
.bc-xh { position: absolute; left: 0; top: 0; transition: opacity .12s; }
.bc-xh.hide { opacity: 0; }
.bc-xh i { position: absolute; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.6); border-radius: 1px; }
.bc-xh .dot { width: 4px; height: 4px; left: -2px; top: -2px; border-radius: 50%; }
.bc-xh .ln { width: 2px; height: 9px; left: -1px; top: -4.5px; }
.bc-xh .ln.h { width: 9px; height: 2px; left: -4.5px; top: -1px; }
.bc-xh.nolines .ln { opacity: 0; }
.bc-xh.enemy i { background: #ff3b30; }
.bc-hit { position: absolute; left: 0; top: 0; opacity: 0; }
.bc-hit i { position: absolute; width: 2.5px; height: 10px; left: -1.25px; top: -5px; background: #fff; box-shadow: 0 0 0 1px rgba(0,0,0,.55); }
.bc-hit.kill i { background: #ff3b30; width: 3px; height: 13px; }
.bc-hit.on { animation: bc-hit .32s ease-out both; }
@keyframes bc-hit { 0% { opacity: 1; transform: scale(1.35); } 60% { opacity: 1; transform: scale(1); } 100% { opacity: 0; } }
.bc-ring { position: absolute; left: -26px; top: -26px; width: 52px; height: 52px; opacity: 0; transition: opacity .15s; }
.bc-ring.on { opacity: 1; }
.bc-ring svg { width: 100%; height: 100%; transform: rotate(-90deg); }
.bc-ring .bg { fill: none; stroke: rgba(0,0,0,.45); stroke-width: 5; }
.bc-ring .fg { fill: none; stroke: #fff; stroke-width: 3; stroke-linecap: round; }
.bc-dmgdir { position: absolute; left: -140px; top: -140px; width: 280px; height: 280px; border-radius: 50%; border: 7px solid transparent;
  border-top-color: rgba(230,30,30,.88); filter: blur(1.2px); opacity: 0; }

/* ---------- full-screen FX: vignette, low hp, scope ---------- */
.bc-vig { position: absolute; inset: 0; opacity: 0; background: radial-gradient(ellipse at center, rgba(0,0,0,0) 48%, rgba(170,0,0,.5) 80%, rgba(120,0,0,.85) 100%); }
.bc-scope { position: absolute; inset: 0; display: none;
  background: radial-gradient(circle at 50% 50%, rgba(0,0,0,0) 0, rgba(0,0,0,0) 35vmin, rgba(0,0,0,.9) 35.4vmin, #000 37vmin); }
.bc-scope.on { display: block; }
.bc-scope::before, .bc-scope::after { content: ''; position: absolute; left: 50%; top: 50%; background: rgba(0,0,0,.85); }
.bc-scope::before { width: 70vmin; height: 2px; transform: translate(-50%, -50%); }
.bc-scope::after { height: 70vmin; width: 2px; transform: translate(-50%, -50%); }
.bc-scope i { position: absolute; left: 50%; top: 50%; width: 6px; height: 6px; margin: -3px; border-radius: 50%; background: #e0242a; }

/* ---------- big message (WASTED / BUSTED / MISSION PASSED) ---------- */
.bc-big { position: absolute; inset: 0; display: none; pointer-events: none; z-index: 5; }
.bc-big.on { display: block; }
.bc-big .lb { position: absolute; left: 0; right: 0; height: 12vh; background: #000; transition: transform .6s cubic-bezier(.2,.8,.2,1); }
.bc-big.thin .lb { height: 7vh; }
.bc-big .lb.t { top: 0; transform: translateY(-100%); } .bc-big .lb.b { bottom: 0; transform: translateY(100%); }
.bc-big.show .lb { transform: none; }
.bc-big .band { position: absolute; left: 0; right: 0; top: 50%; transform: translateY(-50%); padding: 3vh 0 3.4vh;
  background: linear-gradient(90deg, rgba(0,0,0,0), rgba(0,0,0,.55) 22%, rgba(0,0,0,.55) 78%, rgba(0,0,0,0)); text-align: center;
  opacity: 0; transition: opacity .4s ease; }
.bc-big.show .band { opacity: 1; }
.bc-big .ttl { font: 800 clamp(46px, 9.5vmin, 118px)/1 var(--font-display); letter-spacing: .05em; color: var(--c, #fff);
  -webkit-text-stroke: 2.5px #000; paint-order: stroke fill; text-shadow: 0 5px 0 rgba(0,0,0,.85), 0 0 30px rgba(0,0,0,.6);
  text-transform: uppercase; }
.bc-big.show .ttl { animation: bc-big-in .7s cubic-bezier(.16,1.1,.3,1) both; }
.bc-big .sub { margin-top: 1.4vh; font: 700 clamp(16px, 2.6vmin, 28px)/1.25 var(--font); color: #fff; letter-spacing: .04em;
  text-shadow: 0 2px 3px #000; }
.bc-big.show .sub { animation: bc-fade-up .6s ease .25s both; }
.bc-big.hide .lb.t { transform: translateY(-100%); } .bc-big.hide .lb.b { transform: translateY(100%); }
.bc-big.hide .band { opacity: 0; transition-duration: .5s; }
@keyframes bc-big-in { from { opacity: 0; transform: scale(1.5); letter-spacing: .3em; } to { opacity: 1; transform: none; } }
@keyframes bc-fade-up { from { opacity: 0; transform: translateY(10px); } }

/* ---------- touch / portrait adjustments ---------- */
.bc-hud.touch:not(.bc-hud-top) { z-index: 31; }
.bc-hud-top.below-header .bc-tl { top: calc(84px + var(--st)); }
.bc-hud.touch .bc-bl { bottom: auto; top: calc(12px + var(--st)); transform-origin: 0 0; }
.bc-hud.touch .bc-tl { top: calc(var(--st) + 16px + 196px * var(--s)); width: 340px; }
.bc-hud.touch .bc-slot { pointer-events: auto; }
.bc-hud.touch .bc-slot .num { display: none; }
.bc-hud.portrait .bc-tr { gap: 2px; }
/* touch portrait: the mission timer moves under the money (the radar owns the top-left) */
.bc-hud.touch.portrait .bc-tc { left: auto; right: calc(var(--pad) + var(--sr)); top: calc(var(--st) + 16px + 205px * var(--s));
  transform: scale(var(--s)); transform-origin: 100% 0; }
/* touch: names + a compact speed pill float top-centre (the bottom-right belongs to the touch buttons) */
.bc-hud.touch .bc-br { left: 50%; right: auto; top: 29%; bottom: auto; align-items: center; transform-origin: 50% 0; }
.bc-hud.touch .bc-br { transform: translateX(-50%) scale(var(--s)); }
.bc-hud.touch .bc-names { align-items: center; text-align: center; }
.bc-hud.touch .bc-vname, .bc-hud.touch .bc-area { transform: translateY(8px); }
.bc-hud.touch .bc-vname.on, .bc-hud.touch .bc-area.on { transform: none; }
.bc-hud.touch .bc-speedo { width: auto; height: auto; padding: 5px 12px 6px; background: rgba(0,0,0,.5); border-radius: 10px; }
.bc-hud.touch .bc-speedo.on { display: flex; align-items: baseline; gap: 6px; }
.bc-hud.touch .bc-speedo svg, .bc-hud.touch .bc-speedo .vhp { display: none; }
.bc-hud.touch .bc-speedo .num, .bc-hud.touch .bc-speedo .unit, .bc-hud.touch .bc-speedo .alt { position: static; }
.bc-hud.touch .bc-speedo .num { font-size: 30px; }
.bc-hud.touch .bc-speedo .alt:empty { display: none; }
`;

let injected = false;

/** Inject the UI stylesheet once. */
export function injectStyles() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const st = document.createElement('style');
  st.id = 'bc-ui-styles';
  st.textContent = HUD_CSS + SCREEN_CSS;
  document.head.appendChild(st);
}

/** The #ui root (created if the page has none). */
export function uiRoot() {
  let r = document.getElementById('ui');
  if (!r) {
    r = document.createElement('div');
    r.id = 'ui';
    r.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:10';
    document.body.appendChild(r);
  }
  return r;
}

/** Tiny element factory: el('div', 'cls', parent, 'text'). */
export function el(tag, cls, parent, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  if (parent) parent.appendChild(e);
  return e;
}
