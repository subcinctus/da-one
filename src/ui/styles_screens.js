// Stylesheet for full-screen UI: loading screen, generic panels, inventory, full map, title/pause menus,
// settings/controls pages and touch controls. Concatenated with the HUD styles by styles.js.

export const SCREEN_CSS = `
/* ---------- buttons (Minecraft bevel + GTA gold) ---------- */
.bc-btn { pointer-events: auto; position: relative; display: flex; align-items: center; justify-content: center; gap: 10px;
  min-height: 46px; padding: 0 20px; border: 2px solid #000; border-radius: 3px; cursor: pointer;
  font: 700 17px/1 var(--font); letter-spacing: .04em; color: #f2f4f8; text-shadow: 2px 2px 0 rgba(0,0,0,.55);
  background: linear-gradient(#4a4f5a, #30343c); box-shadow: inset 0 2px 0 rgba(255,255,255,.2), inset 0 -4px 0 rgba(0,0,0,.35);
  transition: transform .08s, filter .12s; -webkit-tap-highlight-color: transparent; outline: none; }
.bc-btn:hover, .bc-btn:focus-visible { background: linear-gradient(#ffd84a, #e3aa00); color: #1a1405; text-shadow: none; }
.bc-btn:active { transform: translateY(2px); box-shadow: inset 0 2px 0 rgba(0,0,0,.3); }
.bc-btn.primary { background: linear-gradient(#ffd84a, #e3aa00); color: #1a1405; text-shadow: 0 1px 0 rgba(255,255,255,.35); }
.bc-btn.primary:hover { filter: brightness(1.08); }
.bc-btn.danger:hover { background: linear-gradient(#ff6b5f, #c9271d); color: #fff; }
.bc-btn.small { min-height: 36px; font-size: 14px; padding: 0 14px; }
.bc-btn .k { margin-left: auto; font-size: 12px; opacity: .65; letter-spacing: .08em; }
.bc-btn[disabled] { opacity: .45; pointer-events: none; }

/* ---------- loading screen ---------- */
.bc-load { position: absolute; inset: 0; z-index: 100; pointer-events: auto; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 26px; padding: 24px; color: #fff; transition: opacity .7s ease;
  background: radial-gradient(ellipse at 50% 38%, #1f3550 0%, #0e1826 55%, #05080d 100%); overflow: hidden; }
.bc-load.out { opacity: 0; pointer-events: none; }
.bc-load::before { content: ''; position: absolute; inset: -50%; opacity: .07; transform: rotate(-12deg);
  background-image: linear-gradient(rgba(255,255,255,.9) 2px, transparent 2px), linear-gradient(90deg, rgba(255,255,255,.9) 2px, transparent 2px);
  background-size: 48px 48px; animation: bc-grid 18s linear infinite; }
@keyframes bc-grid { to { transform: rotate(-12deg) translateY(48px); } }
.bc-logo { display: block; max-width: 92vw; height: auto; filter: drop-shadow(0 18px 30px rgba(0,0,0,.55)); position: relative; }
.bc-load .bc-logo { animation: bc-logo-in 1s cubic-bezier(.2,1.2,.3,1) both; }
@keyframes bc-logo-in { from { opacity: 0; transform: translateY(-20px) scale(.92); } }
.bc-cube-wrap { width: 54px; height: 54px; perspective: 400px; position: relative; }
.bc-cube { position: absolute; inset: 0; transform-style: preserve-3d; animation: bc-cube 3.2s cubic-bezier(.6,0,.4,1) infinite; }
.bc-cube b { position: absolute; inset: 0; background-size: 100% 100%; image-rendering: pixelated; box-shadow: inset 0 0 0 1px rgba(0,0,0,.25); }
.bc-cube .f1 { transform: translateZ(27px); } .bc-cube .f2 { transform: rotateY(90deg) translateZ(27px); filter: brightness(.8); }
.bc-cube .f3 { transform: rotateY(180deg) translateZ(27px); filter: brightness(.7); } .bc-cube .f4 { transform: rotateY(-90deg) translateZ(27px); filter: brightness(.85); }
.bc-cube .f5 { transform: rotateX(90deg) translateZ(27px); } .bc-cube .f6 { transform: rotateX(-90deg) translateZ(27px); filter: brightness(.5); }
@keyframes bc-cube { 0% { transform: rotateX(-24deg) rotateY(0); } 50% { transform: rotateX(-24deg) rotateY(180deg) translateY(-6px); }
  100% { transform: rotateX(-24deg) rotateY(360deg); } }
.bc-progress { width: min(520px, 84vw); position: relative; }
.bc-pbar { height: 22px; border: 3px solid #000; background: #23272f; box-shadow: inset 0 3px 0 rgba(0,0,0,.4), 0 0 0 2px rgba(255,255,255,.12); }
.bc-pbar i { display: block; height: 100%; width: 0; transition: width .25s ease;
  background: repeating-linear-gradient(90deg, #6cc04a 0 14px, #57a63a 14px 16px); box-shadow: inset 0 4px 0 rgba(255,255,255,.28), inset 0 -4px 0 rgba(0,0,0,.25); }
.bc-pmeta { display: flex; justify-content: space-between; margin-top: 9px; font: 600 13px/1.2 var(--font); color: #aeb8c6; letter-spacing: .03em; }
.bc-pmeta b { color: #fff; font-variant-numeric: tabular-nums; }
.bc-tip { max-width: min(620px, 88vw); min-height: 3.2em; text-align: center; font: 500 15px/1.5 var(--font); color: #dfe6ee; transition: opacity .4s; }
.bc-tip .lbl { display: inline-block; margin-right: 8px; padding: 2px 7px; border-radius: 3px; background: var(--accent); color: #1a1405;
  font: 800 11px/1.4 var(--font); letter-spacing: .12em; vertical-align: 1px; }
.bc-tip.fade { opacity: 0; }

/* ---------- generic layer + panel ---------- */
.bc-layer { position: absolute; inset: 0; z-index: 50; pointer-events: auto; display: flex; align-items: center; justify-content: center;
  padding: calc(14px + var(--st)) calc(14px + var(--sr)) calc(14px + var(--sb)) calc(14px + var(--sl));
  background: rgba(3,5,9,.5); animation: bc-fade .18s ease both; }
@keyframes bc-fade { from { opacity: 0; } }
.bc-panel { position: relative; display: flex; flex-direction: column; max-width: 100%; max-height: 100%; width: var(--w, 560px);
  background: var(--panel); border: 1px solid var(--panel-border); border-radius: 12px; color: var(--fg);
  box-shadow: 0 24px 60px rgba(0,0,0,.55), inset 0 1px 0 rgba(255,255,255,.06); animation: bc-panel-in .22s cubic-bezier(.2,1,.3,1) both; }
@keyframes bc-panel-in { from { opacity: 0; transform: translateY(14px) scale(.98); } }
.bc-panel > header { display: flex; align-items: center; gap: 12px; padding: 16px 18px 14px 22px; border-bottom: 1px solid var(--panel-border); }
.bc-panel > header h2 { flex: 1; margin: 0; font: 800 28px/1 var(--font-display); letter-spacing: .05em; text-transform: uppercase; color: #fff;
  text-shadow: 0 2px 0 #000; }
.bc-panel > header h2::before { content: ''; display: inline-block; width: 6px; height: .8em; margin-right: 12px; background: var(--accent);
  vertical-align: -.02em; }
.bc-x { pointer-events: auto; width: 36px; height: 36px; border-radius: 8px; border: 1px solid var(--panel-border); background: rgba(255,255,255,.06);
  color: #fff; font: 700 20px/1 var(--font); cursor: pointer; display: grid; place-items: center; }
.bc-x:hover { background: var(--danger); border-color: transparent; }
.bc-panel > .body { flex: 1; min-height: 0; overflow: auto; padding: 18px 22px 22px; font: 15px/1.45 var(--font); }
.bc-panel > .body::-webkit-scrollbar, .bc-scroll::-webkit-scrollbar { width: 10px; }
.bc-panel > .body::-webkit-scrollbar-thumb, .bc-scroll::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 5px; }
.bc-panel .hint { color: var(--muted); font-size: 13px; }

/* ---------- confirm dialog ---------- */
.bc-confirm { width: min(420px, 92vw); padding: 24px; text-align: center; background: var(--panel); border: 1px solid var(--panel-border);
  border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.6); animation: bc-panel-in .2s ease both; }
.bc-confirm h3 { margin: 0 0 10px; font: 800 28px/1.1 var(--font-display); letter-spacing: .04em; text-transform: uppercase; }
.bc-confirm p { margin: 0 0 20px; color: #c9d1dc; font: 15px/1.5 var(--font); }
.bc-confirm .row { display: flex; gap: 10px; } .bc-confirm .row .bc-btn { flex: 1; }

/* ---------- inventory (Minecraft container) ---------- */
.bc-inv { --sz: clamp(30px, min(4.4vw, 6.2vh), 58px); position: relative; display: flex; gap: 14px; padding: 14px; max-width: 100%; max-height: 100%;
  background: #c6c6c6; color: #3f3f3f; border: 3px solid; border-color: #fff #555 #555 #fff; box-shadow: 0 0 0 3px #000, 0 28px 70px rgba(0,0,0,.6);
  font: 600 14px/1.3 var(--font); animation: bc-panel-in .2s ease both; }
.bc-inv h3 { margin: 0 0 8px; font: 700 16px/1 var(--font); color: #3f3f3f; letter-spacing: .02em; display: flex; align-items: center; gap: 10px; }
.bc-inv h3 .sp { flex: 1; }
.bc-inv .col { display: flex; flex-direction: column; min-width: 0; }
.bc-inv .main { flex: 0 0 auto; width: calc(var(--sz) * 9); }
.bc-grid { display: grid; grid-template-columns: repeat(9, var(--sz)); gap: 0; }
.bc-grid.hot { margin-top: 10px; }
.bc-islot { position: relative; width: var(--sz); height: var(--sz); background: #8b8b8b; border: 2px solid; border-color: #373737 #fff #fff #373737;
  display: grid; place-items: center; cursor: pointer; }
.bc-islot .ico { width: 76%; height: 76%; display: grid; place-items: center; pointer-events: none; }
.bc-islot .ico .emoji { font-size: calc(var(--sz) * .52); line-height: 1; }
.bc-islot:hover::after { content: ''; position: absolute; inset: 0; background: rgba(255,255,255,.45); pointer-events: none; }
.bc-islot.sel { box-shadow: inset 0 0 0 2px #fff, inset 0 0 0 3px #000; }
.bc-islot .cnt { right: 2px; bottom: 1px; font-size: calc(var(--sz) * .31); }
.bc-islot.trash { background: #7a4a4a; } .bc-islot.trash::before { content: '🗑'; font-size: calc(var(--sz) * .5); opacity: .8; }
.bc-inv .side { width: 250px; display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.bc-stats { background: #8b8b8b; border: 2px solid; border-color: #373737 #fff #fff #373737; padding: 10px 12px; color: #fff;
  text-shadow: 1px 1px 0 #3f3f3f; display: grid; grid-template-columns: auto 1fr; gap: 6px 10px; align-items: center; font-size: 13px; }
.bc-stats .k { color: #e8e8e8; opacity: .9; font-weight: 700; }
.bc-stats .v { text-align: right; font-weight: 700; font-variant-numeric: tabular-nums; }
.bc-stats .v.money { color: #8ef07f; }
.bc-mbar { grid-column: 1 / -1; height: 8px; background: #373737; position: relative; margin-top: -2px; }
.bc-mbar i { position: absolute; inset: 0; transform-origin: 0 0; background: #4fc24f; }
.bc-mbar.ar i { background: #3f8fe0; }
.bc-stats .stars { display: inline-flex; gap: 2px; justify-content: flex-end; }
.bc-stats .stars .bc-star { width: 15px; height: 15px; }
.bc-toggle { pointer-events: auto; display: flex; align-items: center; gap: 10px; cursor: pointer; padding: 8px 10px; background: #8b8b8b; color: #fff;
  border: 2px solid; border-color: #fff #373737 #373737 #fff; text-shadow: 1px 1px 0 #3f3f3f; font-weight: 700; font-size: 13px; user-select: none; }
.bc-toggle:hover { background: #a0a0a0; }
.bc-toggle .sw { margin-left: auto; width: 40px; height: 20px; border-radius: 10px; background: #3a3a3a; position: relative; box-shadow: inset 0 2px 3px rgba(0,0,0,.4); }
.bc-toggle .sw::after { content: ''; position: absolute; left: 2px; top: 2px; width: 16px; height: 16px; border-radius: 50%; background: #ddd; transition: transform .15s; }
.bc-toggle.on .sw { background: #4caf50; } .bc-toggle.on .sw::after { transform: translateX(20px); background: #fff; }
.bc-pal { display: flex; flex-direction: column; min-height: 0; margin-bottom: 10px; }
.bc-pal .bar { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.bc-pal .bar .lbl { font: 700 16px/1 var(--font); color: #3f3f3f; }
.bc-pal .bar .bc-islot { --sz: 32px; flex: 0 0 auto; }
.bc-pal input { pointer-events: auto; flex: 1; min-width: 0; padding: 6px 8px; border: 2px solid; border-color: #373737 #fff #fff #373737;
  background: #000; color: #fff; font: 600 13px/1.2 var(--font); outline: none; }
.bc-pal .bc-scroll { max-height: calc(var(--sz) * 4.5); overflow-y: auto; overflow-x: hidden; background: #8b8b8b; }
.bc-pal .bc-grid { grid-template-columns: repeat(9, var(--sz)); }
.bc-inv .help { font-size: 12px; color: #555; margin-top: 8px; line-height: 1.45; }
.bc-cursor { position: fixed; left: 0; top: 0; z-index: 200; width: calc(var(--sz, 40px) * .82); height: calc(var(--sz, 40px) * .82); pointer-events: none;
  display: none; transform: translate(-50%, -50%); filter: drop-shadow(0 4px 6px rgba(0,0,0,.5)); }
.bc-cursor.on { display: grid; place-items: center; }
.bc-cursor .ico { width: 100%; height: 100%; display: grid; place-items: center; }
.bc-cursor .ico img { width: 100%; height: 100%; image-rendering: pixelated; }
.bc-cursor .ico .emoji { font-size: 26px; }
.bc-cursor .cnt { position: absolute; right: -4px; bottom: -4px; font: 700 14px/1 ui-monospace, Menlo, monospace; color: #fff; text-shadow: 2px 2px 0 #3f3f3f; }
.bc-tipbox { position: fixed; z-index: 210; pointer-events: none; display: none; max-width: 260px; padding: 7px 10px 8px; background: rgba(16,0,16,.94);
  border: 2px solid #28007a; outline: 1px solid #100010; color: #fff; font: 600 13px/1.4 var(--font); text-shadow: 1px 1px 0 #3f3f3f; }
.bc-tipbox.on { display: block; }
.bc-tipbox .t { font-size: 15px; margin-bottom: 2px; } .bc-tipbox .d { color: #a8a8a8; font-weight: 500; }
.bc-tipbox .v { color: #ffd23f; } .bc-tipbox .w { color: #7fd3ff; }
.bc-inv-close { position: absolute; right: -18px; top: -18px; background: #8b8b8b; border: 3px solid #000; border-radius: 4px; color: #fff;
  text-shadow: 2px 2px 0 #3f3f3f; box-shadow: inset 2px 2px 0 rgba(255,255,255,.45), inset -2px -2px 0 rgba(0,0,0,.35); }
.bc-inv-close:hover { background: #c0392b; }
.bc-inv .tabs { display: flex; gap: 6px; }

/* ---------- full-screen map ---------- */
.bc-map { position: absolute; inset: 0; z-index: 50; pointer-events: auto; background: #0a1730; animation: bc-fade .2s ease both; overflow: hidden;
  touch-action: none; cursor: grab; }
.bc-map.drag { cursor: grabbing; }
.bc-map canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.bc-map .top { position: absolute; left: 0; right: 0; top: 0; display: flex; align-items: center; gap: 16px;
  padding: calc(14px + var(--st)) calc(20px + var(--sr)) 26px calc(20px + var(--sl)); background: linear-gradient(rgba(0,0,0,.78), rgba(0,0,0,0)); pointer-events: none; }
.bc-map .top h2 { margin: 0; font: 800 34px/1 var(--font-display); letter-spacing: .06em; color: #fff; text-shadow: 0 2px 0 #000; }
.bc-map .top .where { font: 700 14px/1.3 var(--font); letter-spacing: .1em; text-transform: uppercase; color: #dfe6ee; }
.bc-map .top .sp { flex: 1; }
.bc-map .top .bc-x { pointer-events: auto; }
.bc-map .legend { position: absolute; right: calc(16px + var(--sr)); top: calc(78px + var(--st)); width: 210px; max-height: calc(100% - 170px); overflow: auto;
  padding: 12px 14px; background: rgba(8,10,16,.82); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; pointer-events: auto; cursor: default; }
.bc-map .legend h4 { margin: 0 0 8px; font: 800 11px/1 var(--font); letter-spacing: .18em; color: #9aa4b2; }
.bc-map .legend .it { display: flex; align-items: center; gap: 10px; padding: 4px 0; font: 600 13px/1.2 var(--font); color: #e8edf3; }
.bc-map .legend canvas { position: static; width: 22px; height: 22px; flex: 0 0 22px; }
.bc-map .legend.collapsed .it { display: none; }
.bc-map .legend h4 { cursor: pointer; }
.bc-map .foot { position: absolute; left: 0; right: 0; bottom: 0; display: flex; flex-wrap: wrap; justify-content: center; gap: 6px 18px;
  padding: 26px 20px calc(14px + var(--sb)); background: linear-gradient(rgba(0,0,0,0), rgba(0,0,0,.75)); font: 600 13px/1.4 var(--font); color: #dfe6ee;
  pointer-events: none; }
.bc-map .zoom { position: absolute; left: calc(16px + var(--sl)); bottom: calc(60px + var(--sb)); display: flex; flex-direction: column; gap: 6px; }
.bc-map .zoom .bc-btn { width: 44px; min-height: 44px; padding: 0; font-size: 22px; }
.bc-map .wpinfo { position: absolute; left: 50%; top: calc(70px + var(--st)); transform: translateX(-50%); padding: 6px 14px; border-radius: 16px;
  background: rgba(224,64,251,.9); color: #fff; font: 700 13px/1.3 var(--font); letter-spacing: .04em; display: none; pointer-events: none;
  box-shadow: 0 4px 14px rgba(0,0,0,.4); }
.bc-map .wpinfo.on { display: block; }

/* ---------- title / pause menus ---------- */
.bc-menu { position: absolute; inset: 0; z-index: 60; pointer-events: auto; display: flex; color: #fff; animation: bc-fade .3s ease both;
  padding: calc(20px + var(--st)) calc(20px + var(--sr)) calc(20px + var(--sb)) calc(20px + var(--sl)); overflow: auto; }
.bc-menu.title { flex-direction: column; align-items: center; justify-content: center; gap: 18px;
  background: radial-gradient(ellipse at 50% 45%, rgba(0,0,0,.05) 0%, rgba(0,0,0,.35) 55%, rgba(0,0,0,.82) 100%),
    linear-gradient(rgba(0,0,0,.25), rgba(0,0,0,0) 30%, rgba(0,0,0,0) 60%, rgba(0,0,0,.6)); }
.bc-menu .tag { font: 700 clamp(14px, 2.3vmin, 20px)/1.3 var(--font); letter-spacing: .14em; text-transform: uppercase; color: #fff;
  text-shadow: 0 2px 4px #000, 0 0 18px rgba(0,0,0,.7); text-align: center; margin-top: -6px; }
.bc-menu .tag b { color: var(--accent); }
.bc-menu .btns { display: flex; flex-direction: column; gap: 10px; width: min(340px, 86vw); margin-top: 8px; }
.bc-menu .btns .row { display: flex; gap: 10px; } .bc-menu .btns .row .bc-btn { flex: 1; }
.bc-menu .foot { position: absolute; left: 0; right: 0; bottom: calc(14px + var(--sb)); text-align: center; font: 600 12px/1.4 var(--font);
  color: rgba(255,255,255,.72); text-shadow: 0 1px 2px #000; letter-spacing: .05em; padding: 0 16px; pointer-events: none; }
.bc-menu .splash { position: absolute; font: 800 18px/1 var(--font); color: #ffe14a; text-shadow: 2px 2px 0 #3f3a00; transform: rotate(-16deg);
  animation: bc-splash .5s ease-in-out infinite alternate; white-space: nowrap; pointer-events: none; }
@keyframes bc-splash { to { transform: rotate(-16deg) scale(1.08); } }
.bc-menu.title .bc-logo { animation: bc-logo-in 1.1s cubic-bezier(.2,1.2,.3,1) both; }
.bc-logo-box { position: relative; }
.bc-menu.pause { background: linear-gradient(90deg, rgba(0,0,0,.86) 0%, rgba(0,0,0,.66) 40%, rgba(0,0,0,.35) 100%); align-items: center; justify-content: center; gap: 4vw; }
.bc-pause-l { display: flex; flex-direction: column; gap: 16px; width: min(360px, 90vw); }
.bc-pause-l .bc-btn { justify-content: flex-start; padding-left: 22px; }
.bc-pause-l .btns .row .bc-btn { justify-content: center; padding-left: 20px; }
.bc-pause-l h1 { margin: 0 0 6px; font: 800 clamp(44px, 8vmin, 76px)/1 var(--font-display); letter-spacing: .06em; text-shadow: 0 4px 0 #000; }
.bc-pause-l h1 small { display: block; margin-top: 8px; font: 700 13px/1 var(--font); letter-spacing: .2em; color: var(--accent); }
.bc-pause-r { width: min(330px, 90vw); display: flex; flex-direction: column; gap: 12px; }
.bc-card { background: rgba(10,12,18,.78); border: 1px solid rgba(255,255,255,.1); border-radius: 10px; padding: 14px 16px; }
.bc-card h4 { margin: 0 0 10px; font: 800 11px/1 var(--font); letter-spacing: .18em; color: #9aa4b2; text-transform: uppercase; }
.bc-kv { display: grid; grid-template-columns: auto 1fr; gap: 7px 12px; font: 600 14px/1.25 var(--font); }
.bc-kv .k { color: #9aa4b2; } .bc-kv .v { text-align: right; font-variant-numeric: tabular-nums; }
.bc-kv .v.money { color: var(--hud-green); font: 800 20px/1 var(--font-display); letter-spacing: .03em; }
.bc-kv .stars { display: inline-flex; gap: 2px; } .bc-kv .stars .bc-star { width: 16px; height: 16px; }
.bc-lockhint { padding: 10px 12px; border-radius: 8px; background: rgba(245,197,24,.14); border: 1px solid rgba(245,197,24,.45); color: #ffe9a3;
  font: 600 13px/1.45 var(--font); }
.bc-page { width: min(640px, 94vw); max-height: 100%; display: flex; flex-direction: column; background: rgba(10,12,18,.92);
  border: 1px solid rgba(255,255,255,.1); border-radius: 12px; box-shadow: 0 24px 60px rgba(0,0,0,.6); animation: bc-panel-in .2s ease both; margin: auto; }
.bc-page > header { display: flex; align-items: center; gap: 12px; padding: 16px 18px 14px 22px; border-bottom: 1px solid rgba(255,255,255,.1); }
.bc-page > header h2 { flex: 1; margin: 0; font: 800 30px/1 var(--font-display); letter-spacing: .06em; text-transform: uppercase; }
.bc-page > .body { flex: 1; min-height: 0; overflow: auto; padding: 8px 22px 18px; }
.bc-page > footer { display: flex; gap: 10px; padding: 14px 22px 18px; border-top: 1px solid rgba(255,255,255,.08); }
.bc-page > footer .bc-btn { flex: 1; }
.bc-set { display: grid; grid-template-columns: 1fr minmax(150px, 46%) 54px; align-items: center; gap: 12px; padding: 11px 0;
  border-bottom: 1px solid rgba(255,255,255,.06); font: 600 15px/1.25 var(--font); }
.bc-set .d { display: block; font: 500 12px/1.3 var(--font); color: #8f9aa8; margin-top: 2px; }
.bc-set .val { text-align: right; font-variant-numeric: tabular-nums; color: var(--accent); font-weight: 700; }
.bc-set input[type=range] { pointer-events: auto; -webkit-appearance: none; appearance: none; width: 100%; height: 26px; background: transparent; cursor: pointer; }
.bc-set input[type=range]::-webkit-slider-runnable-track { height: 6px; border-radius: 3px;
  background: linear-gradient(90deg, var(--accent) var(--p, 50%), rgba(255,255,255,.16) var(--p, 50%)); }
.bc-set input[type=range]::-moz-range-track { height: 6px; border-radius: 3px; background: rgba(255,255,255,.16); }
.bc-set input[type=range]::-moz-range-progress { height: 6px; border-radius: 3px; background: var(--accent); }
.bc-set input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; width: 20px; height: 20px; margin-top: -7px; border-radius: 4px;
  background: #fff; border: 2px solid #000; box-shadow: 0 2px 0 #000; }
.bc-set input[type=range]::-moz-range-thumb { width: 16px; height: 16px; border-radius: 4px; background: #fff; border: 2px solid #000; }
.bc-sw { pointer-events: auto; justify-self: end; grid-column: 2 / 4; width: 52px; height: 28px; border-radius: 14px; border: 2px solid #000; cursor: pointer;
  background: #3a3f48; position: relative; transition: background .15s; }
.bc-sw::after { content: ''; position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: #cfd5dd; transition: transform .15s; }
.bc-sw.on { background: var(--accent); } .bc-sw.on::after { transform: translateX(24px); background: #fff; }
.bc-seg { pointer-events: auto; grid-column: 2 / 4; justify-self: end; display: flex; border: 2px solid #000; border-radius: 6px; overflow: hidden; }
.bc-seg button { pointer-events: auto; border: 0; padding: 6px 10px; background: #2c3038; color: #dfe6ee; font: 700 13px/1 var(--font); cursor: pointer; }
.bc-seg button + button { border-left: 1px solid #000; }
.bc-seg button.on { background: var(--accent); color: #1a1405; }
.bc-ctl h3 { margin: 18px 0 6px; font: 800 12px/1 var(--font); letter-spacing: .18em; text-transform: uppercase; color: var(--accent); }
.bc-ctl table { width: 100%; border-collapse: collapse; font: 500 14px/1.3 var(--font); }
.bc-ctl td { padding: 6px 0; border-bottom: 1px solid rgba(255,255,255,.06); vertical-align: middle; }
.bc-ctl td:first-child { width: 46%; white-space: nowrap; }
.bc-ctl td .bc-key { font-size: 12px; }
.bc-ctl .note { margin-top: 14px; font: 500 13px/1.45 var(--font); color: #9aa4b2; }

/* ---------- touch controls ---------- */
.bc-touch { position: absolute; inset: 0; z-index: 30; pointer-events: none; touch-action: none; transition: opacity .25s; }
.bc-touch.off { opacity: 0; } .bc-touch.off * { pointer-events: none !important; }
.bc-touch .look { position: absolute; inset: 0; pointer-events: auto; touch-action: none; }
.bc-touch .stick-zone { position: absolute; left: 0; bottom: 0; width: 46%; height: 62%; pointer-events: auto; touch-action: none; }
.bc-touch .stick { position: absolute; width: 132px; height: 132px; margin: -66px 0 0 -66px; border-radius: 50%; pointer-events: none;
  background: radial-gradient(circle, rgba(255,255,255,.06), rgba(255,255,255,.14)); box-shadow: 0 0 0 2px rgba(255,255,255,.4), inset 0 0 18px rgba(0,0,0,.3);
  transition: opacity .2s; opacity: .55; }
.bc-touch .stick.active { opacity: 1; transition: none; }
.bc-touch .knob { position: absolute; left: 50%; top: 50%; width: 58px; height: 58px; margin: -29px; border-radius: 50%;
  background: radial-gradient(circle at 40% 35%, rgba(255,255,255,.75), rgba(255,255,255,.35)); box-shadow: 0 3px 10px rgba(0,0,0,.4); }
.bc-touch .stick.sprint .knob { background: radial-gradient(circle at 40% 35%, #ffe680, #f5c518); }
.bc-tb { position: absolute; pointer-events: auto; touch-action: none; width: 64px; height: 64px; margin: -32px 0 0 -32px; border-radius: 50%;
  display: grid; place-items: center; background: rgba(16,18,24,.42); box-shadow: 0 0 0 2px rgba(255,255,255,.5), 0 4px 12px rgba(0,0,0,.25);
  color: #fff; font: 800 13px/1 var(--font); letter-spacing: .04em; text-shadow: 0 1px 2px #000; -webkit-user-select: none; user-select: none;
  transition: transform .06s, background .1s; }
.bc-tb.big { width: 86px; height: 86px; margin: -43px 0 0 -43px; font-size: 15px; }
.bc-tb.sm { width: 46px; height: 46px; margin: -23px 0 0 -23px; font-size: 11px; border-radius: 12px; }
.bc-tb.on { background: rgba(245,197,24,.62); transform: scale(.92); color: #1a1405; text-shadow: none; }
.bc-tb.hide { display: none; }
.bc-tb svg { width: 46%; height: 46%; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.bc-tb.big svg { width: 42%; height: 42%; }

/* ---------- responsive ---------- */
@media (max-width: 760px) {
  .bc-inv { flex-direction: column; gap: 10px; padding: 10px; overflow: auto; --sz: clamp(28px, calc((100vw - 64px) / 9), 42px); }
  .bc-inv .side { width: auto; }
  .bc-inv-close { right: 6px; top: 6px; }
  .bc-pal .bc-scroll { max-height: calc(var(--sz) * 3.5); }
  .bc-menu.pause { flex-direction: column; justify-content: flex-start; gap: 18px; }
  .bc-set { grid-template-columns: 1fr minmax(110px, 44%) 44px; }
  .bc-map .legend { width: 170px; top: auto; bottom: calc(110px + var(--sb)); max-height: 40%; }
  .bc-map .top h2 { font-size: 26px; }
}
@media (max-height: 520px) {
  .bc-menu.title { gap: 10px; }
  .bc-menu .btns { gap: 7px; }
  .bc-btn { min-height: 40px; }
}
`;
