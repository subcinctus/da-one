// Sky (owned by ATMOSPHERE, see ARCHITECTURE.md §Sky): day/night cycle, gradient sky dome, square voxel sun + moon,
// stars, blocky drifting clouds, fog + clear colour, scene lighting (sun/moon DirectionalLight + HemisphereLight,
// optional shadows following the player) and occasional rain with lightning.
//
// Public: time (h), dayLength (s), nightFactor (0 day..1 night), sunDir, moonDir, lightDir, sun, hemi, setTime(h),
//         rain (0..1), weather ('clear'|'rain'), setWeather(kind), lightLevel, fogColor, dayCount, getClock(), isNight.
import * as THREE from 'three';
import { WORLD } from '../core/config.js';
import { BLOCKS } from './blocks.js';
import {
  sunDirection, computeSkyState, makeSkyState, wrapHours, formatClock, POLE, hourAngle,
} from '../fx/sky_math.js';
import { createDome, createSun, createMoon, createStars, placeCelestial, SUN_DISTANCE } from '../fx/sky_parts.js';
import { CloudLayer } from '../fx/sky_clouds.js';
import { Rain } from '../fx/sky_rain.js';

let fogPatched = false;
/** Make three's fog radial (distance) instead of view-depth based so chunk edges stay hidden at screen corners. */
function patchRadialFog() {
  if (fogPatched) return;
  fogPatched = true;
  try {
    THREE.ShaderChunk.fog_vertex = '#ifdef USE_FOG\n\tvFogDepth = length( mvPosition.xyz );\n#endif\n';
  } catch (e) { /* ShaderChunk frozen: keep depth fog */ }
}

const SHADOW_EXTENT = 60;
const SHADOW_MAP = 2048;
const _v = new THREE.Vector3();
const _lx = new THREE.Vector3();
const _ly = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _cloudLook = { top: new THREE.Color(), bottom: new THREE.Color(), fog: new THREE.Color(), opacity: 0.8, fadeNear: 150, fadeFar: 300 };
const UP = new THREE.Vector3(0, 1, 0);

export class Sky {
  constructor(game) {
    this.game = game;
    /** Hours 0..24. */
    this.time = 9.0;
    /** Real seconds for a full 24 h day. */
    this.dayLength = 1200;
    /** Multiplier on the clock speed (0 freezes time). */
    this.timeScale = 1;
    this.dayCount = 0;
    this.nightFactor = 0;
    this.sunDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    this.moonDir = new THREE.Vector3();
    /** Direction toward the current directional light (sun by day, moon by night). */
    this.lightDir = new THREE.Vector3(0.4, 0.8, 0.3).normalize();
    /** 0..1 overall scene brightness (1 = noon). */
    this.lightLevel = 1;
    this.fogColor = new THREE.Color(0xb4d4f3);
    /** Rain amount 0..1 (smoothed) and the current weather target. */
    this.rain = 0;
    this.weather = 'clear';
    this.underwater = false;
    this.state = makeSkyState();
    this.sun = null;
    this.hemi = null;
    this._rainTarget = 0;
    this._weatherTimer = 300 + Math.random() * 240;
    this._lightningTimer = 6;
    this._flash = 0;
    this._flashQueue = [];
    this._covered = false;
    this._coverTimer = 0;
    this._fogNear = 40;
    this._fogFar = 90;
    patchRadialFog();
  }

