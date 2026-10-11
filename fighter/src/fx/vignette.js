// Focus vignette: a subtle screen-edge pulse done with ONE DOM overlay (never a post-processing pass): four soft
// linear edge gradients whose overlap darkens the corners. The intensity is baked into precomputed gradient strings
// (STEPS levels), so animating allocates nothing, the element keeps opacity 1 (robust across compositors) and it is
// hidden entirely at rest.
const STEPS = 32;
const tint = (a) => `rgba(6,24,19,${a.toFixed(3)})`;
const edge = (dir, reach, k) => `linear-gradient(${dir}, ${tint(0.55 * k)} 0%, ${tint(0.24 * k)} ${(reach * 0.4).toFixed(1)}%, ${tint(0.06 * k)} ${(reach * 0.72).toFixed(1)}%, ${tint(0)} ${reach}%)`;
const LEVELS = Array.from({ length: STEPS + 1 }, (_, i) => {
  const k = i / STEPS;
  return [edge('to right', 26, k), edge('to left', 26, k), edge('to bottom', 30, k), edge('to top', 30, k)].join(', ');
});

export class Vignette {
  constructor() {
    this.el = null;
    this.v = 0;          // current intensity 0..1
    this.pulse = 0;      // decaying pulse
    this.hold = 0;       // sustained level (slow motion focus)
    this._shown = -1;
  }

  mount() {
    if (this.el || typeof document === 'undefined') return;
    const el = document.createElement('div');
    el.className = 'fx-vignette';
    el.setAttribute('aria-hidden', 'true');
    const s = el.style;
    s.position = 'absolute';
    s.left = s.top = s.right = s.bottom = '0';
    s.pointerEvents = 'none';
    s.display = 'none';
    const root = document.getElementById('ui') || document.body;
    root.insertBefore(el, root.firstChild);   // under the HUD
    this.el = el;
  }

  /** Kick a pulse (0..1). */
  kick(amount = 0.8) { this.pulse = Math.max(this.pulse, amount); }

  /** dt real seconds; sustain = target level while focus slow motion runs. */
  update(dt, sustain) {
    if (!this.el) return;
    this.hold += (sustain - this.hold) * (1 - Math.exp(-dt * (sustain > this.hold ? 14 : 4)));
    this.pulse *= Math.exp(-dt * 5.5);
    if (this.pulse < 0.002) this.pulse = 0;
    const target = Math.min(1, Math.max(this.hold, this.pulse));
    this.v += (target - this.v) * (1 - Math.exp(-dt * 22));
    if (this.v < 0.01 && target < 0.01) this.v = 0;
    const q = Math.round(this.v * STEPS);
    if (q === this._shown) return;
    if (q === 0) this.el.style.display = 'none';
    else {
      if (this._shown <= 0) this.el.style.display = 'block';
      this.el.style.backgroundImage = LEVELS[q];
    }
    this._shown = q;
  }

  get opacity() { return this.v; }
}
