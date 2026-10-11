// Fighter models: Absolver-like masked martial artists, stylised low-poly, flat-shaded.
// ONE rigid-skinned THREE.SkinnedMesh per fighter (2 material groups: cloth + glossy mask/trim = 2 draw calls).
// Every part is built in its bone's local space and bound with identity bone inverses, so the rig's bones
// (rig.js createSkeleton) drive the mesh directly. Extra cloth bones (sash tails, tunic flaps) hang off the hips and
// are swung by a cheap spring in the Animator.
import * as THREE from 'three';
import { createSkeleton, JOINTS } from './rig.js';
import { MeshKit, col, shade, mix } from './meshkit.js';
import { resolveLook } from './looks.js';

/** Extra cloth bones (children of hips, chains of 2). offset in hips space is filled per look. */
export const CLOTH_BONES = ['sashA1', 'sashA2', 'sashB1', 'sashB2', 'flapF1', 'flapF2', 'flapB1', 'flapB2'];
export const BONE_NAMES = ['body', ...JOINTS, ...CLOTH_BONES];
const BI = Object.fromEntries(BONE_NAMES.map((n, i) => [n, i]));

const GEO_CACHE = new Map(); // look.key -> { geo, refs, cloth }

// ------------------------------------------------------------------------------------------------ geometry