  init() {
    const game = this.game;
    const scene = game.scene;

    // lights
    this.hemi = new THREE.HemisphereLight(0xdbe9fb, 0x857664, 2.0);
    this.hemi.name = 'skyHemi';
    this.sun = new THREE.DirectionalLight(0xfff3e2, 2.0);
    this.sun.name = 'skySun';
    this.sun.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    const sc = this.sun.shadow.camera;
    sc.left = -SHADOW_EXTENT; sc.right = SHADOW_EXTENT; sc.top = SHADOW_EXTENT; sc.bottom = -SHADOW_EXTENT;
    sc.near = 1; sc.far = 420;
    sc.updateProjectionMatrix();
    this.sun.shadow.bias = -0.00035;
    this.sun.shadow.normalBias = 0.045;
    this.sun.castShadow = !!game.settings.shadows;
    scene.add(this.hemi, this.sun, this.sun.target);

    // fog
    scene.fog = new THREE.Fog(this.fogColor.clone(), 40, 90);

    // sky root follows the camera (snapped right before rendering via the dome's onBeforeRender)
    this.root = new THREE.Group();
    this.root.name = 'skyRoot';
    this.dome = createDome();
    this.stars = createStars(1700, (game.seed || 1) * 7 + 3);
    this.sunMesh = createSun();
    this.moonMesh = createMoon();
    this.root.add(this.dome, this.stars, this.sunMesh, this.moonMesh);
    scene.add(this.root);
    const root = this.root;
    this.dome.onBeforeRender = (renderer, sc2, camera) => {
      root.position.setFromMatrixPosition(camera.matrixWorld);
      root.updateMatrixWorld(true);
    };

    this.clouds = new CloudLayer(game.seed || 1);
    scene.add(this.clouds.group);
    this.rainFx = new Rain(1400);
    scene.add(this.rainFx.mesh);

    game.events?.on?.('settingsChanged', (s) => this._applySettings(s));
    this._applySettings(game.settings);

    // debug helpers
    if (game.debug) {
      game.debug.setTime = (h) => { this.setTime(h); return this.getClock(); };
      game.debug.setWeather = (kind) => { this.setWeather(kind, true); return this.weather; };
      game.debug.skyInfo = () => ({
        time: +this.time.toFixed(3), clock: this.getClock(), nightFactor: +this.nightFactor.toFixed(3),
        sunDir: this.sunDir.toArray().map((v) => +v.toFixed(3)), rain: +this.rain.toFixed(2), weather: this.weather,
        sunI: +this.sun.intensity.toFixed(3), hemiI: +this.hemi.intensity.toFixed(3), lightLevel: +this.lightLevel.toFixed(3),
        fog: [+this._fogNear.toFixed(1), +this._fogFar.toFixed(1)], fogColor: '#' + this.fogColor.getHexString(),
        cloudQuads: this.clouds.quads, shadows: this.sun.castShadow,
      });
      game.debug.freezeTime = (b = true) => { this.timeScale = b ? 0 : 1; return this.timeScale; };
      game.debug.lightning = () => { this._strike(); return true; };
    }
    this._apply(0);
  }

  _applySettings(s) {
    if (!s || !this.sun) return;
    const rd = Math.max(2, Math.min(16, s.renderDistance || 6));
    // fog ends a little inside the loaded radius so chunk edges are never visible
    this._fogFar = rd * 16 - 6;
    this._fogNear = Math.max(12, this._fogFar * 0.42);
    const wantShadows = !!s.shadows;
    if (this.sun.castShadow !== wantShadows) {
      this.sun.castShadow = wantShadows;
      if (this.sun.shadow.map) { this.sun.shadow.map.dispose(); this.sun.shadow.map = null; }
    }
    this._apply(0);
  }

  /** Jump to a time of day (hours, wraps into 0..24) and refresh visuals immediately. */
  setTime(h) {
    const v = Number(h);
    if (!Number.isFinite(v)) return;
    const next = wrapHours(v);
    if (next < this.time - 1e-6) this.dayCount++; // e.g. sleeping until morning = the next day (moon phase)
    this.time = next;
    this._apply(0);
  }

  /** 'clear' | 'rain' | 'storm'. instant = skip the fade. */
  setWeather(kind, instant = false) {
    this.weather = kind === 'rain' || kind === 'storm' ? kind : 'clear';
    this._rainTarget = this.weather === 'storm' ? 1 : this.weather === 'rain' ? 0.75 : 0;
    this._weatherTimer = this.weather === 'clear' ? 300 + Math.random() * 360 : 90 + Math.random() * 150;
    if (instant) this.rain = this._rainTarget;
    this._apply(0);
  }

  get isNight() { return this.nightFactor > 0.5; }

  /** "HH:MM" clock string. */
  getClock() { return formatClock(this.time); }

  update(dt) {
    this.time += dt * this.timeScale * 24 / Math.max(1, this.dayLength);
    if (this.time >= 24) { this.time -= 24; this.dayCount++; }
    if (this.time < 0) this.time += 24;
    this._updateWeather(dt);
    this._apply(dt);
  }

