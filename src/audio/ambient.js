// Ambient soundscape (owned by ATMOSPHERE): a quiet bed that follows where the camera is.
//   city: low traffic hum + occasional distant horns / sirens     country: wind, birds by day, crickets by night
//   coast: sea swell                                               weather: rain loop (from sky.rain), altitude wind
import { WORLD } from '../core/config.js';
import { LOOPS } from './engines.js';

const NATURE_WORDS = /(country|forest|wood|mountain|hill|farm|field|wild|mine|quarry|rural|lake|valley|meadow|beach|coast|island|park|camp|ocean)/i;
/** District id -> [city hum, nature (birds/crickets/wind)] mix. Unknown ids fall back to keywords + the city box. */
const DISTRICT_MIX = {
  downtown: [1, 0], midtown: [1, 0], oldtown: [0.9, 0.15], residential: [0.55, 0.55], bayfront: [0.8, 0.15],
  market: [0.9, 0.05], industrial: [1, 0], port: [0.85, 0], park: [0.35, 1], beach: [0.2, 0.6],
  mountains: [0, 1], hills: [0, 1], forest: [0, 1], lake: [0, 1], farm: [0.05, 1], ocean: [0, 0.35], countryside: [0, 1],
};
const R = (a, b) => a + Math.random() * (b - a);

export class Ambient {
  constructor(audio) {
    this.audio = audio;
    this.kit = null;
    this.w = { city: 0, nature: 0, sea: 0, wind: 0.2, rain: 0, day: 1 };
    this._timer = 0;
    this._birdT = 2;
    this._cricketT = 1;
    this._eventT = 12;
  }

  /** Build the continuous layers on the ambient bus. */
  build(kit, dest) {
    this.kit = kit;
    const ctx = kit.ctx, t = ctx.currentTime;
    this.dest = dest;
    // city hum: low rumble + a soft mid "traffic wash" that slowly breathes
    this.city = kit.gain(0, dest);
    kit.noise(t, Infinity, kit.filter('lowpass', 260, 0.7, kit.gain(0.9, this.city)), 'brown');
    const wash = kit.filter('bandpass', 750, 0.45, kit.gain(0.22, this.city));
    kit.noise(t, Infinity, wash, 'pink');
    kit.osc('sine', 0.05, t, Infinity, kit.gain(250, wash.frequency));
    // sea: brown noise with a slow swell
    this.sea = kit.gain(0, dest);
    const seaAm = kit.gain(0.55, this.sea);
    kit.noise(t, Infinity, kit.filter('lowpass', 650, 0.6, seaAm), 'brown');
    kit.noise(t, Infinity, kit.filter('bandpass', 1600, 0.5, kit.gain(0.12, seaAm)), 'pink');
    kit.osc('sine', 0.085, t, Infinity, kit.gain(0.42, seaAm.gain));
    // wind + rain loops
    this.wind = LOOPS.wind(kit, dest);
    this.rain = LOOPS.rain(kit, dest);
  }