function buildGeometry(d) {
  const k = new MeshKit();
  const P = d.pal, S = d.shape;
  const g = S.girth, bl = S.belly, sh = S.shoulder, ar = S.arm, lg = S.leg, hd = S.head, hn = S.hand;
  const skin = col(P.skin), top = col(P.top), top2 = col(P.top2), trim = col(P.trim), trousers = col(P.trousers);
  const sash = col(P.sash), wrap = col(P.wrap), wrap2 = shade(P.wrap, 0.86), shoe = col(P.shoe), hair = col(P.hair);
  const bare = d.sleeves === 'none';
  const longSleeve = d.sleeves === 'long';
  const suit = d.top === 'suit' || d.top === 'suitvest';

  // ---- hips: pelvis, sash / belt + knot
  k.at(BI.hips);
  const pelvisTop = d.top === 'qipao' ? top : trousers;
  k.tube(8, [[-0.145, 0.105 * g, 0.082 * g], [-0.08, 0.148 * g, 0.1 * g * bl], [0.02, 0.152 * g, 0.104 * g * bl], [0.095, 0.148 * g, 0.104 * g * bl]],
    [trousers, pelvisTop, pelvisTop]);
  const beltH = suit || d.top === 'tank' ? 0.04 : 0.075;
  k.tube(8, [[0.0, 0.16 * g, 0.113 * g * bl], [beltH, 0.157 * g, 0.111 * g * bl]], sash);
  if (!suit && d.top !== 'tank') k.box([0.1 * g, 0.036, 0.108 * g * bl], [0.055, 0.06, 0.04], shade(P.sash, 0.9));
  else k.box([0, 0.02, 0.114 * g * bl], [0.045, 0.03, 0.012], col(P.trim)); // buckle
  if (d.ledger) {
    k.box([-0.165 * g, -0.06, 0.03], [0.05, 0.2, 0.15], col(0x2f4a3c));
    k.box([-0.163 * g, -0.06, 0.03], [0.054, 0.185, 0.13], col(0xe9e1cc));
    k.box([-0.165 * g, 0.03, 0.03], [0.058, 0.02, 0.155], col(0x3b2a20));
  }

  // ---- torso sections (spine + chest bones share one continuous profile; y is bone-local)
  const chestW = Math.min(0.2, 0.18 * Math.sqrt(g * sh));
  const gq = Math.sqrt(g);
  const SP = [[-0.03, 0.148 * g, 0.104 * g * bl], [0.1, 0.152 * g, 0.108 * g * bl], [0.215, 0.158 * g, 0.11 * g * Math.sqrt(bl)]];
  const CH = [[-0.01, 0.158 * g, 0.11 * g * Math.sqrt(bl)], [0.09, chestW * 0.97, 0.125 * g], [0.17, chestW, 0.12 * g],
    [0.225, chestW * 0.8, 0.1 * gq], [0.262, 0.095 * gq, 0.076 * gq], [0.285, 0.062, 0.056]];
  const secAt = (secs, y) => {
    if (y <= secs[0][0]) return secs[0];
    for (let i = 1; i < secs.length; i++) {
      if (y <= secs[i][0]) { const a = secs[i - 1], b = secs[i], t = (y - a[0]) / (b[0] - a[0]); return [y, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]; }
    }
    return secs[secs.length - 1];
  };
  /** Ribbon on the torso surface along a polyline of [x, y] (chest-local y; below 0 continues on the spine bone). */
  const torsoRibbon = (pts, width, thick, color, side = 1, width1 = width) => {
    const dense = [];
    for (let i = 0; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1];
      const n = Math.max(2, Math.ceil(Math.hypot(x1 - x0, y1 - y0) / 0.035));
      for (let j = 0; j < n; j++) dense.push([x0 + (x1 - x0) * (j / n), y0 + (y1 - y0) * (j / n)]);
    }
    dense.push(pts[pts.length - 1]);
    const runs = { chest: [], spine: [] };
    dense.forEach(([x, y], i) => {
      const onChest = y >= -0.005;
      const ly = onChest ? y : y + 0.2;
      const [, rx, rz] = secAt(onChest ? CH : SP, ly);
      const u = Math.min(0.97, Math.abs(x) / rx);
      const z = side * rz * Math.sqrt(1 - u * u) * 0.985;
      const w = width + (width1 - width) * (i / (dense.length - 1));
      (onChest ? runs.chest : runs.spine).push({ p: [x, ly, z], n: [x / (rx * rx), 0, z / (rz * rz)], w });
    });
    for (const key of ['chest', 'spine']) {
      const r = runs[key];
      if (r.length < 2) continue;
      k.at(BI[key]);
      k.ribbon(r.map((q) => q.p), r.map((q) => q.n), r[0].w, thick, color, r[r.length - 1].w);
    }
  };

  // ---- spine: abdomen
  k.at(BI.spine);
  const vest = d.top === 'vest', tank = d.top === 'tank', padded = d.top === 'padded';
  k.tube(8, SP, vest ? skin : top, false);
  if (padded) {
    k.tube(8, [[-0.02, 0.168 * g, 0.124 * g * bl], [0.07, 0.172 * g, 0.128 * g * bl], [0.08, 0.166 * g, 0.122 * g * bl], [0.15, 0.172 * g, 0.126 * g * bl], [0.16, 0.168 * g, 0.122 * g * bl], [0.23, 0.172 * g, 0.122 * g]],
      [top, shade(P.top, 0.8), top2, shade(P.top, 0.8), top], true);
  }

  // ---- chest
  k.at(BI.chest);
  k.tube(8, CH, tank ? [top, top, skin, skin, skin] : vest ? skin : top, false);
  if (padded) {
    k.tube(8, [[0.0, 0.17 * g, 0.122 * g], [0.09, chestW * 1.05, 0.136 * g], [0.1, chestW * 1.02, 0.132 * g], [0.2, chestW * 1.04, 0.13 * g], [0.255, chestW * 0.78, 0.1 * g]],
      [top, shade(P.top, 0.8), top2, top], false);
    for (const sx of [1, -1]) k.ellipsoid([sx * 0.15, 0.225, 0], [0.085 * gq, 0.04, 0.105 * gq], 6, 3, shade(P.top2, 1.05), { vMin: -0.3 });
  }
  if (vest) {
    // open vest: back + shoulders, lapels down the front
    k.tube(8, CH.slice(0, 4).map(([y, rx, rz]) => [y, rx * 1.03, rz * 1.03]), top, false, Math.PI / 8 + Math.PI);
    k.at(BI.spine);
    k.tube(8, SP.map(([y, rx, rz]) => [y, rx * 1.03, rz * 1.03]), top, false, Math.PI / 8 + Math.PI);
    for (const sx of [1, -1]) torsoRibbon([[sx * 0.07, 0.262], [sx * 0.1, 0.12], [sx * 0.11, -0.05], [sx * 0.115, -0.22]], 0.07, 0.016, top);
  }
  if (tank) for (const sx of [1, -1]) { torsoRibbon([[sx * 0.09, 0.26], [sx * 0.1, 0.17]], 0.05, 0.012, top); torsoRibbon([[sx * 0.09, 0.26], [sx * 0.1, 0.17]], 0.05, 0.012, top, -1); }
  if (d.top === 'tunic' || padded) {
    // crossed collar: the left panel's edge runs from the right of the neck to the left hip; the right panel tucks under
    torsoRibbon([[-0.058, 0.272], [-0.02, 0.2], [0.05, 0.1], [0.1, 0.0], [0.12, -0.18]], 0.045, 0.012, trim);
    torsoRibbon([[0.058, 0.272], [0.03, 0.21], [-0.005, 0.15]], 0.04, 0.008, shade(P.trim, 0.85));
    k.at(BI.chest);
    k.tube(8, [[0.252, 0.1 * gq, 0.078 * gq], [0.292, 0.072, 0.064]], trim, false);
  }
  if (d.top === 'qipao') {
    k.tube(8, [[0.255, 0.085, 0.075], [0.31, 0.078, 0.068]], trim, true);
    torsoRibbon([[0.0, 0.27], [-0.06, 0.22], [-0.13, 0.16]], 0.024, 0.01, trim);
  }
  if (d.apron) {
    torsoRibbon([[0, 0.2], [0, 0.0], [0, -0.22]], 0.17, 0.01, top2, 1, 0.24);
    for (const sx of [1, -1]) torsoRibbon([[sx * 0.075, 0.2], [sx * 0.06, 0.262]], 0.016, 0.008, top2);
  }
  if (suit) {
    // shirt V, tie, lapels
    torsoRibbon([[0, 0.275], [0, 0.1]], 0.075, 0.004, d.top === 'suit' ? col(0x1f1f24) : top2, 1, 0.012);
    if (d.tie) torsoRibbon([[0, 0.262], [0, 0.12], [0, -0.04]], 0.026, 0.012, d.top === 'suit' ? trim : col(P.accent), 1, 0.04);
    for (const sx of [1, -1]) {
      if (d.top === 'suit') torsoRibbon([[sx * 0.055, 0.272], [sx * 0.07, 0.17], [sx * 0.04, 0.06]], 0.05, 0.012, trim, 1, 0.015);
      else torsoRibbon([[sx * 0.05, 0.262], [sx * 0.035, 0.1], [sx * 0.03, 0.04]], 0.028, 0.006, top2, 1, 0.006);
    }
    if (d.top === 'suit') for (const sx of [1, -1]) torsoRibbon([[sx * 0.06, 0.02], [sx * 0.12, -0.2]], 0.08, 0.01, top, 1, 0.1);
    k.at(BI.chest);
    k.tube(8, [[0.25, 0.088, 0.072], [0.292, 0.072, 0.064]], top2, false);
  }
  if (d.hair === 'hood') { k.at(BI.chest); k.tube(8, [[0.2, chestW * 0.9, 0.11 * g], [0.255, 0.13 * g, 0.1 * g], [0.32, 0.095, 0.085]], top2, 'bottom'); }

  // ---- neck
  k.at(BI.neck);
  k.tube(6, [[-0.03, 0.05, 0.048], [0.1, 0.046, 0.044]], skin, false);
  if (d.top === 'qipao') k.tube(8, [[0.0, 0.065, 0.062], [0.06, 0.062, 0.06]], top, false);

  // ---- head + mask
  buildHead(k, d, hd);

  // ---- arms
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    const sleeve = suit ? col(P.top2) : top2;
    const jacket = d.top === 'suit' ? top : sleeve;
    k.at(BI['shoulder' + side]);
    k.ellipsoid([sx * 0.006, -0.035, 0], [0.062 * ar, 0.078 * Math.pow(ar, 0.6), 0.064 * ar], 8, 5, bare ? skin : jacket);
    k.tube(6, [[0.0, 0.058 * ar, 0.058 * ar], [-0.13, 0.058 * ar, 0.054 * ar], [-0.29, 0.045 * ar, 0.045 * ar]], bare ? skin : longSleeve ? jacket : [sleeve, skin], false);
    if (!bare && !longSleeve) k.tube(6, [[0.035, 0.078 * ar, 0.074 * ar], [-0.16, 0.074 * ar, 0.07 * ar]], sleeve, 'bottom');
    if (d.woklid && side === 'L') {
      const m = new THREE.Matrix4().makeRotationZ(-1.0).setPosition(0.07, 0.02, 0);
      k.xf(m).ellipsoid([0, 0, 0], [0.15, 0.05, 0.15], 8, 2, col(0x2e2f33), { vMin: 0 });
      k.xf(m).box([0, 0.06, 0], [0.04, 0.03, 0.04], col(0x6b4a2f));
      k.xf(null);
    }
    k.at(BI['elbow' + side]);
    if (longSleeve) {
      k.tube(6, [[0.02, 0.05 * ar, 0.05 * ar], [-0.2, 0.046 * ar, 0.044 * ar], [-0.24, 0.047 * ar, 0.045 * ar]], [jacket, d.top === 'suit' ? trim : shade(P.top2, 0.9)], true);
    } else {
      k.tube(6, [[0.02, 0.047 * ar, 0.047 * ar], [-0.09, 0.046 * ar, 0.043 * ar], [-0.25, 0.037 * ar, 0.035 * ar]], skin, false);
      k.tube(6, [[-0.085, 0.05 * ar, 0.047 * ar], [-0.14, 0.047 * ar, 0.045 * ar], [-0.19, 0.044 * ar, 0.042 * ar], [-0.255, 0.041 * ar, 0.039 * ar]], [wrap, wrap2, wrap], true);
    }
    k.at(BI['wrist' + side]);
    const fist = suit || d.preset === 'madame_shu' ? skin : wrap;
    k.box([0, -0.06, 0.01], [0.074 * hn, 0.1 * hn, 0.09 * hn], fist, [0.85, 0.85]);
    k.box([0, -0.11 * hn, 0.012], [0.068 * hn, 0.022, 0.082 * hn], shade(fist, 0.9));
    k.box([-sx * 0.012, -0.045, 0.052 * hn], [0.03, 0.05, 0.026], shade(fist, 0.95));
  }

  // ---- legs
  for (const side of ['L', 'R']) {
    const sx = side === 'L' ? 1 : -1;
    k.at(BI['thigh' + side]);
    k.tube(7, [[0.05, 0.096 * lg * g, 0.1 * lg * g, -sx * 0.01], [-0.2, 0.09 * lg, 0.094 * lg], [-0.44, 0.072 * lg, 0.076 * lg]], trousers, false);
    k.at(BI['knee' + side]);
    if (suit) {
      k.tube(7, [[0.03, 0.075 * lg, 0.078 * lg], [-0.38, 0.072 * lg, 0.075 * lg], [-0.4, 0.07 * lg, 0.072 * lg]], [trousers, shade(P.trousers, 0.9)], true);
    } else {
      k.tube(7, [[0.03, 0.075 * lg, 0.078 * lg], [-0.12, 0.086 * lg, 0.088 * lg], [-0.215, 0.094 * lg, 0.097 * lg], [-0.23, 0.064 * lg, 0.066 * lg]],
        [trousers, trousers, shade(P.trousers, 0.85)], true);
      k.tube(6, [[-0.2, 0.057 * lg, 0.058 * lg], [-0.26, 0.054 * lg, 0.055 * lg], [-0.32, 0.05 * lg, 0.052 * lg], [-0.4, 0.047 * lg, 0.049 * lg]], [wrap, wrap2, wrap], false);
    }
    k.at(BI['ankle' + side]);
    const foot = suit ? shoe : wrap;
    if (!suit) k.tube(6, [[0.02, 0.048 * lg, 0.05 * lg], [-0.045, 0.052 * lg, 0.058 * lg]], wrap2, false);
    k.box([0, -0.049, 0.055], [0.09, 0.047, 0.245], suit ? shoe : shade(P.shoe, 1.2), [0.95, 0.9]);
    k.box([0, -0.012, 0.03], [0.082, 0.05, 0.13], foot, [0.85, 0.75]);
  }

  // ---- cloth: flaps + sash tails (geometry hangs straight down from each cloth bone)
  const cloth = [];
  const fl = d.flaps;
  if (fl) {
    const w = fl.width * g;
    const flapCol = d.apron ? top2 : d.top === 'suit' ? top : top;
    const hem = d.top === 'qipao' || d.top === 'suit' ? trim : shade(d.apron ? P.top2 : P.top, 0.8);
    for (const [name, lens, z, c] of [['flapF', fl.front, 0.116 * g * bl, flapCol], ['flapB', fl.back, -0.112 * g * bl, d.apron ? top : top]]) {
      if (!lens) continue;
      cloth.push({ bone: name + '1', offset: [0, 0.005, z], kind: name, seg: 0 });
      k.at(BI[name + '1']);
      const l1 = lens[0];
      k.box([0, -l1 / 2 + 0.01, 0], [w * 0.92, l1 + 0.02, 0.016], lens.length > 1 ? c : c, [0.92, 1]);
      if (lens.length === 1) k.box([0, -l1 + 0.012, 0], [w * 0.93, 0.026, 0.02], hem);
      if (lens.length > 1) {
        cloth.push({ bone: name + '2', offset: [0, -l1, 0], kind: name, seg: 1 });
        k.at(BI[name + '2']);
        const l2 = lens[1];
        k.box([0, -l2 / 2, 0], [w * 1.0, l2 + 0.02, 0.016], c, [0.93, 1]);
        k.box([0, -l2 + 0.012, 0], [w * 1.01, 0.026, 0.02], hem);
      }
    }
  }
  if (d.tails) {
    const [la, lb] = d.tails;
    const dark = shade(P.sash, 0.78);
    const defs = [['sashA', [0.1 * g, 0.02, 0.118 * g * bl], la], ['sashB', [0.125 * g, 0.02, 0.098 * g * bl], lb]];
    for (const [name, off, l] of defs) {
      cloth.push({ bone: name + '1', offset: off, kind: 'sash', seg: 0 });
      cloth.push({ bone: name + '2', offset: [0, -l * 0.55, 0], kind: 'sash', seg: 1 });
      k.at(BI[name + '1']);
      k.box([0, -l * 0.275, 0], [0.056, l * 0.55 + 0.01, 0.012], sash);
      k.at(BI[name + '2']);
      k.box([0, -l * 0.225, 0], [0.052, l * 0.45, 0.012], sash, [1, 1]);
      k.box([0, -l * 0.45 + 0.012, 0], [0.056, 0.024, 0.016], dark);
    }
  }
  return { geo: k.build(), cloth };
}

