// Block registry. Owned by core (ids are a shared contract - never renumber; append new blocks at the end).
//
// Fields:
//   id, key (UPPER_SNAKE), name (display)
//   solid        collides with entities
//   opaque       fully hides neighbouring faces (face culling). opaque = solid cube that is not transparent/cutout
//   transparent  rendered in the blended pass (water, glass)
//   cutout       rendered with alpha-test (leaves, plants)
//   liquid       water
//   shape        'cube' | 'cross' (X-shaped billboard plant)
//   emissive     glows at night (rendered unlit / boosted by sky.nightFactor)
//   hardness     seconds to break by hand. Infinity = unbreakable. 0 = instant
//   tool         'pickaxe' | 'axe' | 'shovel' | null - matching tool breaks 5x faster
//   color        0xRRGGBB average colour (minimap, particles, fallback texture)
//   tex          { top, side, bottom } texture names in the procedural atlas (world/textures.js)
//   value        cash reward ($) granted when mined by the player (ores)
//   explosive    TNT: primes when shot / hit by explosion
//   blast        blast resistance: explosion removes blocks where blast <= explosion power (default 1)
//   placeable    appears in the creative palette / can be held as an item
//   drops        block id given to inventory when mined (default: itself; 0 = nothing)

export const BLOCKS = [];
export const B = {};

function def(key, name, props) {
  const id = BLOCKS.length;
  const tex = props.tex || key.toLowerCase();
  const d = {
    id, key, name,
    solid: true, transparent: false, cutout: false, liquid: false, shape: 'cube', emissive: false,
    hardness: 1, tool: null, color: 0x888888, value: 0, explosive: false, blast: 1, placeable: true, drops: id,
    ...props,
    tex: typeof tex === 'string' ? { top: tex, side: tex, bottom: tex } : { top: tex.top || tex.side, side: tex.side, bottom: tex.bottom || tex.side },
  };
  d.opaque = d.solid && !d.transparent && !d.cutout && d.shape === 'cube';
  BLOCKS.push(d);
  B[key] = id;
  return id;
}