  _updateWeather(dt) {
    this._weatherTimer -= dt;
    if (this._weatherTimer <= 0) {
      if (this.weather === 'clear') {
        const r = Math.random();
        if (r < 0.4) this.setWeather(Math.random() < 0.3 ? 'storm' : 'rain');
        else this._weatherTimer = 240 + Math.random() * 300;
      } else {
        this.setWeather('clear');
      }
    }
    // smooth rain fade (~25 s)
    const k = 1 - Math.exp(-dt / 8);
    this.rain += (this._rainTarget - this.rain) * k;
    if (Math.abs(this.rain - this._rainTarget) < 0.002) this.rain = this._rainTarget;

    // under cover? (roof/tunnel over the camera) -> hide rain streaks
    this._coverTimer -= dt;
    if (this._coverTimer <= 0 && this.rain > 0.01) {
      this._coverTimer = 0.35;
      this._covered = this._checkCover();
    }

    // lightning in heavy rain
    if (this.rain > 0.7 && this.weather === 'storm') {
      this._lightningTimer -= dt;
      if (this._lightningTimer <= 0) { this._lightningTimer = 7 + Math.random() * 18; this._strike(); }
    }
    // flash envelope (a strike = 2-3 quick flickers)
    if (this._flashQueue.length) {
      for (let i = this._flashQueue.length - 1; i >= 0; i--) {
        const f = this._flashQueue[i];
        f.t -= dt;
        if (f.t <= 0) { this._flash = Math.max(this._flash, f.v); this._flashQueue.splice(i, 1); }
      }
    }
    this._flash = Math.max(0, this._flash - dt * 6);
  }

  _strike() {
    this._flashQueue.push({ t: 0, v: 0.9 }, { t: 0.09, v: 0.5 }, { t: 0.2 + Math.random() * 0.1, v: 1.0 });
    const delay = 0.6 + Math.random() * 2.4;
    const audio = this.game.audio;
    setTimeout(() => { try { audio?.play?.('thunder', { volume: 1.2 - delay * 0.25 }); } catch (e) { /* ignore */ } }, delay * 1000);
  }

  _checkCover() {
    const w = this.game.world, c = this.game.camera;
    if (!w || !w.getBlock) return false;
    const x = Math.floor(c.position.x), z = Math.floor(c.position.z);
    const y0 = Math.floor(c.position.y) + 1;
    for (let y = y0; y < Math.min(WORLD.HEIGHT, y0 + 40); y++) {
      const id = w.getBlock(x, y, z);
      if (id && BLOCKS[id] && (BLOCKS[id].solid || BLOCKS[id].liquid)) return true;
    }
    return false;
  }