// ------------------------------------------------------------------------------------------------ head & masks

function buildHead(k, d, hd) {
  const P = d.pal;
  const skin = col(P.skin), hair = col(P.hair);
  const c = [0, 0.105 * hd, 0.012 * hd];
  const r = [0.088 * hd, 0.112 * hd, 0.098 * hd];
  k.at(BI.head);
  const bald = d.hair === 'bald';
  k.ellipsoid(c, r, 8, 6, (nx, ny, nz) => (!bald && (ny > 0.2 || nz < -0.3) ? hair : skin));
  // ears
  for (const sx of [1, -1]) k.box([sx * 0.086 * hd, 0.09 * hd, -0.005], [0.02, 0.045, 0.03], shade(P.skin, 0.92));

  // hair & headwear
  if (d.hair === 'topknot') {
    k.ellipsoid([0, 0.235 * hd, -0.035], [0.034, 0.042, 0.034], 6, 4, hair);
    k.tube(6, [[0.198 * hd, 0.03, 0.03, 0, -0.03], [0.214 * hd, 0.031, 0.031, 0, -0.032]], col(P.accent), false);
  } else if (d.hair === 'bun') {
    k.ellipsoid([0, 0.19 * hd, -0.1 * hd], [0.058, 0.052, 0.05], 7, 4, hair);
    k.strip([-0.09, 0.24 * hd, -0.08], [0.1, 0.16 * hd, -0.13], 0.012, 0.012, [0, 0, -1], col(P.trim));
  } else if (d.hair === 'slick') {
    k.ellipsoid([c[0], c[1] + 0.008, c[2] - 0.006], [r[0] * 1.05, r[1] * 1.03, r[2] * 1.05], 8, 3, hair, { vMin: 0.25 });
  } else if (d.hair === 'cap') {
    k.ellipsoid([c[0], c[1] + 0.01, c[2]], [r[0] * 1.1, r[1] * 1.04, r[2] * 1.1], 8, 3, col(P.top2 === P.top ? shade(P.top, 0.8) : P.top2), { vMin: 0.3 });
    k.box([0, c[1] + 0.06 * hd, c[2] + r[2] * 1.05], [0.15, 0.012, 0.08], shade(P.top, 0.7));
  } else if (d.hair === 'hood') {
    const hood = col(P.top2), inner = shade(P.top2, 0.55);
    const us = [52, 80, 110, 140, 165, 195, 220, 250, 280, 308];
    const vs = [-62, -38, -12, 14, 40, 62, 82];
    k.shell([c[0], c[1] + 0.012, c[2] - 0.012], [r[0] * 1.26, r[1] * 1.2, r[2] * 1.24], us, vs,
      (u, v) => (v > 70 && Math.abs(Math.cos(u * Math.PI / 180)) > 0.6 && Math.cos(u * Math.PI / 180) < 0 ? 0.03 : 0), () => hood, inner);
  }
  if (d.headband) {
    const band = col(d.preset === 'brick' ? P.trim : P.accent);
    k.tube(8, [[c[1] + 0.035 * hd, r[0] * 1.1, r[2] * 1.1, c[0], c[2]], [c[1] + 0.075 * hd, r[0] * 1.08, r[2] * 1.08, c[0], c[2]]], band, false);
    k.strip([0.02, c[1] + 0.05, c[2] - r[2] * 1.08], [0.05, c[1] - 0.08, c[2] - r[2] * 1.25], 0.035, 0.01, [0, 0, -1], band);
    k.strip([-0.02, c[1] + 0.05, c[2] - r[2] * 1.08], [-0.06, c[1] - 0.06, c[2] - r[2] * 1.2], 0.035, 0.01, [0, 0, -1], band);
  }
  buildMask(k, d, c, r);
}