def('AIR', 'Air', { solid: false, placeable: false, hardness: 0, color: 0x000000, drops: 0, tex: 'none' });
def('BEDROCK', 'Bedrock', { hardness: Infinity, blast: Infinity, color: 0x333333, placeable: false });
def('STONE', 'Stone', { hardness: 4, tool: 'pickaxe', color: 0x7d7d7d, drops: 11 /* cobblestone */, blast: 2 });
def('DIRT', 'Dirt', { hardness: 0.7, tool: 'shovel', color: 0x86603c });
def('GRASS', 'Grass', { hardness: 0.8, tool: 'shovel', color: 0x5d9b3a, tex: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, drops: 3 });
def('SAND', 'Sand', { hardness: 0.6, tool: 'shovel', color: 0xdbcf8f });
def('WATER', 'Water', { solid: false, transparent: true, liquid: true, hardness: Infinity, blast: Infinity, color: 0x2f6fd0, placeable: false, drops: 0 });
def('GRAVEL', 'Gravel', { hardness: 0.7, tool: 'shovel', color: 0x857f7c });
def('LOG', 'Wood Log', { hardness: 2, tool: 'axe', color: 0x6b5233, tex: { top: 'log_top', side: 'log_side' } });
def('LEAVES', 'Leaves', { cutout: true, hardness: 0.3, color: 0x3f7d2a, drops: 0 });
def('PLANKS', 'Planks', { hardness: 2, tool: 'axe', color: 0xa8854e });
def('COBBLESTONE', 'Cobblestone', { hardness: 4, tool: 'pickaxe', color: 0x727272, blast: 2 });
def('BRICK', 'Brick', { hardness: 4, tool: 'pickaxe', color: 0x9b4a3a, blast: 2 });
def('CONCRETE', 'Concrete', { hardness: 4, tool: 'pickaxe', color: 0xb9b9b4, blast: 2 });
def('ASPHALT', 'Asphalt', { hardness: 3, tool: 'pickaxe', color: 0x3a3a3d, blast: 1.5 });
def('ROAD_LINE_WHITE', 'White Road Paint', { hardness: 3, tool: 'pickaxe', color: 0xe8e8e8, tex: { top: 'road_line_white', side: 'asphalt', bottom: 'asphalt' }, blast: 1.5 });
def('ROAD_LINE_YELLOW', 'Yellow Road Paint', { hardness: 3, tool: 'pickaxe', color: 0xe8c22a, tex: { top: 'road_line_yellow', side: 'asphalt', bottom: 'asphalt' }, blast: 1.5 });
def('SIDEWALK', 'Sidewalk', { hardness: 3, tool: 'pickaxe', color: 0xa9a59c, blast: 1.5 });
def('GLASS', 'Glass', { transparent: true, hardness: 0.3, color: 0xcfe8f0, drops: 0, blast: 0.3 });
def('WINDOW', 'Window', { hardness: 0.5, color: 0x2c4a63, drops: 0, blast: 0.3 });
def('WINDOW_LIT', 'Lit Window', { emissive: true, hardness: 0.5, color: 0xf3d58a, drops: 0, blast: 0.3 });
def('METAL', 'Metal', { hardness: 5, tool: 'pickaxe', color: 0x9aa3a8, blast: 3 });
def('ROOF', 'Roof Tar', { hardness: 2, tool: 'pickaxe', color: 0x46464a });
def('CONCRETE_DARK', 'Dark Concrete', { hardness: 4, tool: 'pickaxe', color: 0x5c5d60, blast: 2 });
def('TILE_WHITE', 'White Tile', { hardness: 3, tool: 'pickaxe', color: 0xe6e6e1 });
def('LAMP', 'Lamp', { emissive: true, hardness: 0.5, color: 0xfff1b8 });
def('SNOW', 'Snow', { hardness: 0.5, tool: 'shovel', color: 0xf3f6f8 });
def('TNT', 'TNT', { explosive: true, hardness: 0.2, color: 0xc0392b, tex: { top: 'tnt_top', side: 'tnt_side', bottom: 'tnt_bottom' }, blast: 0 });
def('WOOL_RED', 'Red Wool', { hardness: 1, color: 0xb02e26 });
def('WOOL_BLUE', 'Blue Wool', { hardness: 1, color: 0x3c44aa });
def('WOOL_YELLOW', 'Yellow Wool', { hardness: 1, color: 0xfed83d });
def('WOOL_GREEN', 'Green Wool', { hardness: 1, color: 0x5e7c16 });
def('WOOL_WHITE', 'White Wool', { hardness: 1, color: 0xe9ecec });
def('WOOL_BLACK', 'Black Wool', { hardness: 1, color: 0x1d1d21 });
def('WOOL_ORANGE', 'Orange Wool', { hardness: 1, color: 0xf9801d });
def('WOOL_PURPLE', 'Purple Wool', { hardness: 1, color: 0x8932b8 });
def('MARBLE', 'Marble', { hardness: 4, tool: 'pickaxe', color: 0xe8e4dc, blast: 2 });
def('HAZARD', 'Hazard Stripes', { hardness: 3, tool: 'pickaxe', color: 0xd9b026 });
def('CRATE', 'Crate', { hardness: 1.5, tool: 'axe', color: 0x9c7442 });
def('TALL_GRASS', 'Tall Grass', { solid: false, cutout: true, shape: 'cross', hardness: 0, color: 0x6aa84f, drops: 0, blast: 0 });
def('FLOWER_RED', 'Red Flower', { solid: false, cutout: true, shape: 'cross', hardness: 0, color: 0xd43a2f, blast: 0 });
def('FLOWER_YELLOW', 'Yellow Flower', { solid: false, cutout: true, shape: 'cross', hardness: 0, color: 0xf2d43a, blast: 0 });
def('COAL_ORE', 'Coal Ore', { hardness: 5, tool: 'pickaxe', color: 0x5a5a5a, value: 25, blast: 2 });
def('IRON_ORE', 'Iron Ore', { hardness: 6, tool: 'pickaxe', color: 0x8c7b6c, value: 60, blast: 2 });
def('GOLD_ORE', 'Gold Ore', { hardness: 6, tool: 'pickaxe', color: 0x9a8a4a, value: 150, blast: 2 });
def('DIAMOND_ORE', 'Diamond Ore', { hardness: 8, tool: 'pickaxe', color: 0x6aa8a8, value: 500, blast: 3 });
def('SANDSTONE', 'Sandstone', { hardness: 3, tool: 'pickaxe', color: 0xd8c98f, tex: { top: 'sandstone_top', side: 'sandstone' } });
def('PLASTER', 'Plaster', { hardness: 2.5, tool: 'pickaxe', color: 0xd9c9a8 });
def('STUCCO_PINK', 'Pink Stucco', { hardness: 2.5, tool: 'pickaxe', color: 0xe3a0a8 });
def('NEON_PINK', 'Pink Neon', { emissive: true, hardness: 0.5, color: 0xff3fb4 });
def('NEON_BLUE', 'Blue Neon', { emissive: true, hardness: 0.5, color: 0x3fd5ff });
def('TERRACOTTA', 'Terracotta', { hardness: 3, tool: 'pickaxe', color: 0xa0583a });
def('STUCCO_TEAL', 'Teal Stucco', { hardness: 2.5, tool: 'pickaxe', color: 0x5fb3a8 });
def('BOOKSHELF', 'Bookshelf', { hardness: 1.5, tool: 'axe', color: 0x7a5a3a, tex: { top: 'planks', side: 'bookshelf' } });
def('HEDGE', 'Hedge', { hardness: 0.4, color: 0x2f6b25 });
def('CARPET_RED', 'Red Carpet', { hardness: 0.5, color: 0x8e2a2a });
def('SOLAR', 'Solar Panel', { hardness: 2, tool: 'pickaxe', color: 0x1e2c4a, tex: { top: 'solar', side: 'metal' } });
def('PALM_LOG', 'Palm Log', { hardness: 2, tool: 'axe', color: 0x9c7d52, tex: { top: 'palm_log_top', side: 'palm_log' } });
def('PALM_LEAVES', 'Palm Leaves', { cutout: true, hardness: 0.3, color: 0x4f9a2e, drops: 0 });

