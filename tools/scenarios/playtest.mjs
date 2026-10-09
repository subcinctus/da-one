// Full integration play-test: exercises every subsystem through the public contract and screenshots each step.
// Usage: node tools/smoke.mjs --tag playtest --scenario tools/scenarios/playtest.mjs --seconds 1
// Each step is isolated (a failing step is recorded, the run continues). Returns a step-by-step result table.
export default async ({ page, game, keys, wait, shot, log }) => {
  const results = [];
  const step = async (name, fn) => {
    const t0 = Date.now();
    try {
      const r = await fn();
      const ok = r !== false && !(r && typeof r === 'object' && r.ok === false);
      results.push({ step: name, ok, info: r === undefined ? null : r, ms: Date.now() - t0 });
    } catch (e) {
      results.push({ step: name, ok: false, error: String(e && e.message ? e.message : e).slice(0, 300), ms: Date.now() - t0 });
    }
  };
  const freezeCam = () => game((g) => { g.__camUpdate = g.cameraRig.update; g.cameraRig.update = () => {}; });
  const thawCam = () => game((g) => { if (g.__camUpdate) g.cameraRig.update = g.__camUpdate; });

  await step('boot-state', () => game((g) => ({ state: g.state, running: g.running, plan: !!(g.generator && g.generator.plan), nodes: g.generator?.plan?.nodes?.length, pois: g.generator?.plan?.pois?.length, chunks: g.world?.chunks?.size })));
  await wait(2500);
  await shot('01-spawn');

  await step('walk-forward', async () => {
    const before = await game((g) => g.player.position.toArray());
    await keys('KeyW', 1500);
    const after = await game((g) => g.player.position.toArray());
    const d = Math.hypot(after[0] - before[0], after[2] - before[2]);
    return d > 1 ? { moved: +d.toFixed(2) } : { moved: +d.toFixed(2), ok: false };
  });
  await step('jump', async () => {
    const y0 = await game((g) => g.player.position.y);
    await page.keyboard.down('Space'); await wait(180);
    const y1 = await game((g) => g.player.position.y);
    await page.keyboard.up('Space'); await wait(800);
    return y1 > y0 + 0.2 ? { rise: +(y1 - y0).toFixed(2) } : false;
  });
  await step('camera-modes', async () => {
    const modes = [];
    for (let i = 0; i < 3; i++) { await keys('KeyC', 60); await wait(300); modes.push(await game((g) => g.cameraRig.mode)); await shot('02-cam-' + i); }
    return { modes };
  });

  await step('mine-block', async () => {
    // look straight down and mine the block under the player with the pickaxe (slot 1)
    await keys('Digit1', 50);
    const info = await game((g) => {
      g.cameraRig.pitch = -1.45;
      const p = g.player.position;
      return { below: g.world.getBlock(Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)), pos: [Math.floor(p.x), Math.floor(p.y) - 1, Math.floor(p.z)], sel: g.inventory.getSelected() };
    });
    await page.mouse.move(640, 360);
    await page.mouse.down(); await wait(4000); await page.mouse.up();
    const after = await game((g, pos) => g.world.getBlock(pos[0], pos[1], pos[2]), info.pos);
    await shot('03-mined');
    return after !== info.below ? { before: info.below, after } : false;
  });

  await step('place-block', async () => {
    const r = await game((g) => {
      const inv = g.inventory;
      const idx = inv.slots.findIndex((it, i) => i < 9 && it && it.kind === 'block');
      if (idx < 0) return { err: 'no block in hotbar' };
      inv.select(idx);
      g.cameraRig.pitch = -0.6;
      return { idx, count: inv.slots[idx].count, id: inv.slots[idx].id };
    });
    await page.mouse.down({ button: 'right' }); await wait(150); await page.mouse.up({ button: 'right' });
    await wait(300);
    const c2 = await game((g, idx) => g.inventory.slots[idx] ? g.inventory.slots[idx].count : 0, r.idx);
    await shot('04-placed');
    return c2 < r.count || (await game((g) => g.inventory.creative)) ? { before: r.count, after: c2 } : { before: r.count, after: c2, ok: false };
  });

  await step('spawn-and-enter-car', async () => {
    const r = await game((g) => {
      const p = g.player.position, f = { x: Math.sin(g.cameraRig.yaw), z: Math.cos(g.cameraRig.yaw) };
      const v = g.vehicles.spawn('sports', p.x + f.x * 3, p.y + 0.2, p.z + f.z * 3, g.cameraRig.yaw);
      return v ? { type: v.type, n: g.vehicles.list.length } : null;
    });
    await wait(300);
    await keys('KeyF', 80); await wait(500);
    const inV = await game((g) => !!g.player.inVehicle);
    return inV ? r : false;
  });
  await step('drive', async () => {
    const before = await game((g) => g.player.position.toArray());
    await page.keyboard.down('KeyW'); await wait(3000);
    const speed = await game((g) => g.player.inVehicle ? g.player.inVehicle.speed : null);
    await shot('05-driving');
    await page.keyboard.up('KeyW');
    await keys('KeyA', 600);
    const after = await game((g) => g.player.position.toArray());
    const d = Math.hypot(after[0] - before[0], after[2] - before[2]);
    return d > 5 ? { distance: +d.toFixed(1), speed } : { distance: d, speed, ok: false };
  });
  await step('exit-car', async () => {
    await keys('Space', 1500); // handbrake to stop
    await keys('KeyF', 80); await wait(600);
    return await game((g) => !g.player.inVehicle) || false;
  });

  await step('give-weapons-and-shoot', async () => {
    const r = await game((g) => {
      if (g.debug.giveWeapons) g.debug.giveWeapons(); else g.inventory.addWeapon('rifle', 120);
      const idx = g.inventory.slots.findIndex((it, i) => i < 36 && it && it.kind === 'weapon' && it.id === 'rifle');
      if (idx >= 0 && idx > 8) { const t = g.inventory.slots[8]; g.inventory.slots[8] = g.inventory.slots[idx]; g.inventory.slots[idx] = t; }
      const hb = g.inventory.slots.findIndex((it, i) => i < 9 && it && it.kind === 'weapon' && it.id === 'rifle');
      g.inventory.select(hb);
      g.cameraRig.pitch = 0.05;
      const it = g.inventory.getSelected();
      return { hb, mag: it && it.mag };
    });
    await page.mouse.down(); await wait(900); await page.mouse.up();
    await wait(200);
    await shot('06-shooting');
    const mag2 = await game((g) => g.inventory.getSelected() && g.inventory.getSelected().mag);
    return mag2 < r.mag ? { magBefore: r.mag, magAfter: mag2 } : { magBefore: r.mag, magAfter: mag2, ok: false };
  });

  await step('tnt-explosion', async () => {
    const r = await game((g) => {
      const p = g.player.position;
      const x = Math.floor(p.x + Math.sin(g.cameraRig.yaw) * 10), z = Math.floor(p.z + Math.cos(g.cameraRig.yaw) * 10), y = Math.floor(p.y);
      for (let i = 0; i < 3; i++) g.world.setBlock(x, y + i, z, 27);
      const before = g.world.getBlock(x, y, z);
      g.combat.explode(new p.constructor(x + 0.5, y + 0.5, z + 0.5), { radius: 4, power: 3, damage: 50, source: g.player });
      return { x, y, z, before };
    });
    await wait(150); await shot('07-explosion');
    await wait(4000);
    const after = await game((g, r) => [g.world.getBlock(r.x, r.y, r.z), g.world.getBlock(r.x, r.y + 2, r.z)], r);
    await shot('08-crater');
    return after[0] === 0 ? { after } : { after, ok: false };
  });

  await step('wanted-and-police', async () => {
    await game((g) => g.police.setWanted(2));
    await wait(9000);
    const s = await game((g) => ({ wanted: g.police.wanted, police: g.entities.list.filter((e) => e.isPolice || e.kind === 'cop').length, vehicles: g.vehicles.list.length }));
    await shot('09-police');
    await game((g) => g.police.clearWanted());
    return s.wanted >= 1 ? s : { ...s, ok: false };
  });

  await step('npc-population', async () => {
    const s = await game((g) => ({ peds: g.entities.list.filter((e) => e.kind === 'ped').length, cars: g.vehicles.list.length, traffic: g.traffic.cars ? g.traffic.cars.length : null }));
    return s.peds > 0 && s.cars > 0 ? s : { ...s, ok: false };
  });

  await step('ui-inventory', async () => {
    await keys('KeyE', 60); await wait(400);
    const open = await game((g) => g.isUIOpen('inventory'));
    await shot('10-inventory');
    await keys('KeyE', 60); await wait(300);
    const closed = await game((g) => !g.isUIOpen('inventory'));
    return open && closed ? true : { open, closed, ok: false };
  });
  await step('ui-map', async () => {
    await keys('KeyM', 60); await wait(400);
    const open = await game((g) => g.isUIOpen('map'));
    await shot('11-map');
    await keys('KeyM', 60); await wait(300);
    return open || false;
  });
  await step('ui-pause', async () => {
    await keys('Escape', 60); await wait(400);
    const p = await game((g) => g.paused);
    await shot('12-pause');
    await game((g) => g.setPaused(false));
    return p || false;
  });

  await step('mission-start', async () => {
    const ms = await game((g) => (g.debug.missions ? g.debug.missions() : null));
    const first = Array.isArray(ms) && ms.length ? (ms[0].id || ms[0]) : null;
    const r = await game((g, id) => { if (g.debug.startMission && id) g.debug.startMission(id); return { active: g.missions.active ? (g.missions.active.id || true) : null }; }, first);
    await wait(1500); await shot('13-mission');
    return r.active ? { missions: Array.isArray(ms) ? ms.length : ms, ...r } : { missions: ms, ...r, ok: false };
  });

  await step('night', async () => {
    await game((g) => { if (g.sky.setTime) g.sky.setTime(22.5); else g.sky.time = 22.5; });
    await freezeCam();
    await game((g) => { const s = g.generator.plan.spawn; g.camera.position.set(s.x - 30, 70, s.z - 30); g.camera.lookAt(s.x + 40, 30, s.z + 40); });
    await wait(2500); await shot('14-night-aerial');
    await game((g) => { if (g.sky.setTime) g.sky.setTime(12); else g.sky.time = 12; });
    await wait(2000); await shot('15-day-aerial');
    await thawCam();
    return true;
  });

  await step('death-respawn', async () => {
    await game((g) => g.player.damage(9999, { type: 'fall', source: null }));
    await wait(1200); await shot('16-wasted');
    await wait(6000);
    return await game((g) => ({ alive: g.player.alive, health: g.player.health }));
  });

  const failed = results.filter((r) => !r.ok);
  log(`steps: ${results.length}, failed: ${failed.length}`);
  return results;
};