/**
 * The signature mask: a faceted shell over the face with a carved brow, recessed eye slits, a nose ridge and an
 * accent pattern. Material group 1 (glossy porcelain / metal).
 */
function buildMask(k, d, c, r) {
  const m = d.mask, P = d.pal;
  const base = col(P.mask), dark = col(P.maskDark), acc = col(P.accent);
  k.at(BI.head, 1);
  const us = [-82, -60, -36, -13, 0, 13, 36, 60, 82];
  let vs = [-64, -42, -20, -5, 8, 21, 40, 60, 74];
  if (m.kind === 'half' || m.kind === 'brick') vs = [-20, -5, 8, 21, 40, 60, 74];
  if (m.kind === 'narrow') vs = [-64, -42, -20, -4, 6, 21, 40, 60, 74];
  const eyeLo = m.kind === 'narrow' ? -4 : -5, eyeHi = m.kind === 'narrow' ? 6 : 8;
  const slant = m.slant || 0;
  // warp the eye rows so the outer corners lift (slant); carve slits in; raise brow and ridge
  const warpV = (u, v) => (v === eyeLo || v === eyeHi ? v + slant * Math.min(1, Math.abs(u) / 36) * (v === eyeHi ? 1 : 0.6) : v);
  const push = (u, v) => {
    let p = 0.004;
    const au = Math.abs(u);
    if (v === eyeHi && au <= 36) p += m.brow || 0.01;          // brow line
    if (v === 21 && au <= 36) p += (m.brow || 0.01) * 0.5;
    if (au === 0 && v >= -20 && v <= 21) p += m.ridge || 0.01;  // nose ridge
    if (au === 0 && v === -42) p += 0.006;                      // chin
    if (au >= 60) p -= 0.004;
    if (m.kind === 'brick') p += 0.004 * (1 - au / 82);
    if (m.kind === 'stout' && v <= -20) p += 0.01;
    return p;
  };
  const isEye = (u, v) => v > eyeLo && v < eyeHi && Math.abs(u) > 13 && Math.abs(u) < 36 + (m.kind === 'narrow' ? 0 : 0);
  const color = (i, j, u, v) => {
    if (isEye(u, v) && m.kind !== 'spectacles') return dark;
    const au = Math.abs(u);
    switch (m.stripe) {
      case 'tear': if (u > 13 && u < 36 && v < eyeLo && v > -42) return acc; break;           // jade tear under the left eye
      case 'center': if (au < 13 && v > eyeHi) return acc; break;                               // forehead stripe
      case 'seam': if (au < 13 && (v > eyeHi || v < -20)) return shade(P.mask, 0.78); break;     // stitched seam
      case 'diagonal': if ((u > 0 && u < 36 && v > eyeHi && v < 40) || (u < 0 && u > -36 && v < eyeLo && v > -42)) return acc; break;
      case 'brow': if (v > eyeHi && v < 21 && au < 60) return acc; break;
      case 'wings': if (v > eyeLo - 15 && v < eyeHi + 13 && au > 13 && au < 60 && !isEye(u, v)) return acc; break;
      default: break;
    }
    if (m.kind === 'cloth' && v < -20) return shade(P.mask, 0.9);
    return base;
  };
  // sculpt: per-kind face profile (flatter front, narrower jaw, chin point) on an ellipsoid shell
  const SHAPE = {
    porcelain: { flat: 0.45, jaw: 0.3, chin: 0.008 }, narrow: { flat: 0.4, jaw: 0.42, chin: 0.012 },
    half: { flat: 0.35, jaw: 0.1, chin: 0 }, stout: { flat: 0.55, jaw: 0.05, chin: 0.014 },
    brick: { flat: 0.7, jaw: 0.0, chin: 0.006 }, cloth: { flat: 0.15, jaw: 0.18, chin: 0.004 },
    spectacles: { flat: 0.4, jaw: 0.25, chin: 0.006 }, opera: { flat: 0.45, jaw: 0.32, chin: 0.008 },
    golden: { flat: 0.5, jaw: 0.28, chin: 0.01 },
  }[m.kind] || { flat: 0.4, jaw: 0.25, chin: 0.006 };
  const R = [r[0] * 1.07, r[1] * 1.05, r[2] * 1.07];
  const Pt = (u, v) => {
    const vv = warpV(u, v), ur = u * Math.PI / 180, vr = vv * Math.PI / 180;
    const jaw = vv < -8 ? 1 - Math.min(1, (-8 - vv) / 56) * SHAPE.jaw : 1;
    const cu = Math.cos(ur), cv = Math.cos(vr);
    const x = Math.sin(ur) * cv * R[0] * jaw;
    const y = Math.sin(vr) * R[1];
    const c0 = cu * cv;
    let z = R[2] * (c0 + (1 - c0) * SHAPE.flat * Math.max(0, cu));
    let e = push(u, v);
    if (u === 0 && v <= -42) e += SHAPE.chin;
    // push along the (approximate) surface normal
    const nx = x / (R[0] * R[0]), ny = y / (R[1] * R[1]), nz = z / (R[2] * R[2]), nl = Math.hypot(nx, ny, nz) || 1;
    return [c[0] + x + (nx / nl) * e, c[1] + y + (ny / nl) * e, c[2] + z + (nz / nl) * e];
  };
  for (let j = 0; j < vs.length - 1; j++) {
    for (let i = 0; i < us.length - 1; i++) {
      const u0 = us[i], u1 = us[i + 1], v0 = vs[j], v1 = vs[j + 1];
      const cc = color(i, j, (u0 + u1) / 2, (v0 + v1) / 2);
      if (!cc) continue;
      const a = Pt(u0, v0), b = Pt(u1, v0), c2 = Pt(u1, v1), dd = Pt(u0, v1);
      // carve: eye cells sit slightly deeper
      if (isEye((u0 + u1) / 2, (v0 + v1) / 2) && m.kind !== 'spectacles') {
        const inset = (p) => [c[0] + (p[0] - c[0]) * 0.965, c[1] + (p[1] - c[1]) * 0.985, c[2] + (p[2] - c[2]) * 0.965];
        const A = inset(a), B = inset(b), C2 = inset(c2), D = inset(dd);
        k.tri(A, B, C2, cc); k.tri(A, C2, D, cc);
        k.tri(a, b, B, shade(cc, 1.6)); k.tri(a, B, A, shade(cc, 1.6)); // lower lip of the slit
        k.tri(dd, D, C2, base); k.tri(dd, C2, c2, base);                 // upper carved edge
        continue;
      }
      k.tri(a, b, c2, cc); k.tri(a, c2, dd, cc);
    }
  }
  // mouth line for some masks
  if (m.kind === 'golden' || m.kind === 'opera' || m.kind === 'porcelain') {
    const y = c[1] - R[1] * 0.5, z = c[2] + R[2] * 0.93;
    k.strip([-0.028, y + (m.kind === 'golden' ? 0.004 : 0), z], [0.028, y + (m.kind === 'golden' ? 0.004 : 0), z], 0.006, 0.008, [0, 0, 1], dark);
  }
  if (m.kind === 'spectacles') {
    // round lenses with dark rims + bridge
    for (const sx of [1, -1]) {
      const cx = sx * 0.04, cy = c[1] + 0.004, cz = c[2] + R[2] * 1.02;
      const n = 8, rr = 0.026;
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
        const p0 = [cx + Math.cos(a0) * rr, cy + Math.sin(a0) * rr, cz - Math.abs(Math.cos(a0)) * 0.006 * (Math.cos(a0) * sx > 0 ? 1 : 0)];
        const p1 = [cx + Math.cos(a1) * rr, cy + Math.sin(a1) * rr, cz - Math.abs(Math.cos(a1)) * 0.006 * (Math.cos(a1) * sx > 0 ? 1 : 0)];
        k.strip(p0, p1, 0.007, 0.006, [0, 0, 1], dark);
        k.tri([cx, cy, cz - 0.002], [p0[0], p0[1], p0[2] - 0.002], [p1[0], p1[1], p1[2] - 0.002], col(0xa9b8bf));
      }
      k.strip([sx * 0.066, cy, cz - 0.006], [sx * 0.086, cy + 0.004, c[2] - 0.01], 0.006, 0.006, [0, 1, 0], dark);
      // narrow painted eyes behind the lenses
      k.strip([cx - 0.012, cy - 0.002, cz - 0.004], [cx + 0.012, cy + 0.001 * sx, cz - 0.004], 0.006, 0.004, [0, 0, 1], dark);
    }
    k.strip([0.015, c[1] + 0.008, c[2] + R[2] * 1.04], [-0.015, c[1] + 0.008, c[2] + R[2] * 1.04], 0.006, 0.006, [0, 1, 0], dark);
  }
  if (m.kind === 'golden') {
    // engraved crown line
    k.strip([-0.06, c[1] + R[1] * 0.62, c[2] + R[2] * 0.82], [0.06, c[1] + R[1] * 0.62, c[2] + R[2] * 0.82], 0.008, 0.008, [0, 0.4, 1], shade(P.mask, 0.7));
  }
}

