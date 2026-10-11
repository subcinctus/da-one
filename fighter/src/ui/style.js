// All UI CSS, injected once. Uses the variables from src/index.html (--ink, --muted, --jade, --ember, --gold, --panel,
// --line, --font, --font-display). Sizes are in em off a viewport-scaled base so 720p..4K read the same.

const CSS = `
#ui { font-size: clamp(12px, 1.5vh, 26px); color: var(--ink); font-family: var(--font); line-height: 1.35; }
#ui .ls-layer { position: absolute; inset: 0; pointer-events: none; }
#ui .ls-hidden { display: none !important; }
#ui svg { display: block; }
#ui b { font-weight: 600; }

/* ---------------------------------------------------------------- glyphs */
.ls-gw { display: inline-flex; align-items: center; gap: .18em; vertical-align: middle; }
.ls-g { display: inline-flex; align-items: center; justify-content: center; height: 1.55em; min-width: 1.55em; vertical-align: middle;
  font: 700 .78em/1 var(--font); color: var(--ink); }
.ls-g svg { width: 100%; height: 100%; }
.ls-g-face { width: 1.85em; height: 1.85em; border-radius: 50%; background: rgba(16,17,20,.9); border: 1px solid rgba(244,239,230,.28); font-size: .8em; }
.ls-g-face svg { width: 1.3em; height: 1.3em; }
.ls-g-face.menu { color: var(--ink); }
.ls-g-face.menu svg { width: 1.1em; height: 1.1em; }
.ls-g-pill { height: 1.6em; padding: 0 .5em; border-radius: .45em; background: rgba(16,17,20,.9); border: 1px solid rgba(244,239,230,.28); font-size: .68em; letter-spacing: .04em; }
.ls-g-pill.small { font-size: .56em; letter-spacing: .08em; text-transform: uppercase; }
.ls-g-key { height: 1.75em; min-width: 1.75em; padding: 0 .38em; border-radius: .28em; background: rgba(244,239,230,.92); color: #16171b;
  border-bottom: 2px solid rgba(120,116,108,.9); font-size: .7em; }
.ls-g-key.wide { padding: 0 .55em; font-size: .62em; letter-spacing: .03em; }
.ls-g-mouse { width: 1.75em; height: 2em; color: var(--ink); }
.ls-g-mouse .hl { fill: var(--jade); }
.ls-g-dpad { width: 1.8em; height: 1.8em; color: var(--ink); }
.ls-g-stick { position: relative; width: 1.9em; height: 1.9em; color: var(--ink); }
.ls-g-stick b { position: absolute; inset: 0; display: grid; place-items: center; font-size: .62em; }
.ls-g-stick.click svg circle:last-child { fill: rgba(244,239,230,.25); }
.ls-plus, .ls-or { margin: 0 .25em; color: var(--muted); font-size: .8em; }
.ls-hint { display: inline-flex; align-items: center; gap: .55em; }
.ls-hint > span:last-child { letter-spacing: .14em; text-transform: uppercase; font-size: .78em; color: var(--ink); opacity: .82; }

/* ---------------------------------------------------------------- loading */
.ls-loading { position: absolute; inset: 0; background: var(--bg); display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 1.4em; transition: opacity .6s ease; z-index: 50; pointer-events: auto; }
.ls-loading .t { font-family: var(--font-display); font-size: 2.4em; letter-spacing: .32em; text-indent: .32em; }
.ls-loading .bar { width: 16em; height: 1px; background: var(--line); overflow: hidden; }
.ls-loading .bar i { display: block; height: 100%; background: var(--jade); transform-origin: left; transform: scaleX(0); transition: transform .2s; }
.ls-loading .s { font-size: .72em; letter-spacing: .3em; text-transform: uppercase; color: var(--muted); }

/* ---------------------------------------------------------------- HUD */
.ls-hud { z-index: 1; } .ls-screens { z-index: 2; } .ls-overlay { z-index: 3; }
.ls-overlay.covered .ls-banner, .ls-overlay.covered .ls-bosstitle { opacity: 0 !important; }
.ls-overlay { text-shadow: 0 1px 2px rgba(0,0,0,.55), 0 0 12px rgba(0,0,0,.25); }
.ls-hud { transition: opacity .35s ease; text-shadow: 0 1px 2px rgba(0,0,0,.55), 0 0 12px rgba(0,0,0,.25); }
.ls-hud.off { opacity: 0; }
.ls-fps { position: absolute; left: 1em; top: .8em; font: 600 .72em/1 ui-monospace, Menlo, Consolas, monospace; color: var(--ink); opacity: .7; letter-spacing: .06em; }

.ls-player { position: absolute; left: 3em; bottom: 2.6em; display: flex; align-items: center; gap: 1.15em; }
.ls-tal { position: relative; width: 4.4em; height: 4.4em; flex: none; }
.ls-tal svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ls-tal .age { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: 1.85em; letter-spacing: .02em; }
.ls-tal .cnt { position: absolute; right: -.5em; bottom: -.25em; min-width: 1.7em; height: 1.7em; padding: 0 .3em; border-radius: .85em; background: var(--jade);
  color: #0d1110; font: 700 .7em/1.7em var(--font); text-align: center; text-shadow: none; box-shadow: 0 1px 3px rgba(0,0,0,.4); }
.ls-tal .cnt.zero { background: rgba(16,17,20,.85); color: var(--muted); border: 1px solid var(--line); }
.ls-tal.pulse { animation: ls-pulse .9s ease-out; }
.ls-bars { display: flex; flex-direction: column; gap: .5em; }
.ls-bar { position: relative; width: 21em; height: .44em; background: rgba(10,11,13,.5); box-shadow: 0 0 0 1px rgba(244,239,230,.12); overflow: hidden; }
.ls-bar i { position: absolute; inset: 0; transform-origin: 0 50%; will-change: transform; }
.ls-bar .chip { background: var(--ember); opacity: .9; }
.ls-bar .fill { background: var(--ink); }
.ls-bar.st { width: 16em; height: .26em; }
.ls-bar.st .fill { background: #bfe3d3; }
.ls-bar.st.low .fill { background: var(--gold); }
.ls-bar.st.out { animation: ls-blink .5s steps(2) 3; }
.ls-focus { display: flex; gap: .35em; align-items: center; margin-top: .05em; }
.ls-focus .pip { position: relative; width: 2.2em; height: .26em; background: rgba(10,11,13,.5); box-shadow: 0 0 0 1px rgba(232,184,90,.25); overflow: hidden; }
.ls-focus .pip i { position: absolute; inset: 0; background: var(--gold); transform-origin: 0 50%; }
.ls-focus .lbl { display: inline-flex; align-items: center; font-size: .6em; letter-spacing: .3em; color: var(--gold); margin-left: .5em; opacity: 0; transition: opacity .3s; }
.ls-focus .lbl .ls-gw { font-size: 1.35em; letter-spacing: 0; }
.ls-focus.ready .lbl { opacity: 1; }
.ls-focus.ready .pip { box-shadow: 0 0 0 1px rgba(232,184,90,.8), 0 0 8px rgba(232,184,90,.45); }
.ls-focus.deny { animation: ls-shake .3s; }

.ls-stance { position: absolute; right: 3em; bottom: 2.4em; display: flex; align-items: center; gap: 1.2em; }
.ls-moves { display: flex; flex-direction: column; align-items: flex-end; gap: .5em; }
.ls-mv { display: flex; align-items: center; gap: .6em; white-space: nowrap; }
.ls-mv .n { font-size: .98em; letter-spacing: .02em; }
.ls-mv .to { font-size: .66em; letter-spacing: .16em; color: var(--muted); min-width: 3.4em; text-align: left; }
.ls-mv.alt .n { opacity: .82; }
.ls-mv.used .n { color: var(--jade); }
.ls-quad { position: relative; width: 6.6em; height: 6.6em; }
.ls-quad svg { width: 100%; height: 100%; overflow: visible; }
.ls-quad .d { fill: rgba(10,11,13,.38); stroke: rgba(244,239,230,.42); stroke-width: 1.2; transition: fill .12s, stroke .12s; }
.ls-quad .d.on { fill: var(--ink); stroke: var(--ink); }
.ls-quad .lbl { fill: var(--ink); font: 600 9px var(--font); letter-spacing: .5px; text-anchor: middle; dominant-baseline: central; opacity: .55; }
.ls-quad .lbl.on { fill: #111214; opacity: .9; }
.ls-quad.flash svg { animation: ls-qflash .35s ease-out; }
.ls-string { position: absolute; left: 50%; bottom: -1.05em; transform: translateX(-50%); display: flex; gap: .3em; }
.ls-string i { width: .38em; height: .38em; transform: rotate(45deg); background: rgba(244,239,230,.25); transition: background .08s; }
.ls-string i.on { background: var(--jade); }

.ls-boss { position: absolute; left: 50%; bottom: 2.2em; width: min(42em, 42vw); transform: translateX(-50%); text-align: center; opacity: 0; transition: opacity .6s;
  padding: 1.1em 1.4em .8em; background: radial-gradient(ellipse at 50% 60%, rgba(9,10,12,.55), rgba(9,10,12,0) 72%); }
.ls-boss.on { opacity: 1; }
.ls-boss .nm { font-family: var(--font-display); font-size: 1.05em; letter-spacing: .34em; text-indent: .34em; text-transform: uppercase; margin-bottom: .2em; }
.ls-boss .ep { font-size: .62em; letter-spacing: .32em; text-transform: uppercase; color: var(--gold); margin-bottom: .6em; }
.ls-boss .ls-bar { width: 100%; height: .4em; }
.ls-boss .tick { position: absolute; left: 50%; top: 0; bottom: 0; width: 1px; background: rgba(14,15,18,.85); }
.ls-boss .ls-bar .fill { background: #f1e8d8; }

.ls-ebar { position: absolute; left: 0; top: 0; width: 3.8em; height: .3em; margin-left: -1.9em; background: rgba(10,11,13,.66);
  box-shadow: 0 0 0 1px rgba(10,11,13,.5), 0 0 0 2px rgba(244,239,230,.12); opacity: 0; transition: opacity .25s; will-change: transform, opacity; overflow: hidden; }
.ls-ebar.on { opacity: 1; }
.ls-ebar i { position: absolute; inset: 0; transform-origin: 0 50%; }
.ls-ebar .chip { background: var(--ember); }
.ls-ebar .fill { background: var(--ink); }
/* lock-on chevron: anchored at the target's bar (height + 0.16 m); its tip points down just above the bar */
.ls-ret { position: absolute; left: 0; top: 0; width: 1.25em; height: .875em; margin: -1.4em 0 0 -.625em; opacity: 0; transition: opacity .2s; will-change: transform; color: var(--ink); }
.ls-ret.on { opacity: .95; }
.ls-ret svg { width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 1px 1px rgba(0,0,0,.6)); }
.ls-ret.lockin svg { animation: ls-retin .25s ease-out; }

.ls-toasts { position: absolute; right: 3em; top: 26%; display: flex; flex-direction: column; align-items: flex-end; gap: .55em; }
.ls-toast { background: rgba(12,13,16,.76); border-left: 2px solid var(--jade); padding: .55em 1em .6em .85em; min-width: 12em; max-width: 24em;
  transition: opacity .45s, transform .45s; animation: ls-tin .3s ease-out; text-shadow: none; }
.ls-toast.out { opacity: 0; transform: translateX(1em); }
.ls-toast .k { display: block; font-size: .6em; letter-spacing: .3em; text-transform: uppercase; color: var(--jade); margin-bottom: .25em; }
.ls-toast .v { font-size: .95em; }
.ls-toast.warn { border-color: var(--gold); } .ls-toast.warn .k { color: var(--gold); }
.ls-toast.learn .v { font-family: var(--font-display); font-size: 1.15em; }
.ls-ticks { display: flex; gap: 3px; margin-top: .45em; }
.ls-ticks i { flex: 1; height: .22em; background: rgba(244,239,230,.18); }
.ls-ticks i.on { background: var(--jade); }
.ls-ticks i.new { background: #e9fff5; }

.ls-prompt { position: absolute; left: 50%; bottom: 8.2em; transform: translateX(-50%); display: flex; gap: 1.6em; white-space: nowrap; transition: opacity .3s; }
.ls-prompt .p { display: inline-flex; align-items: center; gap: .55em; font-size: .9em; padding: .35em .8em; background: rgba(12,13,16,.55); }
.ls-prompt .p .t { letter-spacing: .14em; text-transform: uppercase; font-size: .78em; }
.ls-prompt .p .s { color: var(--muted); font-size: .72em; letter-spacing: .08em; }

.ls-banner { position: absolute; left: 0; right: 0; top: 14%; text-align: center; opacity: 0; transition: opacity .9s ease; }
.ls-banner.on { opacity: 1; }
.ls-banner .k { font-size: .75em; letter-spacing: .5em; text-indent: .5em; text-transform: uppercase; color: var(--ink); opacity: .85; }
.ls-banner .t { font-family: var(--font-display); font-size: 3.6em; letter-spacing: .14em; text-indent: .14em; text-transform: uppercase; margin: .15em 0;
  text-shadow: 0 2px 24px rgba(0,0,0,.5), 0 1px 2px rgba(0,0,0,.6); }
.ls-banner .r { width: 8em; height: 1px; margin: .55em auto; background: rgba(244,239,230,.6); }
.ls-banner .s { font-family: var(--font-display); font-style: italic; font-size: 1.15em; opacity: .9; }

.ls-bosstitle { position: absolute; left: 7vw; top: 34%; opacity: 0; transform: translateX(-1.2em); transition: opacity .7s ease, transform .9s ease; }
.ls-bosstitle.on { opacity: 1; transform: none; }
.ls-bosstitle .k { font-size: .72em; letter-spacing: .45em; text-transform: uppercase; color: var(--gold); }
.ls-bosstitle .n { font-family: var(--font-display); font-size: 4.4em; letter-spacing: .06em; text-transform: uppercase; line-height: 1.05; margin: .12em 0;
  text-shadow: 0 2px 30px rgba(0,0,0,.55), 0 1px 2px rgba(0,0,0,.6); }
.ls-bosstitle .r { width: 9em; height: 1px; background: var(--gold); margin: .7em 0; }
.ls-bosstitle .b { max-width: 26em; font-family: var(--font-display); font-style: italic; font-size: 1.05em; opacity: .92; }

/* ---------------------------------------------------------------- dialogue */
.ls-dlg { position: absolute; left: 50%; bottom: 7%; width: min(50em, 86vw); transform: translate(-50%, .6em); opacity: 0; transition: opacity .25s, transform .3s; }
.ls-dlg.on { opacity: 1; transform: translate(-50%, 0); }
.ls-dlg.on.block { pointer-events: auto; cursor: pointer; }
.ls-dlg .panel { position: relative; padding: 1.2em 1.8em 1.3em; background: linear-gradient(180deg, rgba(10,11,13,.62), rgba(10,11,13,.84)); border-top: 1px solid rgba(232,184,90,.35); }
.ls-dlg .plate { display: inline-block; font-size: .72em; letter-spacing: .34em; text-transform: uppercase; color: var(--gold); padding-bottom: .45em;
  border-bottom: 1px solid rgba(232,184,90,.45); margin-bottom: .7em; }
.ls-dlg .plate.you { color: var(--jade); border-color: rgba(95,191,154,.5); }
.ls-dlg .text { font-family: var(--font-display); font-size: 1.42em; line-height: 1.45; min-height: 1.45em; }
.ls-dlg .text.dry, .ls-dlg .text.smug, .ls-dlg .text.warm { font-style: italic; }
.ls-dlg .text.aside { font-style: italic; color: var(--muted); font-size: 1.2em; }
.ls-dlg .text.angry, .ls-dlg .text.threat { letter-spacing: .02em; }
.ls-dlg .text.grunt { letter-spacing: .08em; }
/* barks (mid-fight subtitles) sit at the top centre, clear of the fighters and the boss block; block dialogue stays low */
.ls-dlg.bark { width: min(40em, 80vw); top: 11%; bottom: auto; }
.ls-dlg.bark .panel { background: linear-gradient(90deg, rgba(10,11,13,0), rgba(10,11,13,.4) 18%, rgba(10,11,13,.4) 82%, rgba(10,11,13,0)); border-top: 0; padding: .6em 2em .7em; text-align: center;
  text-shadow: 0 1px 2px rgba(0,0,0,.65), 0 0 10px rgba(0,0,0,.35); }
.ls-dlg.bark .plate { font-size: .64em; margin-bottom: .4em; padding-bottom: .3em; }
.ls-dlg.bark .text { font-size: 1.12em; }
.ls-dlg .next { position: absolute; right: 1.1em; bottom: .9em; opacity: 0; transition: opacity .2s; }
.ls-dlg .next.on { opacity: 1; animation: ls-bob 1.2s ease-in-out infinite; }
.ls-dlg .skip { position: absolute; right: 1.1em; top: .9em; font-size: .7em; color: var(--muted); }

/* ---------------------------------------------------------------- screens */
.ls-screen { position: absolute; inset: 0; pointer-events: auto; animation: ls-fade .28s ease-out; }
.ls-screen.closing { animation: ls-fadeout .22s ease-in forwards; pointer-events: none; }
.ls-dim { background: rgba(9,10,12,.88); }
.ls-hintbar { position: absolute; left: 3em; right: 3em; bottom: 2.2em; display: flex; justify-content: flex-end; gap: 2em; }
.ls-hintbar.left { justify-content: flex-start; }
.ls-h2 { font-family: var(--font-display); font-weight: 400; font-size: 2.1em; letter-spacing: .14em; text-transform: uppercase; margin: 0; }
.ls-kick { font-size: .72em; letter-spacing: .42em; text-transform: uppercase; color: var(--jade); }
.ls-rule { height: 1px; background: var(--line); }
[data-nav] { cursor: pointer; }

/* title */
.ls-title { background: linear-gradient(90deg, rgba(9,10,12,.82) 0%, rgba(9,10,12,.5) 36%, rgba(9,10,12,0) 64%), linear-gradient(0deg, rgba(9,10,12,.55), rgba(9,10,12,0) 30%); }
.ls-title .wrap { position: absolute; left: 8vw; top: 50%; transform: translateY(-56%); }
.ls-seal { width: 3.1em; height: 3.1em; color: var(--jade); margin-bottom: 1.6em; }
.ls-title h1 { margin: 0; font-family: var(--font-display); font-weight: 400; font-size: 5.6em; line-height: .98; letter-spacing: .16em; }
.ls-title h1 span { display: block; }
.ls-title h1 span + span { padding-left: 1.05em; }
.ls-title .tag { margin-top: 1.3em; display: flex; align-items: center; gap: 1em; font-size: .78em; letter-spacing: .46em; text-transform: uppercase; color: var(--muted); }
.ls-title .tag i { display: block; width: 4.5em; height: 1px; background: var(--jade); }
.ls-press { margin-top: 4.2em; display: inline-flex; align-items: center; gap: .8em; letter-spacing: .32em; text-transform: uppercase; font-size: .86em; animation: ls-breathe 2.6s ease-in-out infinite; }
.ls-menu { margin-top: 3.4em; display: flex; flex-direction: column; gap: .2em; min-width: 18em; }
.ls-mi { position: relative; padding: .55em 0 .55em 2.6em; letter-spacing: .26em; text-transform: uppercase; font-size: 1em; color: rgba(244,239,230,.62); transition: color .12s, transform .15s; }
.ls-mi::before { content: ''; position: absolute; left: 0; top: 50%; width: 1.4em; height: 1px; background: var(--jade); transform: scaleX(0); transform-origin: left; transition: transform .18s; }
.ls-mi.focus { color: var(--ink); transform: translateX(.35em); }
.ls-mi.focus::before { transform: scaleX(1); }
.ls-mi .sub { display: block; font-size: .62em; letter-spacing: .2em; color: var(--muted); margin-top: .25em; text-transform: none; letter-spacing: .06em; }
.ls-mi.disabled { opacity: .35; }
.ls-version { position: absolute; right: 3em; bottom: 2.2em; font-size: .66em; letter-spacing: .3em; color: var(--muted); }
.ls-padblocked { position: absolute; right: 3.3em; bottom: 2.4em; max-width: 60vw; text-align: right; font-size: .6em; letter-spacing: .08em; line-height: 1.35; color: var(--gold); opacity: .9; }
.ls-title.padblocked .ls-version { bottom: 5.2em; }

/* generic panel screens */
.ls-page { position: absolute; inset: 0; display: flex; flex-direction: column; padding: 3.2em 4.5em 5.4em; }
.ls-page header { display: flex; align-items: flex-end; gap: 2.4em; padding-bottom: 1em; border-bottom: 1px solid var(--line); }
.ls-page header .right { margin-left: auto; color: var(--muted); font-size: .8em; letter-spacing: .2em; text-transform: uppercase; }
.ls-page .body { flex: 1; min-height: 0; padding-top: 1.8em; }
.ls-tabs { display: flex; align-items: center; gap: 1.1em; margin-bottom: .35em; }
.ls-tab { font-size: .78em; letter-spacing: .26em; text-transform: uppercase; color: var(--muted); padding: .35em .1em; border-bottom: 1px solid transparent; cursor: pointer; }
.ls-tab.on { color: var(--ink); border-color: var(--jade); }

/* settings */
.ls-set { max-width: 46em; display: flex; flex-direction: column; gap: .15em; }
.ls-row { display: grid; grid-template-columns: 1fr 17em; align-items: center; padding: .7em 1em; border-left: 2px solid transparent; }
.ls-row.focus { background: rgba(244,239,230,.06); border-color: var(--jade); }
.ls-row .l { letter-spacing: .08em; }
.ls-row .l small { display: block; color: var(--muted); font-size: .72em; margin-top: .2em; letter-spacing: .02em; }
.ls-val { display: flex; align-items: center; gap: .8em; justify-content: flex-end; }
.ls-val .arr { color: var(--muted); font-size: .9em; opacity: 0; }
.ls-row.focus .ls-val .arr { opacity: 1; }
.ls-val .v { min-width: 6.5em; text-align: center; letter-spacing: .12em; text-transform: uppercase; font-size: .86em; }
.ls-slider { position: relative; width: 9em; height: 2px; background: rgba(244,239,230,.2); }
.ls-slider i { position: absolute; left: 0; top: 0; bottom: 0; background: var(--jade); }
.ls-slider b { position: absolute; top: 50%; width: .7em; height: .7em; margin: -.35em 0 0 -.35em; background: var(--ink); transform: rotate(45deg); }
.ls-row.btn .ls-val .v { color: var(--gold); }

/* controls */
.ls-ctl { display: grid; grid-template-columns: 1fr minmax(18em, 26em) 1fr; align-items: center; gap: 2.4em; height: 100%; }
.ls-ctl .col { display: flex; flex-direction: column; gap: .95em; }
.ls-ctl .col.l { align-items: flex-end; text-align: right; }
.ls-ctl .it { display: flex; align-items: center; gap: .8em; }
.ls-ctl .col.l .it { flex-direction: row-reverse; }
.ls-ctl .it .a { letter-spacing: .1em; text-transform: uppercase; font-size: .82em; }
.ls-ctl .it .d { display: block; color: var(--muted); font-size: .72em; letter-spacing: .02em; text-transform: none; margin-top: .15em; }
.ls-pad { width: 100%; color: rgba(244,239,230,.55); }
.ls-keys { columns: 2; column-gap: 3em; max-width: 60em; }
.ls-keys .it { break-inside: avoid; display: grid; grid-template-columns: 11em 1fr; align-items: center; gap: 1em; padding: .55em 0; border-bottom: 1px solid rgba(244,239,230,.07); }
.ls-keys .it .a { letter-spacing: .1em; text-transform: uppercase; font-size: .8em; }
.ls-keys .it .d { display: block; color: var(--muted); font-size: .72em; text-transform: none; letter-spacing: 0; }

/* credits */
.ls-credits { display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; gap: 1.5em; text-align: center; }
.ls-credits .r .k { font-size: .66em; letter-spacing: .36em; text-transform: uppercase; color: var(--muted); }
.ls-credits .r .v { font-family: var(--font-display); font-size: 1.3em; margin-top: .25em; }
.ls-credits .big { font-family: var(--font-display); font-size: 3em; letter-spacing: .2em; text-indent: .2em; }

/* chapter select */
.ls-chlist { display: flex; flex-direction: column; gap: .6em; max-width: 58em; }
.ls-ch { display: grid; grid-template-columns: 4em 1fr auto; align-items: center; gap: 1.4em; padding: 1em 1.3em; border: 1px solid var(--line); background: rgba(244,239,230,.02); }
.ls-ch.focus { border-color: var(--jade); background: rgba(95,191,154,.08); }
.ls-ch .num { font-family: var(--font-display); font-size: 2em; color: var(--muted); text-align: center; }
.ls-ch .t { font-family: var(--font-display); font-size: 1.45em; }
.ls-ch .s { color: var(--muted); font-size: .8em; letter-spacing: .1em; margin-top: .15em; }
.ls-ch .m { text-align: right; font-size: .75em; letter-spacing: .14em; text-transform: uppercase; color: var(--muted); }
.ls-ch .m b { display: block; color: var(--ink); font-family: var(--font-display); font-size: 1.6em; letter-spacing: 0; font-weight: 400; }
.ls-ch.locked { opacity: .35; }
.ls-ch.done .num { color: var(--jade); }

/* style select */
.ls-styles { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 1.6em; height: 100%; align-content: center; max-width: 76em; margin: 0 auto; }
.ls-sty { position: relative; padding: 2em 1.8em 2.2em; border: 1px solid var(--line); background: rgba(244,239,230,.025); transition: transform .2s, border-color .2s, background .2s; }
.ls-sty.focus { border-color: var(--jade); background: rgba(95,191,154,.08); transform: translateY(-.5em); }
.ls-sty .em { width: 4.4em; height: 4.4em; color: var(--jade); margin-bottom: 1.4em; }
.ls-sty .nm { font-family: var(--font-display); font-size: 2.1em; letter-spacing: .1em; text-transform: uppercase; }
.ls-sty .ab { margin-top: .35em; font-size: .78em; letter-spacing: .3em; text-transform: uppercase; color: var(--gold); }
.ls-sty .ds { margin-top: 1.2em; font-family: var(--font-display); font-size: 1.08em; line-height: 1.5; }
.ls-sty .how { margin-top: 1em; color: var(--muted); font-size: .86em; line-height: 1.55; }
.ls-sty .tagl { margin-top: 1.4em; font-size: .7em; letter-spacing: .3em; text-transform: uppercase; color: var(--ink); opacity: .7; }

/* confirm */
.ls-confirm { display: flex; align-items: center; justify-content: center; background: rgba(9,10,12,.8); }
.ls-confirm .box { width: min(34em, 86vw); padding: 2.2em 2.4em 2em; background: rgba(16,17,20,.96); border-top: 1px solid var(--jade); }
.ls-confirm .msg { font-family: var(--font-display); font-size: 1.35em; line-height: 1.45; }
.ls-confirm .sub { color: var(--muted); margin-top: .6em; font-size: .9em; }
.ls-confirm .btns { display: flex; gap: 1em; margin-top: 1.8em; }
.ls-btn { padding: .65em 1.4em; border: 1px solid var(--line); letter-spacing: .22em; text-transform: uppercase; font-size: .82em; }
.ls-btn.focus { border-color: var(--jade); background: rgba(95,191,154,.12); }

/* cards */
.ls-card { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; background: rgba(9,10,12,.95); }
.ls-card .k { font-size: .74em; letter-spacing: .5em; text-indent: .5em; text-transform: uppercase; color: var(--jade); }
.ls-card h1 { font-family: var(--font-display); font-weight: 400; font-size: 4em; letter-spacing: .08em; margin: .3em 0 .12em; }
.ls-card .st { font-family: var(--font-display); font-style: italic; color: var(--muted); font-size: 1.2em; }
.ls-card .rule { width: 6em; height: 1px; background: var(--jade); margin: 2em auto 1.6em; opacity: .7; }
.ls-card .lines p { max-width: 36em; margin: .7em auto; font-family: var(--font-display); font-size: 1.28em; line-height: 1.6; opacity: 0; transform: translateY(.45em);
  transition: opacity .8s ease, transform .8s ease; }
.ls-card .lines p.on { opacity: 1; transform: none; }
.ls-card .lines p.joke { margin-top: 1.7em; font-style: italic; color: var(--muted); font-size: 1.12em; }
.ls-card .cont { position: absolute; right: 3em; bottom: 2.4em; opacity: 0; transition: opacity .5s; }
.ls-card .cont.on { opacity: 1; }
.ls-card.premise .lines p { font-size: 1.36em; }
.ls-card .stats { display: flex; gap: 3.4em; justify-content: center; margin-top: 2.2em; }
.ls-card .stats div { font-size: .7em; letter-spacing: .32em; text-transform: uppercase; color: var(--muted); }
.ls-card .stats b { display: block; font-family: var(--font-display); font-weight: 400; font-size: 2.6em; letter-spacing: 0; color: var(--ink); margin-bottom: .1em; }
.ls-card h1.struck { position: relative; display: inline-block; }
.ls-card h1.struck::after { content: ''; position: absolute; left: -.2em; right: -.2em; top: 54%; height: 2px; background: var(--ember); transform-origin: left; animation: ls-strike .7s .5s ease-out both; }

.ls-aging { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
  background: radial-gradient(ellipse at 50% 45%, rgba(9,10,12,.55), rgba(9,10,12,.9) 70%); }
.ls-aging .ring { position: relative; width: 14em; height: 14em; }
.ls-aging .ring svg { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
.ls-aging .num { position: absolute; inset: 0; display: grid; place-items: center; font-family: var(--font-display); font-size: 6.4em; line-height: 1; }
.ls-aging .k { margin-top: 2.2em; font-size: .72em; letter-spacing: .5em; text-indent: .5em; text-transform: uppercase; color: var(--jade); }
.ls-aging .line { margin-top: 1em; max-width: 30em; font-family: var(--font-display); font-style: italic; font-size: 1.4em; line-height: 1.45;
  opacity: 0; transition: opacity .8s .2s; }
.ls-aging .line.on { opacity: 1; }
.ls-aging .meta { margin-top: 1.6em; display: flex; gap: 2.6em; font-size: .7em; letter-spacing: .3em; text-transform: uppercase; color: var(--muted); }
.ls-aging .meta b { color: var(--ink); font-size: 1.3em; letter-spacing: .05em; margin-left: .4em; }
.ls-aging.over .num { color: #d9cbb4; }
.ls-aging.over .k { color: var(--ember); }
.ls-aging .line .replay { display: block; margin-top: .8em; font-style: normal; font-family: var(--font); font-size: .58em; letter-spacing: .12em; color: var(--gold); }

/* deck editor */
.ls-deck .body { display: grid; grid-template-columns: minmax(0, 1.2fr) minmax(0, .78fr) minmax(0, 1fr); gap: 2.2em; }
.ls-deck .colA, .ls-deck .colC { min-height: 0; overflow: hidden auto; scrollbar-width: thin; }
.ls-stgrid { display: grid; grid-template-columns: 1fr 1fr; gap: 1em; }
.ls-stb { border: 1px solid var(--line); padding: .85em .9em .95em; background: rgba(244,239,230,.02); }
.ls-stb.cur { border-color: rgba(95,191,154,.45); }
.ls-stb h3 { margin: 0 0 .5em; display: flex; align-items: center; gap: .6em; font-weight: 400; font-size: .74em; letter-spacing: .28em; text-transform: uppercase; color: var(--muted); }
.ls-stb h3 .ls-sticon { width: 1.8em; height: 1.8em; color: var(--ink); }
.ls-slot { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: .75em; padding: .6em .65em; margin-top: .35em;
  border: 1px solid transparent; background: rgba(244,239,230,.035); }
.ls-slot.focus { border-color: var(--jade); background: rgba(95,191,154,.1); }
.ls-slot.picking { border-color: var(--gold); background: rgba(232,184,90,.1); }
.ls-slot .nm { font-size: 1em; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ls-slot .meta { display: flex; align-items: center; gap: .9em; margin-top: .25em; font-size: .68em; color: var(--muted); letter-spacing: .06em; }
.ls-arrow { display: inline-flex; align-items: center; gap: .3em; white-space: nowrap; }
.ls-arrow .ls-sticon { width: 1.25em; height: 1.25em; }
.ls-arrow b { font-weight: 600; letter-spacing: .1em; }
.ls-arrow i { font-style: normal; opacity: .7; margin: 0 .1em; }
.ls-wt { display: inline-flex; gap: 2px; align-items: flex-end; }
.ls-wt i { width: .32em; background: currentColor; opacity: .3; }
.ls-wt i:nth-child(1) { height: .45em; } .ls-wt i:nth-child(2) { height: .7em; } .ls-wt i:nth-child(3) { height: .95em; }
.ls-wt i.on { opacity: 1; }
.ls-props { display: inline-flex; gap: .3em; }
.ls-prop { display: inline-grid; place-items: center; width: 1.45em; height: 1.45em; border: 1px solid rgba(232,184,90,.55); color: var(--gold); font-size: .78em; line-height: 1; }
.ls-prop svg { width: 1.05em; height: 1.05em; }
.ls-preview { position: relative; border: 1px solid var(--line); min-height: 0;
  background: radial-gradient(ellipse at 50% 88%, rgba(95,191,154,.12), rgba(95,191,154,0) 55%), linear-gradient(180deg, rgba(14,15,18,.92), rgba(10,11,13,.96)); }
.ls-preview canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
.ls-preview .cap { position: absolute; left: 0; right: 0; bottom: .9em; text-align: center; font-size: .7em; letter-spacing: .3em; text-transform: uppercase; color: var(--muted); }
.ls-preview .top { position: absolute; left: 0; right: 0; top: .9em; text-align: center; font-size: .8em; }
.ls-det .nm { font-family: var(--font-display); font-size: 2em; line-height: 1.1; }
.ls-det .ds { font-family: var(--font-display); font-style: italic; color: var(--muted); margin-top: .5em; line-height: 1.5; }
.ls-det .tags { display: flex; flex-wrap: wrap; gap: .5em; margin-top: 1.1em; }
.ls-det .tag { padding: .3em .65em; border: 1px solid var(--line); font-size: .7em; letter-spacing: .18em; text-transform: uppercase; display: inline-flex; gap: .5em; align-items: center; }
.ls-det .route { margin-top: 1.2em; font-size: .95em; }
.ls-det .plist { margin-top: 1em; display: flex; flex-direction: column; gap: .45em; }
.ls-det .plist div { display: flex; align-items: center; gap: .7em; font-size: .8em; color: var(--ink); }
.ls-det .plist div span { color: var(--muted); }
.ls-fd { margin-top: 1.3em; display: grid; grid-template-columns: 1fr 1fr; gap: .1em 1.6em; }
.ls-fd div { display: flex; justify-content: space-between; align-items: baseline; padding: .45em 0; border-bottom: 1px solid rgba(244,239,230,.08); font-size: .82em; }
.ls-fd div span { color: var(--muted); letter-spacing: .12em; text-transform: uppercase; font-size: .82em; }
.ls-fd div b { font-weight: 500; font-variant-numeric: tabular-nums; }
.ls-det .learnst { margin-top: 1.2em; font-size: .78em; letter-spacing: .14em; text-transform: uppercase; color: var(--jade); }
.ls-det .learnst.no { color: var(--gold); }
.ls-pick { display: grid; grid-template-columns: minmax(0, 1fr) auto; align-items: center; gap: .9em; padding: .62em .8em; border: 1px solid transparent; margin-top: .3em; background: rgba(244,239,230,.03); }
.ls-pick.focus { border-color: var(--jade); background: rgba(95,191,154,.1); }
.ls-pick.locked { opacity: .55; }
.ls-pick.locked.focus { border-color: var(--gold); background: rgba(232,184,90,.08); }
.ls-pick .nm { font-size: .98em; }
.ls-pick .meta { display: flex; gap: .9em; align-items: center; font-size: .68em; color: var(--muted); margin-top: .2em; }
.ls-pick .eq { font-size: .62em; letter-spacing: .24em; text-transform: uppercase; color: var(--jade); }
.ls-pick .lp { width: 5em; }
.ls-pick .lp .ls-ticks { margin-top: .2em; }
.ls-pick h4, .ls-pickhead { margin: 0 0 .8em; font-weight: 400; font-size: .76em; letter-spacing: .26em; text-transform: uppercase; color: var(--muted); display: flex; align-items: center; gap: .7em; }
.ls-pickhead .ls-sticon { width: 1.8em; height: 1.8em; color: var(--ink); }
.ls-graph { width: 100%; max-width: 30em; margin: 0 auto; color: var(--ink); }
.ls-graph svg { width: 100%; height: auto; overflow: visible; }
.ls-graph .node { fill: rgba(16,17,20,.9); stroke: rgba(244,239,230,.6); stroke-width: 1.4; }
.ls-graph .nlbl { fill: var(--ink); font: 600 13px var(--font); letter-spacing: 1.5px; text-anchor: middle; dominant-baseline: central; }
.ls-graph .edge { fill: none; stroke-width: 1.6; }
.ls-graph .edge.main { stroke: rgba(244,239,230,.8); }
.ls-graph .edge.alt { stroke: var(--jade); stroke-dasharray: 5 4; }
.ls-graph .edge.hl { stroke: var(--gold); stroke-width: 2.6; stroke-dasharray: none; }
.ls-graph .elbl { font: 10.5px var(--font); fill: var(--ink); text-anchor: middle; dominant-baseline: central; paint-order: stroke; stroke: rgba(9,10,12,.92); stroke-width: 4px; }
.ls-graph .elbl.alt { fill: #bfe8d7; }
.ls-graph .elbl.hl { fill: var(--gold); }
.ls-graph .legend { font: 10px var(--font); fill: var(--muted); letter-spacing: 1px; }
.ls-route { padding: .75em .9em; border: 1px solid transparent; margin-top: .4em; background: rgba(244,239,230,.03); }
.ls-route.focus { border-color: var(--gold); background: rgba(232,184,90,.07); }
.ls-route .nm { font-family: var(--font-display); font-size: 1.15em; }
.ls-route .ds { color: var(--muted); font-size: .78em; margin-top: .25em; font-style: italic; }
.ls-route .steps { display: flex; flex-wrap: wrap; align-items: center; gap: .35em .5em; margin-top: .55em; font-size: .78em; }
.ls-route .steps .stp { display: inline-flex; align-items: center; gap: .35em; }
.ls-route .steps .stp.miss { opacity: .45; }
.ls-route .steps .sep { color: var(--muted); }
.ls-route .ok { font-size: .62em; letter-spacing: .24em; text-transform: uppercase; color: var(--jade); margin-top: .5em; }
.ls-route .ok.no { color: var(--muted); }

/* pause */
.ls-pause { background: linear-gradient(90deg, rgba(9,10,12,.9) 0%, rgba(9,10,12,.72) 40%, rgba(9,10,12,.35) 100%); }
.ls-pause .wrap { position: absolute; left: 8vw; top: 50%; transform: translateY(-50%); }
.ls-pause .meta { margin-top: .8em; color: var(--muted); font-size: .82em; letter-spacing: .14em; }
.ls-pause .meta b { color: var(--ink); font-weight: 500; }
.ls-pause .side { position: absolute; right: 7vw; top: 50%; transform: translateY(-50%); width: 22em; }
.ls-pause .side .ttl { font-size: .7em; letter-spacing: .32em; text-transform: uppercase; color: var(--muted); margin-bottom: .9em; }
.ls-pause .side .row { display: flex; align-items: center; gap: .8em; padding: .5em 0; border-bottom: 1px solid rgba(244,239,230,.07); font-size: .86em; }
.ls-pause .side .row .ls-sticon { width: 1.5em; height: 1.5em; flex: none; }
.ls-pause .side .row .mv { flex: 1; min-width: 0; }
.ls-pause .side .row .mv div { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ls-pause .side .row .mv div + div { color: var(--muted); font-size: .9em; }

@keyframes ls-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes ls-fadeout { from { opacity: 1; } to { opacity: 0; } }
@keyframes ls-breathe { 0%, 100% { opacity: .45; } 50% { opacity: 1; } }
@keyframes ls-bob { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-.15em); } }
@keyframes ls-tin { from { opacity: 0; transform: translateX(1.2em); } to { opacity: 1; transform: none; } }
@keyframes ls-pulse { 0% { transform: scale(1.18); } 100% { transform: scale(1); } }
@keyframes ls-qflash { 0% { transform: scale(1.12); filter: drop-shadow(0 0 6px rgba(244,239,230,.9)); } 100% { transform: scale(1); filter: none; } }
@keyframes ls-lockin { 0% { transform: scale(1.8) rotate(45deg); opacity: 0; } 100% { transform: none; opacity: 1; } }
@keyframes ls-retin { 0% { transform: translateY(-.7em) scale(1.5); opacity: 0; } 100% { transform: none; opacity: 1; } }
@keyframes ls-blink { 0% { opacity: 1; } 100% { opacity: .25; } }
@keyframes ls-shake { 0%, 100% { transform: none; } 25% { transform: translateX(-.25em); } 75% { transform: translateX(.25em); } }
@keyframes ls-strike { from { transform: scaleX(0); } to { transform: scaleX(1); } }

@media (max-width: 1100px) {
  /* the boss block stays low (between the player bars and the stance quadrant); only its width shrinks */
  .ls-boss { width: min(30em, 48vw); }
  .ls-prompt { bottom: 8.6em; }
  .ls-bar { width: 17em; } .ls-bar.st { width: 13em; }
  .ls-deck .body { grid-template-columns: minmax(0, 1.25fr) minmax(0, .62fr) minmax(0, 1fr); gap: 1.4em; }
  .ls-page { padding: 2.2em 2.6em 4.6em; }
  .ls-title h1 { font-size: 4.6em; }
}
`;

let injected = false;
/** Inject the UI stylesheet once. */
export function injectCSS() {
  if (injected || typeof document === 'undefined') return;
  injected = true;
  const st = document.createElement('style');
  st.id = 'ls-ui-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}
