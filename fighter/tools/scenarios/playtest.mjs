// Integration play-test for Last Stance. Run inside fighter/:
//   node tools/smoke.mjs --tag int --scenario tools/scenarios/playtest.mjs --size 1280x720 --seconds 1 --keep-going
export default async ({ page, game, keys, wait, shot, log, gameWait, hold }) => {
  const R = [];
  const step = async (name, fn) => {
    try { const r = await fn(); R.push({ step: name, ok: !(r && r.ok === false) && r !== false, info: r === undefined ? null : r }); }
    catch (e) { R.push({ step: name, ok: false, error: String(e && e.message || e).slice(0, 300) }); }
  };
  // event counters
  await game((g) => {
    g.__ev = {};
    for (const n of ['attackStart', 'hit', 'blocked', 'parried', 'avoided', 'absorbed', 'stanceChanged', 'fighterDied', 'roomStarted', 'roomCleared', 'bossIntro', 'dialogue', 'playerAged', 'learnProgress', 'knockdown'])
      g.events.on(n, () => { g.__ev[n] = (g.__ev[n] || 0) + 1; });
  });
  await step('boot', () => game((g) => ({ state: g.state, chapter: g.flow && g.flow.chapterId, player: !!g.player, ui: [...g._ui], debug: Object.keys(g.debug).sort(), rooms: g.world.layout && g.world.layout.rooms.length })));
  await game((g) => { for (const id of [...g._ui]) g.closeUI(id); });
  await gameWait(1);
  await shot('01-start');
  await step('walk-to-room', async () => {
    const p0 = await game((g) => g.player.position.toArray());
    const room = await game((g) => g.world.layout.rooms[0]);
    // walk toward the first room centre (camera-relative forward is fine at start)
    await game((g) => g.input.setVirtualMove(0, 1));
    for (let i = 0; i < 40; i++) {
      await gameWait(0.25);
      const s = await game((g) => ({ ev: g.__ev.roomStarted || 0, fighters: g.combat.fighters.length, ui: [...g._ui] }));
      if (s.ui.length) await game((g) => { for (const id of [...g._ui]) g.closeUI(id); });
      if (s.ev > 0 && s.fighters > 1) break;
    }
    await game((g) => g.input.setVirtualMove(0, 0));
    const p1 = await game((g) => g.player.position.toArray());
    return { moved: +Math.hypot(p1[0] - p0[0], p1[2] - p0[2]).toFixed(1), roomStarted: await game((g) => g.__ev.roomStarted || 0), fighters: await game((g) => g.combat.fighters.length), room: room && room.id };
  });
  await gameWait(1.5);
  await shot('02-room');
  await step('lock-and-chain', async () => {
    await game((g) => { g.debug.god && g.debug.god(true); });
    await hold('lock', 0.05);
    const before = await game((g) => ({ hits: g.__ev.hit || 0, atk: g.__ev.attackStart || 0, stance: g.player.stance, target: !!g.player.target }));
    // close the distance to the target
    for (let i = 0; i < 20; i++) {
      const d = await game((g) => g.player.target ? g.player.position.distanceTo(g.player.target.position) : 99);
      if (d < 1.8) break;
      await game((g) => g.input.setVirtualMove(0, 1)); await gameWait(0.15);
    }
    await game((g) => g.input.setVirtualMove(0, 0));
    const stances = [];
    for (let i = 0; i < 3; i++) { await hold('light', 0.04); await gameWait(0.12); stances.push(await game((g) => g.player.stance + ':' + g.player.state)); if (i === 1) await shot('03-mid-chain'); }
    await gameWait(0.8);
    const after = await game((g) => ({ hits: g.__ev.hit || 0, atk: g.__ev.attackStart || 0, stance: g.player.stance }));
    return { before, after, stances };
  });
  await step('stance-switch-and-alt', async () => {
    await game((g) => g.input.virtualStance('BR')); await gameWait(0.4);
    const st = await game((g) => g.player.stance);
    await hold('heavy', 0.05); await gameWait(0.9);
    return { stance: st, after: await game((g) => g.player.stance), atk: await game((g) => g.__ev.attackStart) };
  });
  await step('fight-30s', async () => {
    // simple autopilot: keep locked, step in, alternate strings, guard sometimes
    for (let i = 0; i < 60; i++) {
      const s = await game((g) => ({ alive: g.combat.enemiesAlive(), d: g.player.target ? g.player.position.distanceTo(g.player.target.position) : 99, t: !!g.player.target, ui: [...g._ui] }));
      if (s.ui.length) await game((g) => { for (const id of [...g._ui]) g.closeUI(id); });
      if (!s.alive) break;
      if (!s.t) await hold('lock', 0.04);
      if (s.d > 1.9) { await game((g) => g.input.setVirtualMove(0, 1)); await gameWait(0.2); await game((g) => g.input.setVirtualMove(0, 0)); }
      else if (i % 5 === 4) { await game((g) => g.input.setVirtual('guard', true)); await gameWait(0.4); await game((g) => g.input.setVirtual('guard', false)); }
      else { await hold(i % 3 === 2 ? 'heavy' : 'light', 0.04); await gameWait(0.22); }
      if (i === 20) await shot('04-fight');
    }
    return await game((g) => ({ ev: g.__ev, enemiesAlive: g.combat.enemiesAlive(), hp: g.player.health, stamina: Math.round(g.player.stamina), focus: Math.round(g.player.focus || 0) }));
  });
  await step('aging', async () => {
    await game((g) => { g.debug.god && g.debug.god(false); g.player.health = 1; });
    // let an enemy finish or force
    await game((g) => { if (g.player.damage) g.player.damage(999, {}); else g.player.health = 0; });
    await gameWait(2.5);
    await shot('05-aging');
    const s = await game((g) => ({ age: g.flow.progress.age, deaths: g.flow.progress.deaths, ui: [...g._ui], aged: g.__ev.playerAged || 0 }));
    for (let i = 0; i < 6; i++) { await hold('confirm', 0.05); await wait(300); }
    await game((g) => { for (const id of [...g._ui]) g.closeUI(id); });
    await gameWait(2);
    return { ...s, aliveAfter: await game((g) => g.player.alive !== false && g.player.health > 0) };
  });
  await step('deck-editor', async () => {
    await game((g) => g.debug.openDeck && g.debug.openDeck()); await wait(1200); await shot('06-deck');
    const open = await game((g) => [...g._ui]);
    await game((g) => { for (const id of [...g._ui]) g.closeUI(id); });
    return { open };
  });
  await step('boss-intro', async () => {
    await game((g) => { g.debug.killAll && g.debug.killAll(); });
    await gameWait(0.5);
    const rooms = await game((g) => g.world.layout.rooms.length);
    await game((g, r) => { g.debug.startRoom && g.debug.startRoom(r - 1); }, rooms);
    await gameWait(2.5); await shot('07-boss-intro');
    const s = await game((g) => ({ ui: [...g._ui], bossIntro: g.__ev.bossIntro || 0, dialogue: g.__ev.dialogue || 0, fighters: g.combat.fighters.map((f) => f.name || f.team) }));
    for (let i = 0; i < 8; i++) { await hold('confirm', 0.05); await wait(300); }
    await gameWait(2); await shot('08-boss-fight');
    return s;
  });
  await step('perf', () => game((g) => ({ ...g.debug.stats(), info: { calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles } })));
  log('failed: ' + R.filter((r) => !r.ok).map((r) => r.step).join(','));
  return R;
};