export const BLOCK_COUNT = BLOCKS.length;

export const getBlockDef = (id) => BLOCKS[id] || BLOCKS[0];
export const isSolidId = (id) => !!(BLOCKS[id] && BLOCKS[id].solid);
export const isOpaqueId = (id) => !!(BLOCKS[id] && BLOCKS[id].opaque);
export const blockByKey = (key) => B[key];

/** All texture names referenced by the registry (the atlas must provide each of them). */
export function allTextureNames() {
  const s = new Set();
  for (const d of BLOCKS) { if (d.id === 0) continue; s.add(d.tex.top); s.add(d.tex.side); s.add(d.tex.bottom); }
  return [...s];
}

/** Blocks offered in the creative palette / shops. */
export const PLACEABLE_BLOCKS = BLOCKS.filter((d) => d.placeable && d.id !== 0).map((d) => d.id);

/** Seconds to break `id` given the held tool ('pickaxe'|'axe'|'shovel'|null). Infinity if unbreakable. */
export function breakTime(id, tool) {
  const d = BLOCKS[id];
  if (!d || d.hardness === Infinity) return Infinity;
  let t = d.hardness;
  if (tool && d.tool === tool) t /= 5;
  else if (tool) t /= 1.5; // any tool helps a bit
  return t;
}