  /** Recompute every sky visual from time/weather. dt = simulated seconds since last call (0 = refresh only). */
  _apply(dt) {
    if (!this.sun) return;
    const game = this.game;
    const st = computeSkyState(sunDirection(this.time, this.sunDir).y, this.rain, this.state);
    this.moonDir.copy(this.sunDir).negate();
    this.nightFactor = st.nightFactor;
    this.lightLevel = st.lightLevel;

    // underwater check (camera inside a liquid block)
    const cam = game.camera;
    let under = false;
    const w = game.world;
    if (w && w.getBlock) {
      try {
        const id = w.getBlock(Math.floor(cam.position.x), Math.floor(cam.position.y), Math.floor(cam.position.z));
        under = !!(BLOCKS[id] && BLOCKS[id].liquid);
      } catch (e) { under = false; }
    }
    this.underwater = under;

    // dome
    const u = this.dome.material.uniforms;
    u.uZenith.value.copy(st.zen);
    u.uHorizon.value.copy(st.hor);
    u.uGround.value.copy(st.ground);
    u.uGlow.value.copy(st.glow);
    u.uAnti.value.copy(st.anti);
    u.uSunDir.value.copy(this.sunDir);
    u.uMoonDir.value.copy(this.moonDir);
    u.uGlowAmt.value = st.sunGlowAmt;
    u.uAntiAmt.value = st.antiAmt;
    u.uMoonAmt.value = st.moonVisible;
    u.uFlash.value = this._flash * 1.1;
    u.uUnder.value = under ? 1 : 0;

    // sun + moon quads (edges aligned with the sky's rotation axis)
    placeCelestial(this.sunMesh, this.sunDir, POLE, SUN_DISTANCE);
    placeCelestial(this.moonMesh, this.moonDir, POLE, SUN_DISTANCE);
    this.sunMesh.material.color.copy(st.sunCol).lerp(_white, 0.35);
    this.sunMesh.material.opacity = st.sunVisible;
    this.sunMesh.visible = st.sunVisible > 0.005 && !under;
    this.moonMesh.material.opacity = st.moonVisible * 0.95;
    this.moonMesh.visible = st.moonVisible > 0.005 && !under;
    // moon phase advances once per in-game day (8-day cycle)
    const phase = ((this.dayCount % 8) + 8) % 8;
    this.moonMesh.material.map.offset.x = phase / 8;

    // stars rotate with the sky around the celestial pole
    _q.setFromAxisAngle(POLE, -hourAngle(this.time));
    this.stars.quaternion.copy(_q);
    const su = this.stars.material.uniforms;
    su.uAmount.value = under ? 0 : st.starAmt;
    su.uTime.value = (su.uTime.value + dt) % 1000;
    su.uPixelRatio.value = game.renderer?.getPixelRatio ? game.renderer.getPixelRatio() : 1;
    this.stars.visible = st.starAmt > 0.003 && !under;

    // lights: one directional (sun by day, moon by night) + hemisphere
    const useSun = this.sunDir.y >= 0;
    this.lightDir.copy(useSun ? this.sunDir : this.moonDir);
    const flash = this._flash;
    if (useSun) {
      this.sun.color.copy(st.sunCol);
      this.sun.intensity = st.sunIntensity;
    } else {
      this.sun.color.setRGB(0.42, 0.52, 0.95);
      this.sun.intensity = st.moonIntensity;
    }
    this.hemi.color.copy(st.hemiSky);
    this.hemi.groundColor.copy(st.hemiGnd);
    this.hemi.intensity = st.hemiIntensity + flash * 4.5;

    // shadow camera follows the player (texel-snapped to avoid shimmering)
    this._placeLight();

    // fog + clear colour
    const fog = game.scene.fog;
    if (under) {
      this.fogColor.setRGB(0.012, 0.06, 0.16).multiplyScalar(0.4 + 0.6 * st.lightLevel);
      if (fog) { fog.near = 0.5; fog.far = 22; }
    } else {
      this.fogColor.copy(st.fog);
      if (flash > 0) this.fogColor.lerp(_flashCol, flash * 0.6);
      if (fog) { fog.far = this._fogFar * st.fogScale; fog.near = Math.min(fog.far - 4, this._fogNear * st.fogScale); }
    }
    if (fog) fog.color.copy(this.fogColor);
    u.uUnderColor.value.copy(this.fogColor);
    game.renderer?.setClearColor?.(this.fogColor);

    // clouds
    _cloudLook.top.copy(st.cloud);
    if (flash > 0) { _cloudLook.top.lerp(_flashCol, flash * 0.8); _cloudLook.bottom.lerp(_flashCol, flash * 0.6); }
    _cloudLook.bottom.copy(st.cloudShade);
    _cloudLook.fog.copy(st.hor);
    _cloudLook.opacity = st.cloudOpacity;
    const far = Math.max(220, this._fogFar * 2.6);
    _cloudLook.fadeFar = far;
    _cloudLook.fadeNear = far * 0.45;
    this.clouds.coverage = 0.3 + this.rain * 0.55;
    this.clouds.update(dt, cam.position, _cloudLook);
    this.clouds.group.visible = !under;

    // rain
    const rainVis = this._covered || under ? 0 : this.rain;
    this.rainFx.update(dt, cam.position, rainVis, st.lightLevel);
  }

  _placeLight() {
    const p = this.game.player && this.game.player.position ? this.game.player.position : this.game.camera.position;
    const d = this.lightDir;
    // light-space basis matching DirectionalLightShadow's lookAt (up = +Y)
    _lx.crossVectors(UP, d);
    if (_lx.lengthSq() < 1e-6) _lx.set(1, 0, 0);
    _lx.normalize();
    _ly.crossVectors(d, _lx).normalize();
    const texel = (SHADOW_EXTENT * 2) / SHADOW_MAP;
    const px = Math.round(p.dot(_lx) / texel) * texel;
    const py = Math.round(p.dot(_ly) / texel) * texel;
    const pz = p.dot(d);
    _v.copy(_lx).multiplyScalar(px).addScaledVector(_ly, py).addScaledVector(d, pz);
    this.sun.target.position.copy(_v);
    this.sun.position.copy(_v).addScaledVector(d, 200);
    this.sun.target.updateMatrixWorld();
    this.sun.updateMatrixWorld();
  }
}

const _white = new THREE.Color(1, 1, 1);
const _flashCol = new THREE.Color(0.75, 0.8, 1.0);
