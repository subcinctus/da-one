// Global constants + persisted user settings. Owned by core. Read-only for module agents.

export const GAME_TITLE = 'BLOCK CITY';

// World dimensions (1 block = 1 metre). Block (x,y,z) occupies [x,x+1) x [y,y+1) x [z,z+1).
export const WORLD = {
  SIZE_X: 512,          // blocks along X (0..511)
  SIZE_Z: 512,          // blocks along Z (0..511)
  HEIGHT: 96,           // blocks along Y (0..95)
  CHUNK: 16,            // chunk is CHUNK x HEIGHT x CHUNK; chunks per axis = SIZE / CHUNK = 32
  SEA_LEVEL: 24,        // water fills air cells with y < SEA_LEVEL where terrain is below it (water surface at y = 24)
  CITY_LEVEL: 28,       // standing height (top face of road blocks) of the flat city
  CITY_MIN: 96,         // hint: city occupies roughly [CITY_MIN, CITY_MAX) on both X and Z
  CITY_MAX: 416,
};
export const CHUNKS_X = WORLD.SIZE_X / WORLD.CHUNK;
export const CHUNKS_Z = WORLD.SIZE_Z / WORLD.CHUNK;
/** Index of a voxel inside a chunk data array (Uint8Array of CHUNK*CHUNK*HEIGHT). lx,lz in [0,16), y in [0,96). */
export const voxelIndex = (lx, y, lz) => lx + lz * WORLD.CHUNK + y * WORLD.CHUNK * WORLD.CHUNK;

export const PHYS = {
  GRAVITY: 30,          // m/s^2 (snappy, game-like)
  TERMINAL_VELOCITY: 55,
  WATER_GRAVITY: 4,
  WATER_DRAG: 3,
};

export const DEFAULT_SEED = 1337;

export const DEFAULT_SETTINGS = {
  renderDistance: 6,      // chunks (radius). 4..12
  mouseSensitivity: 1.0,  // multiplier (base = 0.0022 rad / pixel)
  invertY: false,
  fov: 75,
  volume: 0.7,            // master 0..1
  musicVolume: 0.5,       // radio 0..1
  shadows: false,
  showFPS: false,
  autoJump: true,
  pixelRatio: 1.0,        // multiplier applied to min(devicePixelRatio, 1.5)
};

const SETTINGS_KEY = 'blockcity.settings.v1';

export function loadSettings() {
  const s = { ...DEFAULT_SETTINGS };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) Object.assign(s, JSON.parse(raw));
  } catch (e) { /* storage unavailable - use defaults */ }
  return s;
}

export function saveSettings(settings) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch (e) { /* ignore */ }
}
