// Mission Log panel (action `missions`, J): every mission with status, giver location, reward, difficulty, best
// race result, "Set waypoint" and (for the active one) "Abandon". Mounted in hud.openPanel or a fallback modal.
import { h, injectCss, fmtMoney, fmtClock, districtName, esc } from './util.js';
import { injectShopCss } from './shop_ui.js';

const CSS = `
.bcm-log { display: flex; flex-direction: column; gap: 12px; }
.bcm-log .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.bcm-log .stat { padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.08); }
.bcm-log .stat .k { font: 700 10px/1 var(--font); letter-spacing: .16em; text-transform: uppercase; color: #9aa4b2; }
.bcm-log .stat .v { margin-top: 6px; font: 800 24px/1 var(--font-display); letter-spacing: .03em; color: #fff; }
.bcm-log .stat .v.g { color: #7ee07a; } .bcm-log .stat .v.y { color: #ffd84a; }
.bcm-mis { display: flex; gap: 14px; align-items: flex-start; padding: 12px; border-radius: 10px; background: rgba(255,255,255,.045);
  border: 1px solid rgba(255,255,255,.08); transition: border-color .15s, background .15s; }
.bcm-mis:hover { border-color: rgba(255,255,255,.2); background: rgba(255,255,255,.07); }
.bcm-mis.active { border-color: rgba(245,197,24,.7); background: rgba(245,197,24,.08); }
.bcm-mis.done { opacity: .92; }
.bcm-mis .badge { flex: none; width: 46px; height: 46px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
  font: 900 26px/1 var(--font-display); color: #1a1405; background: radial-gradient(circle at 40% 35%, #ffe680, #f5c518 55%, #c99a00);
  box-shadow: 0 0 0 3px rgba(0,0,0,.6), 0 4px 10px rgba(0,0,0,.35); }
.bcm-mis.done .badge { background: radial-gradient(circle at 40% 35%, #d9dee6, #9aa4b2 60%, #6b7480); }
.bcm-mis .mid { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.bcm-mis .t { font: 800 17px/1.15 var(--font); color: #fff; }
.bcm-mis .d { font: 500 13px/1.4 var(--font); color: #c9d1dc; }
.bcm-mis .m { font: 600 12px/1.4 var(--font); color: #9aa4b2; }
.bcm-mis .m b { color: #e6ebf1; font-weight: 700; }
.bcm-mis .acts { flex: none; display: flex; flex-direction: column; gap: 6px; width: 140px; }
.bcm-diff { color: #ffd84a; letter-spacing: 1px; }
@media (max-width: 640px) { .bcm-mis { flex-wrap: wrap; } .bcm-mis .acts { width: 100%; flex-direction: row; } .bcm-log .stats { grid-template-columns: 1fr 1fr; } }
`;

/** Build the mission log element. sys = Missions. Returns {el, refresh()}. */
export function buildMissionLog(sys) {
  injectShopCss();
  injectCss('log', CSS);
  const g = sys.game;
  const root = h('div', 'bcm-log bcm-shop');
  const stats = h('div', 'stats', root);
  const list = h('div', '', root);
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px';
  const foot = h('div', 'bcm-foot', root);
  foot.innerHTML = 'Walk into a <b style="color:#ffd84a">yellow marker</b> to start a mission. Replays pay half. <kbd>J</kbd> / <kbd>Esc</kbd> closes.';

  function refresh() {
    const defs = sys.defs;
    const done = defs.filter((d) => sys.completed.has(d.id)).length;
    const act = sys.active && !sys.active.side ? sys.active.def : null;
    stats.innerHTML =
      '<div class="stat"><div class="k">Completed</div><div class="v y">' + done + ' / ' + defs.length + '</div></div>' +
      '<div class="stat"><div class="k">Mission earnings</div><div class="v g">' + esc(fmtMoney(sys.earned)) + '</div></div>' +
      '<div class="stat"><div class="k">Current</div><div class="v" style="font-size:17px;line-height:1.4">' + esc(act ? act.title : 'Free roam') + '</div></div>';
    list.textContent = '';
    for (const d of defs) {
      const isDone = sys.completed.has(d.id);
      const isAct = act === d;
      const row = h('div', 'bcm-mis' + (isAct ? ' active' : '') + (isDone ? ' done' : ''), list);
      h('div', 'badge', row, isDone && !isAct ? '✓' : d.letter || d.title.charAt(0));
      const mid = h('div', 'mid', row);
      const t = h('div', 't', mid, d.title);
      const tag = h('span', 'bcm-tag ' + (isAct ? 'gold' : isDone ? '' : 'blue'), t, isAct ? 'In progress' : isDone ? 'Completed' : 'New');
      void tag;
      h('div', 'd', mid, d.blurb || '');
      const where = d.giver ? (d.giverName || '') + (districtName(g, d.giver.x, d.giver.z) ? ' · ' + districtName(g, d.giver.x, d.giver.z) : '') : '';
      const reward = isDone ? fmtMoney(Math.round(d.reward / 2)) + ' <span style="opacity:.7">(replay)</span>' : fmtMoney(d.reward);
      let meta = '<b>' + esc(where) + '</b> · Reward <b>' + reward + '</b> · <span class="bcm-diff">' + '★'.repeat(d.difficulty || 1) + '<span style="opacity:.25">' + '★'.repeat(3 - (d.difficulty || 1)) + '</span></span>';
      if (d.timeLimit) meta += ' · ' + Math.round(d.timeLimit / 60) + ' min limit';
      const best = sys.best[d.id];
      if (best && best.time) meta += ' · Best <b>' + esc((best.medal ? best.medal.toUpperCase() + ' ' : '') + fmtClock(best.time, 2)) + '</b>';
      const m = h('div', 'm', mid);
      m.innerHTML = meta;
      const acts = h('div', 'acts', row);
      if (isAct) {
        const b = h('button', 'bcm-btn red', acts, 'Abandon');
        b.type = 'button';
        b.addEventListener('click', (e) => { e.stopPropagation(); sys.abandon(); refresh(); });
      } else if (d.giver) {
        const b = h('button', 'bcm-btn gold', acts, 'Set waypoint');
        b.type = 'button';
        b.addEventListener('click', (e) => {
          e.stopPropagation();
          const hud = g.hud;
          if (hud && typeof hud.setWaypoint === 'function') hud.setWaypoint({ x: d.giver.x, z: d.giver.z }, true);
          else if (hud) hud.waypoint = { x: d.giver.x, z: d.giver.z };
          g.audio?.play?.('checkpoint', { volume: 0.6 });
          g.hud?.notify?.('Waypoint set: *' + d.title + '* (' + (d.giverName || '') + ').', { duration: 2.5, color: '#f5c518' });
          b.textContent = 'Waypoint set ✓';
        });
      }
    }
  }
  refresh();
  return { el: root, refresh };
}