// ------------------------------------------------------------------------------------------------ public API

/**
 * Create a fighter model. Returns { root, skeleton, mesh, look, accent, cloth, setTint(color, amount),
 * flash(color, amount, seconds), setVisible(b), dispose() }. `skeleton` is the rig skeleton
 * ({ root, body, joints, bones }) plus `skin` (the THREE.Skeleton) and `cloth` bones.
 */
export function createFighterModel(look = {}) {
  const d = resolveLook(look);
  let entry = GEO_CACHE.get(d.key);
  if (!entry) { entry = { ...buildGeometry(d), refs: 0 }; GEO_CACHE.set(d.key, entry); }
  entry.refs++;

  const skel = createSkeleton();
  skel.body.scale.setScalar(d.shape.scale || 1);
  const clothBones = {};
  const extra = [];
  for (const name of CLOTH_BONES) {
    const b = new THREE.Bone();
    b.name = name;
    clothBones[name] = b;
    extra.push(b);
  }
  // default parenting / offsets; per-look offsets from the geometry build
  for (const name of CLOTH_BONES) {
    const b = clothBones[name];
    const def = entry.cloth.find((c) => c.bone === name);
    const parent = /2$/.test(name) ? clothBones[name.slice(0, -1) + '1'] : skel.joints.hips;
    parent.add(b);
    if (def) b.position.fromArray(def.offset);
  }
  const bones = [...skel.bones, ...extra];
  const skin = new THREE.Skeleton(bones, bones.map(() => new THREE.Matrix4()));
  const matBody = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.86, metalness: 0 });
  const metal = !!d.mask.metal;
  const matMask = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: metal ? 0.32 : 0.42, metalness: metal ? 0.45 : 0 });
  const mesh = new THREE.SkinnedMesh(entry.geo, [matBody, matMask]);
  mesh.name = 'fighterMesh';
  mesh.bind(skin, new THREE.Matrix4());
  mesh.castShadow = true;
  mesh.receiveShadow = false;
  // generous fixed bounds (bone-space geometry): never recomputed per frame
  mesh.boundingSphere = new THREE.Sphere(new THREE.Vector3(0, 1.0, 0), 2.6);
  skel.root.add(mesh);
  skel.skin = skin;
  skel.cloth = clothBones;

  const accent = new THREE.Color(d.pal.accent);
  const mats = [matBody, matMask];
  const _tc = new THREE.Color();
  const model = {
    root: skel.root,
    skeleton: skel,
    mesh,
    look: { ...look, preset: d.preset },
    desc: d,
    accent,
    cloth: entry.cloth,
    materials: mats,
    _flash: { t: 0, dur: 0, amount: 0, color: new THREE.Color(1, 1, 1) },
    /** Hit flash: emissive tint (amount 0 clears). */
    setTint(color, amount = 0.6) {
      if (!amount || amount <= 0) { for (const m of mats) m.emissive.setRGB(0, 0, 0); return; }
      _tc.set(color ?? 0xffffff).multiplyScalar(amount);
      for (const m of mats) m.emissive.copy(_tc);
    },
    /** Tint that decays to 0 over `seconds` (advanced by the Animator at sim rate). */
    flash(color = 0xffffff, amount = 0.7, seconds = 0.12) {
      const f = model._flash;
      f.color.set(color); f.amount = amount; f.dur = Math.max(0.01, seconds); f.t = f.dur;
      model.setTint(f.color, amount);
    },
    setVisible(b) { skel.root.visible = !!b; },
    dispose() {
      if (skel.root.parent) skel.root.parent.remove(skel.root);
      for (const m of mats) m.dispose();
      skin.dispose();
      entry.refs--;
      if (entry.refs <= 0) { entry.geo.dispose(); GEO_CACHE.delete(d.key); }
    },
  };
  return model;
}