  _weights(game) {
    const cam = game.camera.position;
    const plan = game.generator && game.generator.plan;
    const inBox = cam.x > WORLD.CITY_MIN && cam.x < WORLD.CITY_MAX && cam.z > WORLD.CITY_MIN && cam.z < WORLD.CITY_MAX;
    let city = inBox ? 1 : 0, natureMix = inBox ? 0 : 1;
    if (plan && typeof plan.districtAt === 'function') {
      try {
        const d = plan.districtAt(cam.x, cam.z);
        const mix = d && DISTRICT_MIX[d.id];
        if (mix) { city = mix[0]; natureMix = mix[1]; }
        else if (d && NATURE_WORDS.test(d.id || '')) { city = 0; natureMix = 1; }
      } catch (e) { /* plan stub */ }
    }
    // sea: sample water around the camera
    let sea = 0;
    if (plan && typeof plan.isWater === 'function') {
      let n = 0;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        try { if (plan.isWater(cam.x + Math.cos(a) * 28, cam.z + Math.sin(a) * 28)) n++; } catch (e) { /* ignore */ }
      }
      sea = n / 8;
    }
    const sky = game.sky;
    const night = sky && typeof sky.nightFactor === 'number' ? sky.nightFactor : 0;
    const rain = sky && typeof sky.rain === 'number' ? sky.rain : 0;
    const alt = Math.max(0, Math.min(1, (cam.y - (WORLD.CITY_LEVEL + 22)) / 55));
    const under = !!(sky && sky.underwater);
    const indoorRain = sky && sky._covered ? 0.45 : 1;
    const w = this.w;
    w.city = city * (1 - alt * 0.6) * (under ? 0.1 : 1);
    w.nature = natureMix * (under ? 0 : 1);
    w.sea = sea * (under ? 0.2 : 1);
    w.wind = Math.min(1, 0.12 + w.nature * 0.25 + alt * 0.75 + rain * 0.35) * (under ? 0 : 1);
    w.rain = rain * indoorRain * (under ? 0.15 : 1);
    w.day = 1 - night;
    w.night = night;
    w.alt = alt;
  }

  update(dt, game) {
    if (!this.kit) return;
    const ctx = this.kit.ctx, t = ctx.currentTime;
    this._timer -= dt;
    if (this._timer <= 0) {
      this._timer = 0.5;
      this._weights(game);
      const w = this.w;
      this.city.gain.setTargetAtTime(0.11 * w.city * (0.55 + 0.45 * w.day), t, 1.2);
      this.sea.gain.setTargetAtTime(0.2 * w.sea, t, 1.2);
      this.wind.set(w.wind, 0.85 + w.alt * 0.5, t);
      this.rain.set(w.rain * 1.2, 1, t);
    }
    const w = this.w;
    // birds (day, countryside / parks)
    this._birdT -= dt;
    if (this._birdT <= 0) {
      this._birdT = R(1.2, 5.5);
      const amt = w.nature * w.day * (1 - w.rain);
      if (amt > 0.15 && Math.random() < amt) this._bird(t + 0.05, amt);
    }
    // crickets (night, countryside)
    this._cricketT -= dt;
    if (this._cricketT <= 0) {
      this._cricketT = R(0.6, 1.6);
      const amt = w.nature * w.night * (1 - w.rain);
      if (amt > 0.2) this._cricket(t + 0.05, amt);
    }
    // distant city life: horns, a far-off siren
    this._eventT -= dt;
    if (this._eventT <= 0) {
      this._eventT = R(14, 38);
      if (w.city > 0.5 && game.running) this._cityEvent(game);
    }
  }

  _bird(t, amt) {
    const k = this.kit;
    const pan = this.kit.ctx.createStereoPanner();
    pan.pan.value = R(-0.8, 0.8);
    const g = k.gain(0.04 * amt * R(0.5, 1), pan);
    pan.connect(this.dest);
    const kind = Math.floor(Math.random() * 3);
    let end = t;
    if (kind === 0) {
      // tweet-tweet
      const n = 2 + Math.floor(Math.random() * 3), f = R(3000, 4200);
      for (let i = 0; i < n; i++) {
        const tt = t + i * R(0.11, 0.15);
        const o = k.osc('sine', f, tt, 0.08, g);
        o.frequency.setValueAtTime(f, tt);
        o.frequency.exponentialRampToValueAtTime(f * 1.35, tt + 0.06);
        end = tt + 0.1;
      }
      k.perc(g.gain, t, 0.04 * amt, end - t + 0.05, 0.005);
    } else if (kind === 1) {
      // trill
      const f = R(4200, 5400);
      const o = k.osc('sine', f, t, 0.5, g);
      for (let i = 0; i < 10; i++) o.frequency.setValueAtTime(i % 2 ? f * 0.88 : f, t + i * 0.045);
      k.env(g.gain, t, 0.035 * amt, 0.02, 0.4, 0.06);
      end = t + 0.5;
    } else {
      // warble
      const f = R(2300, 3000);
      const o = k.osc('sine', f, t, 0.45, g);
      k.osc('sine', R(22, 34), t, 0.45, k.gain(R(250, 500), o.frequency));
      k.env(g.gain, t, 0.03 * amt, 0.04, 0.3, 0.1);
      end = t + 0.45;
    }
    setTimeout(() => { try { pan.disconnect(); } catch (e) { /* gone */ } }, (end - this.kit.ctx.currentTime + 0.5) * 1000);
  }

  _cricket(t, amt) {
    const k = this.kit;
    const pan = k.ctx.createStereoPanner();
    pan.pan.value = R(-0.7, 0.7);
    pan.connect(this.dest);
    const g = k.gain(0, pan);
    const f = R(4300, 4900);
    k.osc('sine', f, t, 0.5, g);
    const am = k.gain(0.5, g.gain);
    k.osc('square', R(26, 32), t, 0.5, am);
    for (let i = 0; i < 3; i++) {
      const tt = t + i * 0.16;
      g.gain.setValueAtTime(0, tt);
      g.gain.linearRampToValueAtTime(0.012 * amt, tt + 0.02);
      g.gain.linearRampToValueAtTime(0, tt + 0.11);
    }
    setTimeout(() => { try { pan.disconnect(); } catch (e) { /* gone */ } }, 1200);
  }

  _cityEvent(game) {
    const a = this.audio;
    const cam = game.camera.position;
    const ang = Math.random() * Math.PI * 2, d = R(55, 75);
    const pos = { x: cam.x + Math.cos(ang) * d, y: cam.y, z: cam.z + Math.sin(ang) * d };
    const r = Math.random();
    if (r < 0.65) {
      a.play('horn', { position: pos, volume: R(0.5, 0.9), duration: R(0.15, 0.6), pitch: R(0.85, 1.15) });
      if (Math.random() < 0.4) setTimeout(() => a.play('horn', { position: pos, volume: 0.6, duration: R(0.1, 0.3) }), R(250, 500));
    } else if (r < 0.85 && !(game.police && game.police.wanted > 0)) {
      // a far-away siren passing by
      const s = a.siren();
      const p = { x: pos.x, y: pos.y, z: pos.z };
      s.setPosition(p);
      s.setVolume?.(0.5);
      let life = 0;
      const vx = Math.cos(ang + Math.PI / 2) * 12, vz = Math.sin(ang + Math.PI / 2) * 12;
      const iv = setInterval(() => {
        life += 0.1; p.x += vx * 0.1; p.z += vz * 0.1;
        s.setPosition(p);
        if (life > 7) { clearInterval(iv); s.stop(); }
      }, 100);
    } else {
      a.play('car_alarm', { position: pos, volume: 0.5, duration: R(1.5, 3) });
    }
  }
}
